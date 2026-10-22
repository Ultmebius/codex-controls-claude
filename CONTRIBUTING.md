# Contributing

Clone this repository and work from its maintained source. Normal plugin use runs the bundled `server/index.mjs`; editing TypeScript takes effect after rebuilding and reconnecting the plugin.

## Development setup

Use Node.js 22 or newer. Windows tests and native builds use the .NET SDK pinned in `server/source/global.json` (10.0.204) so binary drift checks use the same compiler. POSIX ownership tests need `flock`; run the suite on Ubuntu to cover them. Real Claude Code execution additionally needs the prerequisites in the [README](README.md).

```bash
git clone https://github.com/Ultmebius/codex-controls-claude.git
cd codex-controls-claude/server/source
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The default tests use mocked SDK calls, synthetic data and temporary workspaces. They do not run a model or require Claude credentials. On Windows, `pretest` compiles the native lease helper into the ignored `.test-build/` directory.

## Build and inspect

From `server/source`:

```bash
npm run build:js
```

For the Windows helper and its generated logo, with the .NET 10 SDK installed:

```bash
npm run build:native
npm run test:native
```

`npm run build` performs both builds. The JavaScript bundle is written to `server/index.mjs`; native outputs go to `server/native/`. The native build regenerates the cached animation from the manifest's packaged logo before compiling. Build-only PNG/SIXEL dependencies are pinned alongside the other development dependencies.

Review the rebuilt files together with their source. `npm run build:js` regenerates the bundled JavaScript, and on Windows `npm run build:native` also rebuilds the native helper and generated graphic data; both rebuilds are checked against the tracked files for drift. Changes to the bundled source must include the corresponding artifacts.

The lockfile includes transitive runtime dependencies, not just top-level versions. Native builds use the pinned SDK and omit checkout-specific Git revision stamping, so a different clone can reproduce the committed DLL.

## Source and tests

`server/source/src/` contains the plugin and the shared Claude Code engine. The extra engine sources support the regression suite; the published MCP entry is still `src/plugin-entry.ts`, exposing the ten orchestration tools. Keep changes focused on the requested behavior and preserve native permissions, hooks, configured models and ownership boundaries.

Tests live in `server/source/tests/`. Package contracts and cold MCP discovery live in `server/source/package-tests/`. Add a regression when behavior changes, using a fixed observable outcome rather than asserting implementation details. [Testing](docs/testing.md) explains the layers and optional real-model/desktop acceptance.

When changing dependencies, update `server/source/package.json` and its lockfile together, then run `npm ci` and the checks above. Dependency and manifest versions must agree with the release. Runtime dependencies are bundled; a normal user does not run `npm install` to use the plugin.

## Runtime export

From `server/source`, export a clean installable directory:

```bash
npm run package:runtime -- ../../artifacts/runtime
```

The destination must be empty. The exporter uses an explicit runtime file list: manifests, marketplace, skills, user documentation, assets, launch scripts and built server/native files. Development source, tests, `node_modules`, CI and test output are excluded. A Git marketplace install still uses the repository's tracked files; no ignore file is assumed to filter the Codex cache.

The public repository remains the development source for an exported runtime. Rebuilding or running the test suite requires the repository checkout, not the smaller export.

## Submitting a change

Describe the concrete problem, resulting behavior and checks performed. Include a focused regression or explain which existing tests cover the change. Label skipped real-model or real-desktop acceptance explicitly. Use synthetic fixtures; keep personal transcripts, runtime state, credentials and machine-specific paths out of commits. Record user-visible changes in [CHANGELOG.md](CHANGELOG.md).

The license text in [LICENSE](LICENSE) records both this project's copyright and the upstream MIT provenance; bundled dependency licenses are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
