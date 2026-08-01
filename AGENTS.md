# Repository Guidelines

## Project Overview

**ext-sourcemap** (`Source Map Extractor`) is a Chrome Manifest V3 DevTools
extension. It adds a **"Source Maps"** panel to Chrome DevTools that:

1. Scans every resource of the inspected page for source-map annotations.
2. Recovers the original, pre-build source files (from `sourcesContent`,
   inline `data:` URLs, or by fetching them over HTTP).
3. Lets the user download the recovered sources as a ZIP.

The project is early-stage (`version: 0.1.0`, `private: true`, no
LICENSE/README, no commit history yet) but the implementation itself is
complete and tested — treat the source as the primary spec, there is no
external design doc.

## Architecture & Data Flow

Two independent DevTools pages, wired by Vite as two HTML entry points, plus
one shared, framework-free logic module:

```
devtools.html ──▶ devtools.ts ──▶ chrome.devtools.panels.create("Source Maps", …, "panel.html")
                                                │
                                                ▼
panel.html ──▶ panel.ts ──▶ sourcemap.ts (scanInspectedPage / saveRecoveredSourcesZip)
```

- `src/devtools.ts` (3 lines) only registers the panel — it never touches
  `sourcemap.ts`.
- `src/panel.ts` is the **only** consumer of `src/sourcemap.ts`. There is
  **no `chrome.runtime` message passing** between contexts; the panel calls
  the library directly via ES imports (Vite bundles each HTML entry
  separately).

**Scan pipeline** (`scanInspectedPage`, `src/sourcemap.ts:350`):

1. `getInspectedResources()` (`:47`) — enumerate all resources of the
   inspected page via `chrome.devtools.inspectedWindow.getResources`.
2. `readResourceText()` (`:59`) — read each resource's text, decoding base64
   when the DevTools API reports it.
3. `classifyGeneratedKind()` (`:298`) — decide JS vs CSS.
4. `extractSourceMappingUrl()` (`:94`) — regex-match the trailing
   `//# sourceMappingURL=` (JS) or `/*# sourceMappingURL=… */` (CSS) comment.
5. Resolve the map URL and load its text — already-read resource text,
   `decodeDataUrlText()` (`:116`) for inline maps, or a `fetch()` fallback
   (`defaultFetchText`, `:317`).
6. `recoverSourcesFromMap()` (`:199`) — parse the map JSON, walk
   `sources`/`sourcesContent`, recurse into index maps (`sections`), and
   dedupe colliding output paths via `reservePath()`/`withSuffix()`
   (`:171`, `:162`; same content silently merges, different content gets a
   `__2`, `__3`, … suffix).
7. Resources that are themselves a `.map` file not referenced by any
   generated file are still recovered as "direct maps"
   (`isDirectMapResource`, `:307`).
8. Results aggregate into a `ScanResult { maps: RecoveredMap[], files:
   RecoveredFile[] }`.

**Output**: `panel.ts` renders `ScanResult` into a table + log
(`renderResult`, `panel.ts:22`). `saveRecoveredSourcesZip()`
(`sourcemap.ts:493`) zips the recovered files plus a
`source-map-report.json` via `fflate.zipSync`, then downloads it through
`chrome.downloads.download()` with a `data:` URL, falling back to a DOM `<a>`
click when the downloads API is unavailable.

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | Vite build root — all TypeScript/HTML/CSS source, plus the colocated test file. |
| `src/public/` | Static files copied verbatim into the build output (currently just `manifest.json`) — Vite's default `publicDir` under `root: "src"` (unset in `vite.config.ts`); there is no top-level `public/`. |
| `extension/` | **Generated** by `pnpm dev` (`dev.ts`) — contains only `devtools.html`/`panel.html` + `manifest.json` (relaxed dev CSP), no bundled JS/CSS. Assets are served live from the Vite dev server for HMR. Never edit by hand. |
| `fixtures/sourcemap-page/` | A static "page under inspection" (minified JS/CSS with real accompanying `.map` files) for manually exercising the panel in a real browser. **Not** wired into the Vitest suite. |

## Development Commands

```bash
pnpm install         # install deps (pnpm is required, see below)

pnpm dev             # tsx dev.ts: starts a Vite dev server (HMR), then writes
                      #   extension/{devtools,panel}.html (with `%BASE_URL%`
                      #   rewritten to the dev server origin) and a dev
                      #   extension/manifest.json (relaxed CSP allowing that
                      #   origin). No `vite build` involved. Keep it running;
                      #   use with `pnpm ext:run`.
pnpm build           # vite build (production): src/ -> dist/
pnpm test            # vitest run (single pass, no watch script defined;
                      #   use `pnpm exec vitest` for watch mode)

pnpm ext:run         # web-ext run --source-dir extension --target chromium
                      #   launches Chromium with the unpacked dev extension
                      #   loaded. Run `pnpm dev` first (or keep it running) —
                      #   this script does not build.

pnpm ext:build       # vite build && web-ext build --source-dir dist \
                      #   --artifacts-dir web-ext-artifacts --overwrite-dest
                      #   -> a shippable web-ext-artifacts/*.zip
```

Manual/e2e check: after `pnpm dev` (leave it running) and `pnpm ext:run`, open
`fixtures/sourcemap-page/index.html` as the inspected page, open the
**Source Maps** panel, click **Scan page** then **Save sources ZIP**. This is
the only way to exercise `scanInspectedPage`/`saveRecoveredSourcesZip` end to
end — they are not unit tested (see Testing & QA).

## Code Conventions & Common Patterns

- **No classes anywhere.** `sourcemap.ts` is a stateless function library:
  plain `async function`s plus exported `type`/`interface` aliases.
- **Naming**: `camelCase` functions/variables, `PascalCase` exported types
  (`ScanResult`, `RecoveredFile`, `MissingSource`, …), `UPPER_SNAKE_CASE`
  regex constants (`JS_SOURCE_MAPPING_PATTERN`, `CSS_SOURCE_MAPPING_PATTERN`
  — `sourcemap.ts:91-92`), `kebab-case` DOM element ids (`#scan-button`,
  `#maps-table`).
- **Error handling — two tiers, don't conflate them**:
  - Hard/programmer errors `throw` (`chrome.runtime.lastError`, a malformed
    `data:` URL in `decodeDataUrlText`, a missing required DOM element in
    `panel.ts`'s `requireElement()`).
  - Per-item failures during a scan are **captured, not thrown** — a bad
    source map becomes `RecoveredMap.error: string`, an unrecoverable source
    becomes a `MissingSource { reason }` entry — so one broken map never
    aborts the rest of the scan. Preserve this distinction when adding new
    failure modes.
- **Dependency injection without a container**: `recoverSourcesFromMap(...,
  fetchText: FetchText)` and `scanInspectedPage()` take the network fetch as
  an injected function (`FetchText = (url: string) => Promise<string>`).
  Tests pass an `unreachableFetch` stub instead of hitting the network
  (`sourcemap.test.ts:8`) — follow this pattern for any new I/O you want unit
  tests to control.
- **Async**: `async`/`await` throughout; `Promise.withResolvers()` (ES2024)
  promisifies callback-based `chrome.*` APIs (`getInspectedResources`,
  `readResourceText`). Fire-and-forget UI handlers use the
  `void (async () => { ... })()` IIFE idiom (`panel.ts:50`, `:71`) — click
  handlers themselves stay synchronous.
- **State**: the entire extension has exactly one mutable variable —
  `let lastResult: ScanResult | null` in `panel.ts:16`, gating the Save
  button. Don't add module-level state to `sourcemap.ts`; keep it a pure
  library.
- **TypeScript strictness**: `strict: true` + `noUncheckedIndexedAccess:
  true` (`tsconfig.json`). Array/regex-group access is always guarded with
  `??` (e.g. `match[1] ?? null`); there are **no `!` non-null assertions**
  anywhere in `src/` — match that.
- **DOM**: raw DOM APIs only (`getElementById`, `createElement`,
  `replaceChildren`, `textContent`). No `innerHTML`, no framework.
- **fflate** (`sourcemap.ts:1`) is the only runtime dependency — used purely
  for `zipSync`/`strToU8`/`strFromU8`; there's no gzip step, source maps are
  assumed to be plain JSON.

## Important Files

- `src/sourcemap.ts` — all business logic (discovery, parsing, recovery,
  zipping). Start here for behavior changes.
- `src/panel.ts` — DevTools panel UI and the only caller of `sourcemap.ts`.
- `src/devtools.ts` — 3-line `devtools_page` entry; registers the panel.
- `src/chrome-devtools.d.ts` — hand-written ambient `chrome.*` typings for
  exactly the subset used (`panels.create`, `inspectedWindow.getResources`/
  `eval`, `downloads.download`, `runtime.lastError`). Extend this file, don't
  reach for `@types/chrome`, if you touch a new Chrome API.
- `src/sourcemap.test.ts` — Vitest unit tests, colocated with the module they
  test.
- `src/public/manifest.json` — the **source** MV3 manifest (edit this).
  `dist/manifest.json` is Vite's verbatim copy for production builds.
  `extension/manifest.json` is instead generated by `dev.ts` with an added
  `content_security_policy` permitting `localhost`/`127.0.0.1` script
  sources (the MV3 unpacked-extension carve-out for HMR) — never edit either
  generated copy, and never let the relaxed dev CSP leak into a production
  build.
- `dev.ts` — the `pnpm dev` runner. Starts a Vite dev server for HMR, then
  writes `extension/manifest.json` and `extension/*.html` (`%BASE_URL%` in
  `src/*.html` replaced by the dev server's origin) via plain text
  substitution — no `vite build` step. See the file's own doc comment for
  the full rationale.
- `vite.config.ts` — `root: "src"`, `publicDir` defaults to `src/public/`
  (unset, relative to `root`), `build.outDir` fixed at `dist/` (production
  only; `pnpm dev` never invokes `vite build`, see `dev.ts`). Two Rollup
  entry points (`devtools.html`, `panel.html`).
- `fixtures/sourcemap-page/` — manual test fixture (see Testing & QA).

## Runtime/Tooling Preferences

- **Package manager: pnpm only.** Pinned via `"packageManager":
  "pnpm@10.28.0"` in `package.json` (corepack). Do not use npm/yarn or add a
  second lockfile.
- **No Node version pin** (no `.nvmrc`/`engines` field) — use a current LTS;
  the toolchain (Vite 8, Vitest 4, TypeScript 7) needs a recent Node.
- **No linter or formatter configured** (no ESLint/Prettier/Biome,
  no editorconfig). Match the existing style by hand; don't introduce a
  formatter/linter config without raising it first.
- **CI**: `.github/workflows/ci.yml` runs `pnpm test` + `pnpm build` on pull
  requests targeting `main`. `.github/workflows/nightly.yml` runs on every
  push to `main` (or manual dispatch): `pnpm test`, `pnpm ext:build`, then
  force-moves the `nightly` git tag to the new commit and republishes the
  single rolling **`nightly`** GitHub Release (marked Pre-release) with the
  resulting `web-ext-artifacts/*.zip`, replacing the previous asset. There
  is no semver tagging step — `package.json`/`manifest.json` `version`
  fields are not read by CI.
- TypeScript is strict-mode (`tsconfig.json`); keep new code
  `noUncheckedIndexedAccess`-clean (guard indexed/regex-group access with
  `??`, not `!`).

## Testing & QA

- **Framework**: Vitest, invoked via `pnpm test` (→ `vitest run`, single
  pass, no coverage/CI configured). There is no separate `vitest.config.*`;
  config comes from `vite.config.ts` + `tsconfig.json`'s
  `"types": ["vitest/globals"]` (the test file imports `describe`/`it`/
  `expect` explicitly anyway — follow that explicit-import style for new
  tests, don't rely on the globals).
- **Location**: tests are colocated with the module under test —
  `src/sourcemap.test.ts` next to `src/sourcemap.ts`. Put new tests next to
  their module, not in a separate `tests/` tree.
- **Current coverage**: 8 `it()` cases across 3 `describe` blocks, covering
  only the pure helpers — `extractSourceMappingUrl`, `decodeDataUrlText`,
  `recoverSourcesFromMap`. The DevTools-integration surface
  (`getInspectedResources`, `scanInspectedPage`, `saveRecoveredSourcesZip`)
  and all of `panel.ts`/`devtools.ts` are **untested** — there's no
  `chrome.*` mock in the repo. If you add tests for that surface, you'll
  need to stub `chrome.devtools.*`/`chrome.downloads.*` yourself (there's no
  existing helper to reuse).
- **`fixtures/sourcemap-page/`** is manual-only fixture data (a realistic
  minified-JS/CSS page with real `.map` siblings) for exercising the panel
  in an actual Chrome + DevTools session — see Development Commands. It is
  not read by any test file; don't assume `fs`-based test wiring to it
  exists.
- When changing `recoverSourcesFromMap`/`scanInspectedPage`, add cases to
  `src/sourcemap.test.ts` using the existing inline-JSON-fixture + injected
  `fetchText` stub style rather than reading from `fixtures/`.
