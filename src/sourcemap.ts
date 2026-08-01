import { strFromU8, strToU8, zipSync } from "fflate";

export type SourceKind = "js" | "css";
export type FetchText = (url: string) => Promise<string>;

export type RecoveredFile = {
  path: string;
  content: string;
  source: string | null;
  sourceUrl: string | null;
  mapUrl: string;
  generatedUrls: string[];
};

export type MissingSource = { source: string | null; sourceUrl: string | null; reason: string };

export type RecoveredMap = {
  mapUrl: string;
  generatedUrls: string[];
  recoveredCount: number;
  missingCount: number;
  missing: MissingSource[];
  error?: string;
};

export type ScanResult = {
  inspectedUrl: string | null;
  scannedAt: string;
  resourceCount: number;
  maps: RecoveredMap[];
  files: RecoveredFile[];
};

export type SaveResult = { filename: string; downloadId?: number; fallback: boolean };

type RawSourceMap = {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  sourcesContent?: (string | null)[];
  sections?: { offset?: { line: number; column: number }; map?: RawSourceMap; url?: string }[];
};

// ---- Resource access ----

export async function getInspectedResources(): Promise<chrome.devtools.inspectedWindow.Resource[]> {
  const { promise, resolve, reject } = Promise.withResolvers<chrome.devtools.inspectedWindow.Resource[]>();
  chrome.devtools.inspectedWindow.getResources((resources) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    resolve(resources ?? []);
  });
  return promise;
}

export async function readResourceText(
  resource: chrome.devtools.inspectedWindow.Resource
): Promise<{ text: string; encoding: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ text: string; encoding: string }>();
  resource.getContent((content, encoding) => {
    const normalizedEncoding = encoding ?? "";
    if (normalizedEncoding === "base64") {
      try {
        resolve({ text: decodeBase64Text(content ?? ""), encoding: normalizedEncoding });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (normalizedEncoding !== "") {
      reject(new Error(`Unsupported resource encoding: ${normalizedEncoding}`));
      return;
    }
    resolve({ text: content ?? "", encoding: normalizedEncoding });
  });
  return promise;
}

function decodeBase64Text(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---- Source map annotation extraction ----

const JS_SOURCE_MAPPING_PATTERN = /^[@#]\s*sourceMappingURL=(\S*?)\s*$/;
const CSS_SOURCE_MAPPING_PATTERN = /^\/\*[@#]\s*sourceMappingURL=(\S*?)\s*\*\/$/;

export function extractSourceMappingUrl(text: string, kind: SourceKind): string | null {
  const lines = text.split(/\r\n|\r|\n/);
  if (kind === "js") {
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed.startsWith("//")) continue;
      const match = JS_SOURCE_MAPPING_PATTERN.exec(trimmed.slice(2));
      if (match) return match[1] ?? null;
    }
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    const match = CSS_SOURCE_MAPPING_PATTERN.exec(trimmed);
    if (match) return match[1] ?? null;
  }
  return null;
}

// ---- Data URL decoding ----

export function decodeDataUrlText(url: string): string {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(url);
  if (!match) throw new Error("Invalid data URL: missing comma separator");
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const isBase64 = /;base64$/i.test(meta);
  try {
    if (isBase64) return decodeBase64Text(payload);
    return decodeURIComponent(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid data URL: ${message}`);
  }
}

// ---- ZIP path derivation ----

function joinSourceRoot(sourceRoot: string | undefined, source: string): string {
  if (!sourceRoot) return source;
  const root = sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`;
  return `${root}${source}`;
}

function classifyAndBuildPath(joined: string, index: number): string {
  let base = joined;
  try {
    const parsed = new URL(joined);
    if (parsed.protocol === "webpack:") {
      base = parsed.pathname;
    } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      base = `${parsed.hostname}${parsed.pathname}`;
    }
  } catch {
    // Not an absolute URL on its own: treat as a plain relative source path.
  }

  const segments = base
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .map((segment) => segment.replace(/[<>:"|?*\x00-\x1F]/g, "_"));

  const normalized = segments.join("/");
  return `sources/${normalized === "" ? `unknown-source-${index}.txt` : normalized}`;
}

function withSuffix(path: string, suffix: number): string {
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return `${dir}${filename}__${suffix}`;
  return `${dir}${filename.slice(0, dotIndex)}__${suffix}${filename.slice(dotIndex)}`;
}

function reservePath(seen: Map<string, string>, candidate: string, content: string): string {
  const existing = seen.get(candidate);
  if (existing === undefined) {
    seen.set(candidate, content);
    return candidate;
  }
  if (existing === content) return candidate;

  let suffix = 2;
  let next = withSuffix(candidate, suffix);
  while (seen.has(next) && seen.get(next) !== content) {
    suffix += 1;
    next = withSuffix(candidate, suffix);
  }
  if (!seen.has(next)) seen.set(next, content);
  return next;
}

function getProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

// ---- Source map parsing and recovery ----

export async function recoverSourcesFromMap(
  mapText: string,
  mapUrl: string,
  generatedUrl: string | null,
  fetchText: FetchText
): Promise<{ map: RecoveredMap; files: RecoveredFile[] }> {
  const generatedUrls = generatedUrl ? [generatedUrl] : [];

  let parsed: RawSourceMap;
  try {
    parsed = JSON.parse(mapText) as RawSourceMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      map: {
        mapUrl,
        generatedUrls,
        recoveredCount: 0,
        missingCount: 0,
        missing: [],
        error: `Failed to parse source map JSON: ${message}`
      },
      files: []
    };
  }

  const files: RecoveredFile[] = [];
  const missing: MissingSource[] = [];
  const seenPaths = new Map<string, string>();

  async function processRegularMap(map: RawSourceMap): Promise<void> {
    const sources = map.sources ?? [];
    const sourcesContent = map.sourcesContent ?? [];
    for (let i = 0; i < sources.length; i++) {
      const rawSource = sources[i];
      if (rawSource === null || rawSource === undefined) {
        missing.push({ source: null, sourceUrl: null, reason: "source name is null" });
        continue;
      }

      const joined = joinSourceRoot(map.sourceRoot, rawSource);
      let sourceUrl: string | null;
      try {
        sourceUrl = new URL(joined, mapUrl).href;
      } catch {
        sourceUrl = null;
      }

      const contentFromMap = sourcesContent[i];
      if (typeof contentFromMap === "string") {
        const path = reservePath(seenPaths, classifyAndBuildPath(joined, i), contentFromMap);
        files.push({ path, content: contentFromMap, source: rawSource, sourceUrl, mapUrl, generatedUrls });
        continue;
      }

      const protocol = sourceUrl ? getProtocol(sourceUrl) : null;
      if (sourceUrl && (protocol === "http:" || protocol === "https:" || protocol === "data:")) {
        try {
          const fetched = await fetchText(sourceUrl);
          const path = reservePath(seenPaths, classifyAndBuildPath(joined, i), fetched);
          files.push({ path, content: fetched, source: rawSource, sourceUrl, mapUrl, generatedUrls });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          missing.push({ source: rawSource, sourceUrl, reason: `sourcesContent missing and fetch failed: ${message}` });
        }
      } else {
        missing.push({ source: rawSource, sourceUrl, reason: "sourcesContent missing and source URL is not fetchable" });
      }
    }
  }

  async function processMap(map: RawSourceMap): Promise<void> {
    if (Array.isArray(map.sections)) {
      for (const section of map.sections) {
        if (section.map) await processMap(section.map);
      }
      return;
    }
    await processRegularMap(map);
  }

  await processMap(parsed);

  return {
    map: { mapUrl, generatedUrls, recoveredCount: files.length, missingCount: missing.length, missing },
    files
  };
}

// ---- Resource classification ----

function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function classifyGeneratedKind(url: string, text: string): SourceKind | null {
  const pathname = getPathname(url);
  if (/\.(js|mjs|cjs)$/i.test(pathname)) return "js";
  if (/\.css$/i.test(pathname)) return "css";
  if (/^[ \t]*\/\/[@#]\s*sourceMappingURL=/m.test(text)) return "js";
  if (/\/\*[@#]\s*sourceMappingURL=/.test(text)) return "css";
  return null;
}

function isDirectMapResource(url: string, text: string): boolean {
  if (!/\.map$/i.test(getPathname(url))) return false;
  try {
    const parsed = JSON.parse(text) as { sources?: unknown; sections?: unknown };
    return Array.isArray(parsed.sources) || Array.isArray(parsed.sections);
  } catch {
    return false;
  }
}

async function defaultFetchText(url: string): Promise<string> {
  if (url.startsWith("data:")) return decodeDataUrlText(url);
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

async function loadMapText(resolvedMapUrl: string, resourceTextByUrl: Map<string, string>): Promise<string> {
  const cached = resourceTextByUrl.get(resolvedMapUrl);
  if (cached !== undefined) return cached;
  const response = await fetch(resolvedMapUrl, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

async function getInspectedUrl(): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  try {
    chrome.devtools.inspectedWindow.eval("location.href", (result, isException) => {
      if (isException || typeof result !== "string") {
        resolve(null);
        return;
      }
      resolve(result);
    });
  } catch {
    resolve(null);
  }
  return promise;
}

// ---- Whole-page scan orchestration ----

export async function scanInspectedPage(): Promise<ScanResult> {
  const inspectedUrl = await getInspectedUrl();
  const resources = await getInspectedResources();

  const resourceTextByUrl = new Map<string, string>();
  const readResources: { url: string; text: string }[] = [];
  for (const resource of resources) {
    try {
      const { text } = await readResourceText(resource);
      resourceTextByUrl.set(resource.url, text);
      readResources.push({ url: resource.url, text });
    } catch {
      // Resource content unavailable (e.g. opaque or unsupported encoding); skip it.
    }
  }

  const directMapUrls = new Set<string>();
  for (const { url, text } of readResources) {
    if (isDirectMapResource(url, text)) directMapUrls.add(url);
  }

  const processed = new Map<string, { map: RecoveredMap; files: RecoveredFile[] }>();

  function mergeGenerated(generatedUrl: string, entry: { map: RecoveredMap; files: RecoveredFile[] }): void {
    if (!entry.map.generatedUrls.includes(generatedUrl)) entry.map.generatedUrls.push(generatedUrl);
    for (const file of entry.files) {
      if (!file.generatedUrls.includes(generatedUrl)) file.generatedUrls.push(generatedUrl);
    }
  }

  for (const { url: generatedUrl, text } of readResources) {
    const kind = classifyGeneratedKind(generatedUrl, text);
    if (!kind) continue;
    const sourceMappingUrl = extractSourceMappingUrl(text, kind);
    if (!sourceMappingUrl) continue;

    const isInline = sourceMappingUrl.startsWith("data:");
    let resolvedMapUrl: string;
    if (isInline) {
      resolvedMapUrl = sourceMappingUrl;
    } else {
      try {
        resolvedMapUrl = new URL(sourceMappingUrl, generatedUrl).href;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        processed.set(`${generatedUrl}#unresolved-map`, {
          map: {
            mapUrl: sourceMappingUrl,
            generatedUrls: [generatedUrl],
            recoveredCount: 0,
            missingCount: 0,
            missing: [],
            error: `Failed to resolve source map URL: ${message}`
          },
          files: []
        });
        continue;
      }
    }

    const existing = processed.get(resolvedMapUrl);
    if (existing) {
      mergeGenerated(generatedUrl, existing);
      directMapUrls.delete(resolvedMapUrl);
      continue;
    }

    let mapText: string;
    try {
      mapText = isInline ? decodeDataUrlText(sourceMappingUrl) : await loadMapText(resolvedMapUrl, resourceTextByUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      processed.set(resolvedMapUrl, {
        map: {
          mapUrl: resolvedMapUrl,
          generatedUrls: [generatedUrl],
          recoveredCount: 0,
          missingCount: 0,
          missing: [],
          error: `Failed to load source map: ${message}`
        },
        files: []
      });
      directMapUrls.delete(resolvedMapUrl);
      continue;
    }

    const result = await recoverSourcesFromMap(mapText, resolvedMapUrl, generatedUrl, defaultFetchText);
    processed.set(resolvedMapUrl, result);
    directMapUrls.delete(resolvedMapUrl);
  }

  for (const mapUrl of directMapUrls) {
    const text = resourceTextByUrl.get(mapUrl);
    if (text === undefined) continue;
    const result = await recoverSourcesFromMap(text, mapUrl, null, defaultFetchText);
    processed.set(mapUrl, result);
  }

  const maps: RecoveredMap[] = [];
  const files: RecoveredFile[] = [];
  for (const entry of processed.values()) {
    maps.push(entry.map);
    files.push(...entry.files);
  }

  if (maps.length === 0) {
    maps.push({
      mapUrl: "",
      generatedUrls: [],
      recoveredCount: 0,
      missingCount: 0,
      missing: [],
      error: "No sourceMappingURL annotations or .map resources found"
    });
  }

  return {
    inspectedUrl,
    scannedAt: new Date().toISOString(),
    resourceCount: resources.length,
    maps,
    files
  };
}

// ---- ZIP save ----

function safeHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname ? hostname.replace(/[^A-Za-z0-9._-]/g, "_") : null;
  } catch {
    return null;
  }
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function saveRecoveredSourcesZip(result: ScanResult): Promise<SaveResult> {
  if (result.files.length === 0) {
    throw new Error("No recovered source files to save");
  }

  const zipEntries: Record<string, Uint8Array> = {
    "source-map-report.json": strToU8(JSON.stringify(result, null, 2))
  };
  for (const recovered of result.files) {
    zipEntries[recovered.path] = strToU8(recovered.content);
  }
  const zipBytes = zipSync(zipEntries, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });

  const host = safeHostname(result.inspectedUrl) || "inspected-page";
  const basename = `${host}-${formatTimestamp(new Date())}.zip`;
  const filename = `${basename}`;

  if (typeof chrome !== "undefined" && typeof chrome.downloads?.download === "function") {
    try {
      const base64 = btoa(strFromU8(zipBytes, true));
      const downloadId = await chrome.downloads.download({
        url: `data:application/zip;base64,${base64}`,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      return { filename, downloadId, fallback: false };
    } catch {
      console.warn("chrome.downloads.download failed, falling back to DOM anchor download");
      // Fall through to the DOM anchor fallback below.
    }
  }

  const blob = new Blob([zipBytes.slice()], { type: "application/zip" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = basename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

  return { filename: basename, fallback: true };
}
