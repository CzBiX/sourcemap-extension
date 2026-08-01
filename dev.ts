/**
 * Development runner for the extension.
 *
 * Starts a Vite dev server (for HMR) and writes the extension's HTML pages +
 * manifest into the dev build directory (`extension/`) with their asset
 * references pointed at the dev server instead of a bundled build. No
 * `vite build` is involved — `%BASE_URL%` in the HTML source is replaced
 * with the dev server's origin via plain text substitution. `root`,
 * `publicDir`, and `outDir` below are the project's fixed conventional
 * locations (`src/`, `public/`, `extension/`); they are hardcoded here
 * rather than read from the dev server's resolved config because
 * `vite.config.ts` leaves those options unset, so Vite's own defaults
 * (root = cwd, outDir = `dist`) do not match what this script and
 * `pnpm ext:run` expect. Nothing else needs copying: every asset an HTML
 * page references is fetched from the dev server itself.
 *
 * Chrome only allows `chrome-extension://` pages to load scripts from a
 * remote origin when that origin is `localhost`/`127.0.0.1` on an *unpacked*
 * extension (Chrome 110+ carve-out to the MV3 `extension_pages` CSP). The
 * manifest written here declares that exception; it must never ship in a
 * production build.
 *
 * Usage: `pnpm dev`, then in another terminal `pnpm ext:run`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createServer } from "vite";

const DEV_CSP = "script-src 'self' http://localhost:* http://127.0.0.1:*";

async function writeDevManifest(publicDir: string, outDir: string): Promise<void> {
  const raw = await readFile(resolve(publicDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  manifest.content_security_policy = { extension_pages: DEV_CSP };
  await writeFile(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeHtmlEntries(root: string, outDir: string, baseUrl: string): Promise<void> {
  const names = (await readdir(root)).filter((name) => extname(name) === ".html");
  await Promise.all(
    names.map(async (name) => {
      let html = await readFile(resolve(root, name), "utf8");
      html = html.replaceAll("%BASE_URL%", baseUrl);
      html = await server.transformIndexHtml(name, html)
      html = html.replaceAll("/@vite/", `${baseUrl}@vite/`);
      await writeFile(resolve(outDir, name), html);
    })
  );
}

const outDir = "extension";

const server = await createServer();
await server.listen();

const { root, publicDir } = server.config;

const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) throw new Error("Vite dev server did not report a local URL");

await mkdir(outDir, { recursive: true });
await Promise.all([writeDevManifest(publicDir, outDir), writeHtmlEntries(root, outDir, baseUrl)]);

server.printUrls();
console.log(`\nWrote dev pages to ${outDir} (assets served from ${baseUrl})`);
console.log("Run `pnpm ext:run` in another terminal to load the extension with HMR enabled.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
