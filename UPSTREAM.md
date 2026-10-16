# Source provenance

Execution/session functionality derives from xihuai18/claude-code-mcp, MIT, commit `47aa47b4f7f02f5dd5c6bc9174d30a42f54484f2` (2.8.3):
https://github.com/xihuai18/claude-code-mcp/tree/47aa47b4f7f02f5dd5c6bc9174d30a42f54484f2

This plugin retains the Claude Agent SDK query consumer, session lifecycle, executable selection, permission handling and normalization helpers. Additions implement the Codex task ledger, event subscriptions, independent acceptance gate, local process ownership and plugin packaging.

ACP/acpx structured events, CCB delivery receipts, Agent Mail correlation and claude-uds-bridge delivery semantics informed the design. Their runtimes are not required by this package.
