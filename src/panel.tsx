import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import "virtual:uno.css";
import { saveRecoveredSourcesZip, scanInspectedPage, type RecoveredFile, type RecoveredMap, type ScanProgress, type ScanResult } from "./sourcemap";

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

function summarizeResult(result: ScanResult): string {
  const totalMissing = result.maps.reduce((sum, map) => sum + map.missingCount, 0);
  return `${result.maps.length} source maps, ${result.files.length} recovered files, ${totalMissing} missing`;
}

function progressLabel(progress: ScanProgress): string {
  const phase = progress.phase === "reading" ? "Reading resources" : "Resolving source maps";
  return `${phase} (${progress.completed}/${progress.total})`;
}

function diagnosticLogFor(result: ScanResult): string {
  let log = "";
  for (const map of result.maps) {
    if (map.error) log += `[${displayMapUrl(map.mapUrl)}] ${map.error}\n`;
    for (const missing of map.missing) {
      log += `[${displayMapUrl(map.mapUrl)}] missing ${missing.source ?? "(null source)"}: ${missing.reason}\n`;
    }
  }
  return log;
}

const textEncoder = new TextEncoder();
const emptyMaps: RecoveredMap[] = [];
const emptyFiles: RecoveredFile[] = [];

const tabs = [
  { id: "log", buttonId: "tab-btn-log", panelId: "tab-panel-log", label: "Log" },
  { id: "maps", buttonId: "tab-btn-maps", panelId: "tab-panel-maps", label: "Source Maps" },
  { id: "files", buttonId: "tab-btn-files", panelId: "tab-panel-files", label: "Recovered Files" }
] as const;

type TabId = (typeof tabs)[number]["id"];

function App() {
  const [activeTab, setActiveTab] = createSignal<TabId>("log");
  const [displayedResult, setDisplayedResult] = createSignal<ScanResult | null>(null);
  const [downloadableResult, setDownloadableResult] = createSignal<ScanResult | null>(null);
  const [isScanning, setIsScanning] = createSignal(false);
  const [summaryText, setSummaryText] = createSignal("");
  const [logText, setLogText] = createSignal("");
  const [progress, setProgress] = createSignal<ScanProgress | null>(null);

  function appendLog(message: string): void {
    setLogText((current) => `${current}${message}\n`);
  }

  function canSave(): boolean {
    return !isScanning() && (downloadableResult()?.files.length ?? 0) > 0;
  }

  function handleScan(): void {
    void (async () => {
      setIsScanning(true);
      setSummaryText("Scanning inspected page...");
      setLogText("");
      setProgress(null);
      try {
        const result = await scanInspectedPage((next) => setProgress(next));
        setDisplayedResult(result);
        setDownloadableResult(result);
        setSummaryText(summarizeResult(result));
        setLogText(diagnosticLogFor(result));
        setActiveTab("log");
      } catch (error) {
        setDownloadableResult(null);
        setSummaryText("Scan failed");
        appendLog(error instanceof Error ? error.message : String(error));
      } finally {
        setIsScanning(false);
        setProgress(null);
      }
    })();
  }

  function handleSave(): void {
    void (async () => {
      const result = downloadableResult();
      if (!result) return;
      try {
        const saveResult = await saveRecoveredSourcesZip(result);
        appendLog(`Saved ZIP download: ${saveResult.filename}`);
      } catch (error) {
        appendLog(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  return (
    <main class="panel-root">
      <div id="toolbar" class="mb-2 flex gap-2">
        <button id="scan-button" class="panel-button" disabled={isScanning()} onClick={handleScan}>
          Scan Pages
        </button>
        <button id="save-button" class="panel-button" disabled={!canSave()} onClick={handleSave}>
          Save sources ZIP
        </button>
      </div>
      <Show when={isScanning() ? progress() : null}>
        {(p) => (
          <div id="scan-progress" class="mb-2">
            <progress class="block w-full" value={p().completed} max={p().total} />
            <div class="text-[11px] text-[var(--muted)]">{progressLabel(p())}</div>
          </div>
        )}
      </Show>
      <div id="summary" role="status" class="mb-2 text-[var(--muted)]">
        {summaryText()}
      </div>
      <div id="tabs" role="tablist" class="mb-2 flex gap-1 border-b border-[var(--border)]">
        <For each={tabs}>
          {(tab) => (
            <button
              id={tab.buttonId}
              class={activeTab() === tab.id ? "tab-button tab-button-active" : "tab-button"}
              role="tab"
              aria-selected={String(activeTab() === tab.id)}
              aria-controls={tab.panelId}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div id="tab-panel-maps" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-maps" hidden={activeTab() !== "maps"}>
        <table id="maps-table" class="panel-table">
          <thead>
            <tr>
              <th class="panel-head-cell status-icon-col"></th>
              <th class="panel-head-cell">Generated resource</th>
              <th class="panel-head-cell">Source map</th>
              <th class="panel-head-cell">Recovered</th>
              <th class="panel-head-cell">Missing</th>
              <th class="panel-head-cell">Status</th>
            </tr>
          </thead>
          <tbody>
            <For each={displayedResult()?.maps ?? emptyMaps}>
              {(map) => (
                <tr>
                  <td class={map.error ? "panel-cell status-icon status-icon-error" : "panel-cell status-icon"} title={map.error ? `Error: ${map.error}` : ""}>
                    {map.error ? "✗" : ""}
                  </td>
                  <td class="panel-cell">{map.generatedUrls.length > 0 ? map.generatedUrls.join(", ") : "(direct map)"}</td>
                  <td class="panel-cell panel-ellipsis max-w-[14em]" title={displayMapUrl(map.mapUrl)}>
                    {displayMapUrl(map.mapUrl)}
                  </td>
                  <td class="panel-cell">{String(map.recoveredCount)}</td>
                  <td class="panel-cell">{String(map.missingCount)}</td>
                  <td class="panel-cell panel-ellipsis max-w-[10em]" title={map.error ? `Error: ${map.error}` : ""}>
                    {map.error ? `Error: ${map.error}` : ""}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div id="tab-panel-files" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-files" hidden={activeTab() !== "files"}>
        <table id="files-table" class="panel-table">
          <thead>
            <tr>
              <th class="panel-head-cell">File</th>
              <th class="panel-head-cell">Type</th>
              <th class="panel-head-cell">Size</th>
            </tr>
          </thead>
          <tbody>
            <For each={displayedResult()?.files ?? emptyFiles}>
              {(file) => (
                <tr>
                  <td class="panel-cell">{file.path}</td>
                  <td class="panel-cell">{fileTypeOf(file.path)}</td>
                  <td class="panel-cell">{formatSize(textEncoder.encode(file.content).length)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div id="tab-panel-log" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-log" hidden={activeTab() !== "log"}>
        <pre id="log" class="m-0 whitespace-pre-wrap break-words bg-transparent font-mono text-[11px]">
          {logText()}
        </pre>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing required element: #root");
render(() => <App />, root);
