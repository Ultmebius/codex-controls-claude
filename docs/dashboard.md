# Windows worker dashboard

The [README](../README.md#worker-dashboard) shows the public default logo in a demonstration capture. Each actual Windows worker runs in its own Windows Terminal with a compiled C#/.NET host. Rendering uses its native event stream without extra model calls or supervisor polling. Other supported execution paths use stdio.

## Header and activity

The header displays the reported runtime model, permission mode, effort, tool count, elapsed time, activity, cumulative tokens and conversation information. Effort can be configured until authoritative native metadata is reported. Conversation selectors appear when the terminal actually has multiple native conversation IDs.

The pixel logo uses 60 cached palette phases at about 30 fps and pauses while minimized. SIXEL-capable terminals render the image; the half-block fallback preserves its silhouette without SIXEL. Narrow layouts drop the logo before essential model/permission metadata. CJK display widths are accounted for.

Assistant text grows an OUTPUT entry while streaming and reconciles with the completed message. Terminal Markdown supports headings, lists, block quotes, bold, inline code, fenced code and pipe tables. Tables align and wrap cells, with a literal source fallback when needed. TASK and TOOL text are stored whole and wrapped across the available body width.

## Reading, selecting and copying

| Control | Behavior |
|---|---|
| Mouse wheel or PageUp/PageDown | Scroll the reading viewport |
| End or scroll to bottom | Resume following new output |
| Thin scrollbar | Drag through the scroll range |
| Middle click | Toggle auto-browse; pointer direction and distance control motion |
| Left drag | Select text; dragging past the edge continues scrolling and selection |
| Right click | Copy selected cells, rejoining soft wraps and preserving code indentation and CJK characters |

New output does not move a viewport pinned to older content. Selection takes precedence over auto-browse. A successful copy clears the highlight; failed clipboard writes preserve it for retry. Escape and Ctrl+C keep native meanings.

## Token accounting

`TOKENS in … out …` is cumulative for the native conversation, including tool rounds, follow-up turns and restored usage. Input includes reported cache-related input. Message identities deduplicate repeated deliveries, and final result corrections may adjust estimates in either direction.

- `~` means the displayed figure is partly estimated.
- `—` means the runtime has not reported the counter.
- A reported zero is distinct from an unknown value.

These counters are not the persistent turn allowance, and provider cost fields are client estimates rather than a billing statement.

## Display sanitization

Names, metadata, arguments, headings and body text are sanitized before fitting them to the screen. Possible credentials split across streaming deltas are held for redaction; an overlong unresolved secret emits `[redacted]` and defers the remainder to the completed message. Thinking blocks and successful empty tool receipts stay out of the dashboard. Claude Code's native transcript storage remains separate from this rendered view.

## Window lifecycle

Startup creates the terminal minimized, paints the first real frame behind the foreground application without activating it, then minimizes it once so its taskbar preview contains the dashboard. User restoration during startup is respected; the plugin does not repeatedly minimize a restored window.

Cleanup checks the private ownership identity, HWND and PID. Captions can change under Claude Code without losing the ownership record. Closing one owned dashboard stops its worker while preserving peers. Real-screen checks must use their own identifiable window and close only that owned window; see [testing](testing.md#optional-real-model-and-desktop-acceptance).
