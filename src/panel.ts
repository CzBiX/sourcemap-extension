import { saveRecoveredSourcesZip, scanInspectedPage, type ScanResult } from "./sourcemap.ts";

function requireElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

const scanButton = requireElement<HTMLButtonElement>("scan-button");
const saveButton = requireElement<HTMLButtonElement>("save-button");
const summary = requireElement<HTMLDivElement>("summary");
const mapsTableBody = requireElement<HTMLTableSectionElement>("maps-table").querySelector("tbody");
if (!mapsTableBody) throw new Error("Missing required element: #maps-table tbody");
const filesTableBody = requireElement<HTMLTableSectionElement>("files-table").querySelector("tbody");
if (!filesTableBody) throw new Error("Missing required element: #files-table tbody");
const log = requireElement<HTMLPreElement>("log");

const tabButtons = [
  { button: requireElement<HTMLButtonElement>("tab-btn-maps"), panel: requireElement<HTMLDivElement>("tab-panel-maps") },
  { button: requireElement<HTMLButtonElement>("tab-btn-files"), panel: requireElement<HTMLDivElement>("tab-panel-files") },
  { button: requireElement<HTMLButtonElement>("tab-btn-log"), panel: requireElement<HTMLDivElement>("tab-panel-log") },
];

function activateTab(active: (typeof tabButtons)[number]): void {
  for (const { button, panel } of tabButtons) {
    const isActive = button === active.button;
    button.setAttribute("aria-selected", String(isActive));
    panel.hidden = !isActive;
  }
}

for (const tab of tabButtons) {
  tab.button.addEventListener("click", () => activateTab(tab));
}

let lastResult: ScanResult | null = null;

function appendLog(message: string): void {
  log.textContent += `${message}\n`;
}

function fileTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "(no ext)" : path.slice(dot + 1).toLowerCase();
}

function displayMapUrl(mapUrl: string): string {
  if (!mapUrl.startsWith("data:")) return mapUrl;
  return "inline source map";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderResult(result: ScanResult): void {
  mapsTableBody.replaceChildren();
  filesTableBody.replaceChildren();
  for (const map of result.maps) {
    const row = document.createElement("tr");
    const statusIconCell = document.createElement("td");
    statusIconCell.className = map.error ? "status-icon status-icon-error" : "status-icon";
    statusIconCell.textContent = map.error ? "✗" : "";
    statusIconCell.title = map.error ? `Error: ${map.error}` : "";
    const generatedCell = document.createElement("td");
    generatedCell.textContent = map.generatedUrls.length > 0 ? map.generatedUrls.join(", ") : "(direct map)";
    const mapUrlCell = document.createElement("td");
    mapUrlCell.textContent = displayMapUrl(map.mapUrl);
    mapUrlCell.title = mapUrlCell.textContent;
    const recoveredCell = document.createElement("td");
    recoveredCell.textContent = String(map.recoveredCount);
    const missingCell = document.createElement("td");
    missingCell.textContent = String(map.missingCount);
    const statusCell = document.createElement("td");
    statusCell.textContent = map.error ? `Error: ${map.error}` : "";
    statusCell.title = statusCell.textContent;
    row.append(statusIconCell, generatedCell, mapUrlCell, recoveredCell, missingCell, statusCell);
    mapsTableBody.appendChild(row);

    if (map.error) appendLog(`[${displayMapUrl(map.mapUrl)}] ${map.error}`);
    for (const missing of map.missing) {
      appendLog(`[${displayMapUrl(map.mapUrl)}] missing ${missing.source ?? "(null source)"}: ${missing.reason}`);
    }
  }

  for (const file of result.files) {
    const row = document.createElement("tr");
    const pathCell = document.createElement("td");
    pathCell.textContent = file.path;
    const typeCell = document.createElement("td");
    typeCell.textContent = fileTypeOf(file.path);
    const sizeCell = document.createElement("td");
    sizeCell.textContent = formatSize(new TextEncoder().encode(file.content).length);
    row.append(pathCell, typeCell, sizeCell);
    filesTableBody.appendChild(row);
  }

  const totalMissing = result.maps.reduce((sum, map) => sum + map.missingCount, 0);
  summary.textContent = `${result.maps.length} source maps, ${result.files.length} recovered files, ${totalMissing} missing`;
}

scanButton.addEventListener("click", () => {
  void (async () => {
    scanButton.disabled = true;
    saveButton.disabled = true;
    summary.textContent = "Scanning inspected page...";
    log.textContent = "";
    try {
      const result = await scanInspectedPage();
      lastResult = result;
      renderResult(result);
      saveButton.disabled = result.files.length === 0;
    } catch (error) {
      lastResult = null;
      summary.textContent = "Scan failed";
      appendLog(error instanceof Error ? error.message : String(error));
    } finally {
      scanButton.disabled = false;
    }
  })();
});

saveButton.addEventListener("click", () => {
  void (async () => {
    if (!lastResult) return;
    try {
      const saveResult = await saveRecoveredSourcesZip(lastResult);
      appendLog(`Saved ZIP download: ${saveResult.filename}`);
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error));
    }
  })();
});
