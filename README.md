# Source Map Extractor

A Chrome DevTools extension that recovers the original, pre-build source files of any inspected web page from its source maps.

## Features

- Scans every resource the inspected page loaded for `sourceMappingURL` annotations (JS & CSS).
- Recovers sources from inline `sourcesContent`, `data:` URLs, or by fetching `.map` files over HTTP.
- Recurses into index maps and dedupes colliding paths.
- Downloads all recovered files as a ZIP (plus a `source-map-report.json`).

## Install

1. Download the latest `.zip` from [Releases](https://github.com/CzBiX/sourcemap-extension/releases/latest).
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Drag the `.zip` onto the extensions page to install it.

## Usage

Open the page to inspect → DevTools → **Source Maps** panel → **Scan Pages** → **Save sources ZIP**.

## Releasing

There's no versioned release process — every push to `main` rebuilds the extension and republishes it as
the single **`nightly`** release on the `Releases` page.
