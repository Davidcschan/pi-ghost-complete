# pi-ghost-complete

Inline ghost-text completions and next-prompt suggestions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Fork of [pi-ghost-text](https://github.com/jcv/pi-ghost-text) (MIT © Chris Vaughan) with a rendering-compat fix for **pi-tui ≥ 1.0.0** and a UX rework guided by [Carbon for AI](https://www.carbondesignsystem.com/building-blocks/foundations/carbon-for-ai) principles. Plain TypeScript, **zero runtime dependencies, no custom network code** — every model call goes through pi's own model registry and credentials.

```
you type:  fix the login bug and▊
you see:  fix the login bug and▊ ✦ run the tests
                                        ↑ dim blue ghost, Tab accepts
```

## Install

Requires pi ≥ 0.86. Built and tested against pi 1.0.0 / pi-tui 1.0.0.

```bash
pi install git:github.com/Davidcschan/pi-ghost-complete
```

## Interaction model

```
editor empty, agent settled ──▶ ✦ . .. ... ──▶ ✦ ghost text ──▶ Tab/→ accept into editor
        │  (after-turn mode)      pending          (dim blue)      Esc → hard cancel (aborts request)
        │
typing pause ≥ 700ms ──────────▶ same cycle, ghost must extend current draft
        │
typing along the ghost ────────▶ local shrink, ZERO requests
        │  ≤ 2 chars remain ───▶ prefetch continuation (1 request)
        │  fully typed ────────▶ predict next segment (1 request)
```

## Cost model — when requests fire

| Trigger | Request? |
|---|---|
| Typing pause ≥ 700 ms, idle agent, ≥ 4 chars | ✅ |
| Empty editor after the agent settles (`after-turn` mode) | ✅ |
| Typing characters that match the visible ghost | ❌ ghost shrinks locally |
| ≤ 2 characters of the ghost remain | ✅ continuation prefetch |
| Ghost fully typed out | ✅ next-segment prediction |
| Browsing prompt history (↑/↓) | ❌ |
| Agent streaming (not idle) | ❌ |
| `/` command or `@file` completion contexts | ❌ ineligible |
| Per-turn cap (`maxPerTurn`, 0 = unlimited) | guards all of the above |

Typing through a 24-character suggestion costs **1 request** instead of ~24.

## Keys

| Key | Action |
|---|---|
| `Tab` | Cycle candidates (if > 1), else accept — never shadows pi's autocomplete |
| `→` (cursor at end) | Accept into editor; never auto-submits |
| `Esc` | Hard cancel: dismiss ghost **and abort the in-flight request** |

No restore key by design: discarded suggestions come back on the next pause or after deleting to an empty editor. Rejected the macOS-hostile alt-combo options — see fork notes.

## Commands

| Command | Action |
|---|---|
| `/suggest` | Mode: `both` (default) / `while-typing` / `after-turn` / `off` |
| `/suggest-model` | Pick model, or `auto` (prefers `haiku` → `gpt-*mini` → `flash` → `nano` from your enabled models; falls back to the session model — set an explicit cheap model to avoid this) |
| `/suggest-context` | Context window: messages × chars per message |
| `/suggest-info` | Explainability: resolved model, mode, context window, candidate count |

## Configuration

`~/.pi/agent/prompt-suggestions.json` (global), `.pi/prompt-suggestions.json` (project overrides global):

```json
{
  "model": "auto",              // "auto" or "provider/model-id"
  "mode": "both",               // while-typing + after-turn
  "candidates": 1,              // 1..3, Tab cycles; >1 disables streaming
  "streaming": true,            // token-by-token reveal when candidates === 1
  "contextMessages": 8,         // recent messages sent as context (0..50)
  "contextChars": 600,          // chars kept per message
  "maxPerTurn": 0,              // max suggestions per agent turn (0 = unlimited)
  "debug": false                // append to ~/.pi/agent/prompt-suggestions.log
}
```

## Engineering notes

- **pi-tui ≥ 1.0.0 compat** — upstream only skipped the fake-cursor glyph on SGR 27 resets; pi-tui 1.0.0 emits SGR 0, so the ghost never rendered. This fork accepts both and tolerates pi-tui's trailing line padding (upstream's end-of-content guard rejected it).
- **Zero layout shift** — pi renders an extra footer line whenever extension statuses exist; toggling one mid-typing shakes the whole session. The pending indicator renders *inside the editor line's padding* instead (`✦ .` → `..` → `...`, 400 ms/frame), and streaming re-renders are throttled to 80 ms.
- **Ambiguous-width safety** — `✦` (U+2726) renders 2 columns in CJK/ambiguous-wide terminals but 1 elsewhere. The sigil slot is budgeted at 4 columns (1 gap + ✦@2 + 1 gap), and the truncation ellipsis `…` is normalized to ASCII `..`, so the line never silently overruns.
- **Race discipline** — every user-intent transition (Esc, new keystroke, suggestion commit) bumps a request sequence and aborts in-flight work; late results are dropped, never applied over newer state.

## Privacy

Sent to the configured suggestion model: a digest of the last `contextMessages` messages (each trimmed to `contextChars`) plus the current draft. Requests use pi's `modelRegistry.complete()` / `streamSimple` with pi-resolved auth — the extension never reads credentials, builds URLs, or makes its own network calls. No telemetry.

## Changes vs upstream pi-ghost-text 0.1.1

1. Fix ghost never rendering on pi-tui 1.0.0 (cursor reset + padding, above)
2. Footer-status loading removed; inline animated pending dots in the ghost slot
3. Carbon-for-AI styling: blue `✦` transparency sigil, dim blue ghost, fixed gaps
4. Ambiguous-width glyph budgeting; `…` → `..` normalization
5. Streaming render throttle (80 ms)
6. Typing-along suppression + ≤2-char continuation prefetch + fully-typed continuation
7. History browsing fires no requests
8. `Esc` hard-cancels in-flight requests and invalidates late results
9. `→` accept guarded against open autocomplete dropdowns
10. `/suggest-info` explainability command

## License

[MIT](LICENSE) © Chris Vaughan (original pi-ghost-text) · © DavidChan (fork modifications).
