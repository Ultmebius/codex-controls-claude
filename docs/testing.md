# Testing and acceptance

The public checkout contains the maintained plugin/shared-engine source and its regression tests. Start with [CONTRIBUTING.md](../CONTRIBUTING.md). Default automated checks use synthetic inputs and mocked SDK queries; they do not start a paid model, import an account or require credentials.

## Deterministic checks

From `server/source`:

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The TypeScript suite covers task dependencies and acceptance, rework, event waits, guidance, budgets, recovery, ownership, worker slots, native permission forwarding, streaming and the shared engine. The shared engine includes entry points used by regression tests; the installed plugin still exposes only its ten orchestration tools.

On Windows, `pretest` builds a native lease helper from the checked-out C# sources into `.test-build/`. Install the SDK version pinned in `server/source/global.json`. Ubuntu uses `flock` for process-lock tests. These tests do not open worker terminals.

Node contract tests cover manifest/catalog identity, contained icons and skills, MCP launch settings, an explicit runtime export, documentation links and cold discovery of the bundled server's ten tools. The event-wait tests prove cursor continuation, cancellation and terminal/error handling.

Run only those Node tests with:

```bash
npm run test:contracts
```

## Native deterministic checks

On Windows with the .NET 10 SDK:

```bash
npm run test:native
```

This compiles the native helper and runs `--self-test`. It covers usage reconciliation, streaming/redaction, layout and interaction logic and ownership predicates without a real terminal window. It prints the native and dashboard assertion counts. On other platforms the command explicitly reports a skip.

## Build and artifact consistency

```bash
npm run build:js
```

The Windows/native build also regenerates and decodes all cached logo frames before compiling:

```bash
npm run build:native
```

After a release build, from the repository root:

```bash
git diff --exit-code -- server/index.mjs server/native server/source/native/TerminalHost/LogoSixelData.g.cs
```

Run the deterministic checks on both Ubuntu/Node 22 and Windows/Node 24 before a release. Both runs rebuild and check the bundled JavaScript; Windows additionally runs the native self-tests and checks the DLL and generated logo for drift. No model credentials are involved.

The runtime exporter is tested against an explicit list of files. It omits development source, tests, dependencies and test output. A Git marketplace installation includes tracked repository files; the exporter, rather than an assumed ignore mechanism, defines the smaller standalone release.

## Optional real-model and desktop acceptance

These checks need an intentionally configured local Claude Code environment and a real desktop. Run them separately from ordinary PR checks:

1. Use a disposable project and an isolated plugin state directory.
2. Ask Codex Controls Claude to create two dependency-linked synthetic tasks with fixed executable checks.
3. Confirm that a dependent task cannot start before upstream acceptance.
4. Make the first candidate deliberately fail a fixed check, verify rejection, request rework, then accept the corrected result and run the downstream task.
5. Include a supervisor question and inspect its actual answer and the resulting file effect. For guidance changes, also exercise FIFO queue and deliberate interruption in the same saved conversation.
6. On Windows, inspect the actual worker's dashboard: startup minimization, model/permission metadata, streamed output, cumulative token counters and the selected logo.
7. Close only the fixture's owned sessions/windows and retain a sanitized summary with checks, exit codes and artifact hashes.

Configuration health, a headless test and a demo screenshot each prove different facts. Record actual inference and real desktop results separately, and label skipped layers. The README image is a synthetic demo capture; it is not evidence of a model invocation.

Keep personal transcripts, credentials and runtime ledgers out of fixtures and commits. Published examples should use synthetic data and portable paths. Ordinary native permission prompts remain governed by Claude Code's own configuration.
