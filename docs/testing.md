# Development, testing and acceptance

The public checkout contains the maintained plugin/shared-engine source and its regression tests. Default automated checks use synthetic inputs and mocked SDK queries; they do not start a paid model, import an account or require credentials.

## Development setup

Use Node.js 22 or newer. Tests and native builds use the .NET SDK pinned in `server/source/global.json` (10.0.204). Real Claude Code execution also needs the prerequisites in the [README](../README.md#requirements).

```bash
git clone https://github.com/Ultmebius/codex-controls-claude.git
cd codex-controls-claude/server/source
```

The maintained TypeScript source lives in `server/source/src/`, with `src/plugin-entry.ts` exposing the plugin's ten orchestration tools. Ordinary plugin use runs the bundled `server/index.mjs`; TypeScript changes take effect after rebuilding and reconnecting the plugin. Regression tests live in `server/source/tests/`, and package contracts live in `server/source/package-tests/`.

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

`pretest` builds a native lease helper from the checked-out C# sources into `.test-build/`. Install the SDK version pinned in `server/source/global.json`. These tests do not open worker terminals.

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

`npm run build` performs both builds. JavaScript is written to `server/index.mjs`; native outputs go to `server/native/`. Source changes must include the corresponding rebuilt artifacts. Native builds use the pinned SDK and omit checkout-specific Git revision stamping so another clone can reproduce the committed DLL.

When changing dependencies, update `server/source/package.json` and its lockfile together, then run `npm ci` and the checks above. Package and manifest versions must agree. Runtime dependencies are bundled, so ordinary plugin users do not run `npm install`.

After a release build, from the repository root:

```bash
git diff --exit-code -- server/index.mjs server/native server/source/native/TerminalHost/LogoSixelData.g.cs
```

Before a release, run the deterministic checks, rebuild and check the bundled JavaScript, run the native self-tests, and check the DLL and generated logo for drift. No model credentials are involved.

## Runtime export

From `server/source`, export a clean installable directory:

```bash
npm run package:runtime -- ../../artifacts/runtime
```

The destination must be empty. The exporter uses an explicit file list containing manifests, marketplace metadata, skills, documentation, assets, launch scripts and built server/native files. It omits development source, tests, dependencies, CI and test output. A Git marketplace installation includes tracked repository files; the exporter defines the smaller standalone release. Rebuilding or running the regression suite requires the public repository checkout.

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
