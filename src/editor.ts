/**
 * The ghost-text editor component.
 *
 * Extends pi's CustomEditor and renders suggestions as dim ghost text after
 * the cursor. Owns debounce, in-flight cancellation, streaming, multi-candidate
 * cycling, and a per-turn cost guard.
 *
 * @module
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Config } from "./config.ts";
import { afterTurnEnabled, whileTypingEnabled } from "./mode.ts";
import { resolveSuggestionModel } from "./model-selection.ts";
import { buildUserMessage, type ContextWindow } from "./context.ts";
import {
	classifyResponse,
	GENERATION_TIMEOUT_MS,
	MAX_TOKENS,
	SYSTEM_PROMPT,
	TEMPERATURE,
	systemPromptFor,
} from "./client.ts";
import { extractSuggestion, fitSuggestionToWidth, isEligible, parseCandidates } from "./normalize.ts";
import { debug } from "./debug.ts";

const DEBOUNCE_MS = 700;
/** Animated pending hint: progressive dots in the ghost slot while in flight. */
const PENDING_FRAME_MS = 400;
/** Carbon-for-AI-style transparency sigil: marks AI-suggested text consistently. */
const AI_SIGIL = "✦";
/** Carbon-for-AI blue (256-color ≈ #78a9ff): marks AI-suggested content. */
const AI_BLUE = "\x1b[38;5;111m";
/** Minimum interval between streaming ghost re-renders (anti-flicker). */
const STREAM_RENDER_INTERVAL_MS = 80;
/**
 * Typing-along suppression: while the typed text still matches the visible
 * suggestion, no re-query fires (the ghost just shrinks — free and flicker-
 * free). When ≤ this many characters remain, the continuation is prefetched
 * so a fresh ghost is ready by the time the user finishes typing it out.
 */
const CONTINUE_THRESHOLD_CHARS = 2;

export class SuggestingEditor extends CustomEditor {
	private ghost: string | null = null; // visible remainder shown dimmed
	private pending = false; // request in flight: show dim hint in the ghost slot
	private pendingFrame = 0; // 0..2 → ".", "..", "..."
	private pendingTimer: ReturnType<typeof setInterval> | undefined;
	private lastStreamRenderTs = 0; // throttles streaming ghost re-renders
	private suggestionFull: string | null = null; // currently shown full suggestion
	private candidates: string[] = []; // all fetched candidates
	private candidateIndex = 0; // which candidate is shown
	private baseText = ""; // editor text the suggestion was generated for
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private abort: AbortController | undefined;
	private requestSeq = 0;
	private hintShown = false;
	private shownThisTurn = 0; // cost/energy guard counter
	private dim: (s: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
		private readonly getConfig: () => Config,
	) {
		super(tui, theme, keybindings);
		this.dim = (s: string) => ctx.ui.theme.fg("dim", s);
	}

	dispose(): void {
		clearTimeout(this.debounceTimer);
		this.abort?.abort();
		this.clearGhost();
	}

	/** Agent has settled: reset the per-turn guard and offer a next prompt. */
	onAgentSettled(): void {
		this.shownThisTurn = 0;
		this.suggestIfEmpty();
	}

	suggestIfEmpty(): void {
		if (!afterTurnEnabled(this.getConfig().mode)) return;
		if (this.getText().trim().length !== 0) return;
		void this.requestSuggestion(true);
	}

	clearGhost(): void {
		if (this.ghost === null && this.suggestionFull === null && !this.pending) return;
		this.pending = false;
		this.stopPendingAnimation();
		this.ghost = null;
		this.suggestionFull = null;
		this.candidates = [];
		this.candidateIndex = 0;
		this.tui.requestRender();
	}

	private cursorAtEnd(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return (
			cursor.line === lines.length - 1 && cursor.col >= (lines[lines.length - 1] ?? "").length
		);
	}

	private contextOpts(): ContextWindow {
		const c = this.getConfig();
		return { messages: c.contextMessages, chars: c.contextChars };
	}

	private acceptSuggestion(): void {
		if (!this.suggestionFull) return;
		if (this.baseText) {
			this.insertTextAtCursor(this.suggestionFull.slice(this.baseText.length));
		} else {
			this.setText(this.suggestionFull);
		}
		this.requestSeq++; // ignore any in-flight result
		this.abort?.abort();
		this.clearGhost();
	}

	/** Tab: cycle to the next candidate, else accept. Right arrow accepts directly. */
	private cycleOrAccept(): void {
		if (this.candidates.length > 1) {
			const now = this.getText();
			for (let i = this.candidateIndex + 1; i < this.candidates.length; i++) {
				const candidate = this.candidates[i]!;
				if (!now || candidate.startsWith(now)) {
					this.candidateIndex = i;
					this.baseText = now;
					this.suggestionFull = candidate;
					this.ghost = candidate.slice(now.length);
					this.tui.requestRender();
					return;
				}
			}
		}
		this.acceptSuggestion();
	}

	override handleInput(data: string): void {
		// Esc is a hard cancel: dismiss the visible ghost AND abort any
		// in-flight request, so nothing pops in after the dismissal.
		if (
			matchesKey(data, Key.escape) &&
			!this.isShowingAutocomplete() &&
			(this.ghost || this.pending)
		) {
			this.requestSeq++; // invalidate the in-flight result
			this.abort?.abort();
			this.clearGhost();
			return;
		}

		if (this.ghost) {
			if (matchesKey(data, Key.tab) && !this.isShowingAutocomplete()) {
				this.cycleOrAccept();
				return;
			}
			if (matchesKey(data, Key.right) && this.cursorAtEnd() && !this.isShowingAutocomplete()) {
				this.acceptSuggestion();
				return;
			}
		}

		// Up/down can browse prompt history, replacing the whole text — that is
		// viewing, not composing, so no suggestion request may be spent on it.
		const viaHistoryNav = matchesKey(data, Key.up) || matchesKey(data, Key.down);
		const before = this.getText();
		super.handleInput(data);
		const after = this.getText();

		if (after !== before) {
			this.onTextChanged(after, viaHistoryNav);
		} else if (this.ghost && !this.cursorAtEnd()) {
			this.clearGhost();
		}
	}

	/** Cycle "." → ".." → "..." every PENDING_FRAME_MS while a request is in flight. */
	private startPendingAnimation(): void {
		this.stopPendingAnimation();
		this.pendingFrame = 0;
		this.pendingTimer = setInterval(() => {
			this.pendingFrame = (this.pendingFrame + 1) % 3;
			if (this.pending) this.tui.requestRender();
		}, PENDING_FRAME_MS);
	}

	private stopPendingAnimation(): void {
		if (this.pendingTimer !== undefined) {
			clearInterval(this.pendingTimer);
			this.pendingTimer = undefined;
		}
	}

	private onTextChanged(text: string, viaHistoryNav = false): void {
		// History browsing replaced the text wholesale: clear quietly, no request.
		if (viaHistoryNav) {
			this.clearGhost();
			return;
		}
		// Typing along the suggestion: the typed text still prefixes it, so the
		// ghost shrinks locally — no request, no cost, no visual replacement.
		if (
			this.suggestionFull &&
			this.baseText &&
			text.startsWith(this.baseText) &&
			this.suggestionFull.startsWith(text)
		) {
			const remaining = this.suggestionFull.slice(text.length);
			this.baseText = text;
			this.ghost = remaining;
			if (!remaining.trim()) {
				// Fully typed out: predict what comes next (fresh request).
				this.clearGhost();
				this.schedule();
				return;
			}
			this.tui.requestRender();
			// Suppress re-queries while the user is confidently typing the
			// suggestion. Near the end (≤ threshold chars left), prefetch the
			// continuation so the ghost extends seamlessly as they finish.
			if (remaining.length <= CONTINUE_THRESHOLD_CHARS) this.schedule();
			return;
		}
		this.clearGhost();
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.debounceTimer);
		this.abort?.abort(); // in-flight result is for stale text
		this.debounceTimer = setTimeout(() => void this.requestSuggestion(false), DEBOUNCE_MS);
	}

	private async requestSuggestion(allowEmpty: boolean): Promise<void> {
		const config = this.getConfig();
		if (allowEmpty ? !afterTurnEnabled(config.mode) : !whileTypingEnabled(config.mode)) return;
		if (!this.ctx.isIdle()) return; // skip while the agent is streaming
		if (config.maxPerTurn > 0 && this.shownThisTurn >= config.maxPerTurn) return;

		const text = this.getText();
		if (!isEligible(text, allowEmpty)) return;

		const model = resolveSuggestionModel(this.ctx, config.model);
		if (!model) return;

		const seq = ++this.requestSeq;
		const ac = new AbortController();
		this.abort = ac;
		// Loading cue is inline in the ghost slot. setStatus() would add/remove a
		// footer line mid-typing and shift the whole session layout.
		this.pending = true;
		this.startPendingAnimation();
		this.tui.requestRender();

		try {
			const suggestions = await this.generateSuggestions(model, text, ac.signal, config);
			if (seq !== this.requestSeq || ac.signal.aborted) return;
			this.commitSuggestions(suggestions, text);
		} catch (err) {
			if (seq !== this.requestSeq || ac.signal.aborted) return;
			const message = err instanceof Error ? err.message : String(err);
			const isTimeout = /timeout|timed ?out/i.test(message);
			debug(isTimeout ? "timeout" : "error", message);
			this.clearGhost();
		} finally {
			if (seq === this.requestSeq) {
				this.pending = false;
				this.stopPendingAnimation();
				this.tui.requestRender();
			}
		}
	}

	// ── Generation ────────────────────────────────────────────────────────

	private async generateSuggestions(
		model: Model<any>,
		text: string,
		signal: AbortSignal,
		config: Config,
	): Promise<string[]> {
		if (config.candidates === 1 && config.streaming) {
			try {
				return [await this.streamSingle(model, text, signal)];
			} catch (err) {
				if (signal.aborted) throw err; // interrupted by a newer keystroke, not a stream failure
				const message = err instanceof Error ? err.message : String(err);
				debug("error", `streaming failed, falling back to complete: ${message}`);
				this.clearGhost();
				return this.completeCandidates(model, text, signal, 1);
			}
		}
		return this.completeCandidates(model, text, signal, config.candidates);
	}

	private async streamSingle(model: Model<any>, text: string, signal: AbortSignal): Promise<string> {
		const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);

		const stream = streamSimple(model, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [buildUserMessage(this.ctx, text, this.contextOpts())],
		}, {
			apiKey: auth.apiKey ?? "",
			headers: auth.headers,
			env: auth.env,
			signal,
			maxTokens: MAX_TOKENS,
			temperature: TEMPERATURE,
			timeoutMs: GENERATION_TIMEOUT_MS,
		});

		let acc = "";
		for await (const event of stream) {
			if (signal.aborted) throw new Error("aborted");
			if (event.type === "text_delta") {
				acc += event.delta;
				this.updateStreamingGhost(acc, text);
			} else if (event.type === "text_end") {
				acc = event.content;
			} else if (event.type === "error") {
				throw new Error(event.error?.errorMessage ?? event.reason ?? "stream error");
			}
		}
		return acc;
	}

	private async completeCandidates(
		model: Model<any>,
		text: string,
		signal: AbortSignal,
		count: number,
	): Promise<string[]> {
		const response = await this.ctx.modelRegistry.complete(model, {
			systemPrompt: systemPromptFor(count),
			messages: [buildUserMessage(this.ctx, text, this.contextOpts())],
		}, {
			signal,
			maxTokens: MAX_TOKENS * count,
			temperature: TEMPERATURE,
			timeoutMs: GENERATION_TIMEOUT_MS,
		});

		const classified = classifyResponse(response);
		if (!classified.ok) {
			debug(classified.reason === "error" ? "error" : "no-suggestion", classified.message);
			return [];
		}
		return parseCandidates(classified.text, count);
	}

	/** Show the accumulated text as a partial ghost while streaming. */
	private updateStreamingGhost(acc: string, baseText: string): void {
		if (this.getText() !== baseText) return; // user typed more; ignore this stream
		if (!acc.startsWith(baseText)) return; // model deviated; wait for final validation
		const remainder = acc.slice(baseText.length);
		if (!remainder) return;
		this.baseText = baseText;
		this.suggestionFull = acc;
		this.ghost = remainder;
		this.pending = false;
		this.stopPendingAnimation();
		// Throttle re-renders: token deltas can arrive faster than a frame.
		const now = Date.now();
		if (now - this.lastStreamRenderTs >= STREAM_RENDER_INTERVAL_MS) {
			this.lastStreamRenderTs = now;
			this.tui.requestRender();
		}
	}

	// ── Commit ────────────────────────────────────────────────────────────

	private commitSuggestions(raw: string[], text: string): void {
		const now = this.getText();
		const candidates: string[] = [];
		for (const rawCandidate of raw) {
			const suggestion = extractSuggestion(rawCandidate, text);
			if (!suggestion) continue;
			if (now !== text) {
				// The user typed more while the request was in flight.
				if (!now || !suggestion.startsWith(now) || suggestion.length <= now.length) continue;
			}
			if (!candidates.includes(suggestion)) candidates.push(suggestion);
		}

		if (candidates.length === 0) {
			debug("no-suggestion");
			this.clearGhost();
			return;
		}

		const baseText = now !== text ? now : text;
		this.candidates = candidates;
		this.candidateIndex = 0;
		this.baseText = baseText;
		this.suggestionFull = candidates[0]!;
		this.ghost = candidates[0]!.slice(baseText.length);

		if (!this.ghost || !this.cursorAtEnd()) {
			this.clearGhost();
			return;
		}

		this.shownThisTurn++;
		if (!this.hintShown) {
			this.hintShown = true;
			this.ctx.ui.notify(
				"✦ AI suggestion · Tab/→ accept · Esc dismiss · /suggest-info",
				"info",
			);
		}
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const ghostText = this.ghost ?? (this.pending ? ".".repeat(1 + this.pendingFrame) : null);
		if (ghostText === null) return lines;

		// The focused editor emits CURSOR_MARKER right before the fake cursor.
		// Inserting the ghost after the cursor keeps this independent of the
		// editor's internal wrap/scroll layout.
		const idx = lines.findIndex((l) => l.includes(CURSOR_MARKER));
		if (idx === -1) return lines;

		const line = lines[idx]!;
		const markerPos = line.indexOf(CURSOR_MARKER);
		let pos = markerPos + CURSOR_MARKER.length;

		// Skip over the inverse-video cursor glyph that follows the marker.
		// pi-tui >= 1.0 resets the cursor with SGR 0 (\x1b[0m); older builds
		// used SGR 27 (\x1b[27m). Accept both so the glyph is actually skipped.
		const rest = line.slice(pos);
		if (rest.startsWith("\x1b[7m")) {
			const end = rest.search(/\x1b\[(?:0|27)m/);
			if (end !== -1) {
				const reset = rest.slice(end).match(/^\x1b\[(?:0|27)m/)![0]!;
				pos += end + reset.length;
			}
		}

		const before = line.slice(0, pos);
		const after = line.slice(pos);
		// Only ghost at end of content. Trailing padding spaces are fine — the
		// ghost overwrites padding below — so reject only real visible content.
		if (visibleWidth(after.replace(/\s+$/, "")) > 0) return lines;

		// Transparency sigil (Carbon-for-AI style): consistently marks the span
		// as AI-suggested, not typed. Carbon AI blue, fixed width, static.
		// Layout: 1 space + ✦ + 1 space — a guaranteed 1-column gap on both
		// sides. Budgeted at 4 columns: ✦ is an East-Asian "ambiguous" glyph
		// that renders 2 cols wide in CJK/ambiguous terminals while
		// visibleWidth counts it as 1; budget the wider case to stay safe.
		const sigil = `${AI_BLUE} ${AI_SIGIL} \x1b[39m`;
		const sigilWidth = 4;
		const room = width - visibleWidth(before) - 1 - sigilWidth;
		if (room < 6) return lines;

		// Avoid ambiguous-width glyphs in the suggestion body: the truncation
		// ellipsis "…" renders 2 cols in CJK terminals but counts as 1 here,
		// which silently eats the trailing padding. ASCII ".." is exact.
		const shown = fitSuggestionToWidth(
			ghostText.replace(/\s+/g, " ").replace(/…/g, ".."),
			room,
			visibleWidth,
		);

		// Replace an equal amount of trailing padding so the line stays within width.
		const shownWidth = visibleWidth(shown);
		const ghostStyled = `${AI_BLUE}\x1b[2m${shown}\x1b[22;39m`;
		lines[idx] = before + sigil + ghostStyled + after.slice(sigilWidth + shownWidth);
		return lines;
	}
}
