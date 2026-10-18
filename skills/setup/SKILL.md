---
name: setup
description: "Use only when the user invokes Codex Controls Claude setup or requests diagnosis of this plugin. Check its local MCP, Claude executable, configured model and installed tools."
---

# Setup

Run `orchestrator_doctor`. It checks Node, local Claude Code and the configured model without printing credentials or invoking a model. Gateway model listing is optional; unsupported listing does not prove inference failure. `healthy` reports local configuration only; verify real inference separately.

If tools are not yet visible, use the packaged `scripts/doctor.mjs` with Node. Verify the installed plugin is enabled and its MCP launch succeeds. Retry tool discovery briefly before reporting that the current chat needs refresh; do not recreate the plugin or claim success from installation alone.

Prerequisites: Node 22 or newer, a locally installed Claude Code executable, Git Bash and Windows Terminal (`wt.exe`) and .NET 10 runtime on native Windows, and existing authorized Claude Code authentication or gateway settings. `CCC_CLAUDE_PATH` can select an explicit installed Claude executable. The worker reads `env.ANTHROPIC_MODEL` in `~/.claude/settings.json` first and preserves the exact model value; it does not modify your settings file. Without an explicit model, Claude Code uses its native default.

Use a disposable project for a live test. Invoke the `orchestrate` skill, create two dependency-linked tasks with distinct human `workerName` values, verify each terminal tab starts with its own name (for example `UI 修复 · CCC 1234abcd`), verify a failing acceptance check is rejected, request rework, then accept and unlock the downstream task. Inspect actual files and model metadata. A doctor response alone never certifies this chain.

Worker tools come from Claude's native built-ins and enabled MCP config, independently of Codex's tool list. Inspect sanitized receipt capabilities or status sections=["capabilities"], without printing MCP env, headers or configuration bodies. Disabled/pending/auth-needed differs from connected. Default budgets are200 native rounds/segment,1000 SDK-reported turns/run and2h execution deadlines; acceptance repairs default2. Use a tiny limit for budget tests, then explicit continue/reconcile. Do not count budget continuation as failed acceptance.
