import { defineConfig } from "unocss";
import presetWind4 from "@unocss/preset-wind4";

export default defineConfig({
  presets: [presetWind4({ preflights: { reset: false } })],
  preflights: [
    {
      getCSS: () => `
:root {
  color-scheme: light dark;
  --fg: #202124;
  --bg: #ffffff;
  --border: #dadce0;
  --muted: #5f6368;
  --error: #d93025;
}

@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e8eaed;
    --bg: #202124;
    --border: #3c4043;
    --muted: #9aa0a6;
    --error: #f28b82;
  }
}
`
    }
  ],
  shortcuts: {
    "panel-root": "min-h-screen bg-[var(--bg)] p-2 text-[var(--fg)]",
    "panel-button":
      "cursor-pointer rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-[var(--fg)] disabled:cursor-not-allowed disabled:text-[var(--muted)] disabled:opacity-60",
    "tab-button": "cursor-pointer border-0 border-b-2 border-b-transparent rounded-none bg-transparent px-2.5 py-1.5 text-[var(--muted)]",
    "tab-button-active": "border-b-[var(--fg)] text-[var(--fg)]",
    "status-icon-col": "w-[1.5em]",
    "status-icon": "text-center font-semibold",
    "status-icon-error": "text-[var(--error)]",
    "panel-table": "mb-2 w-full border-collapse",
    "panel-cell": "border-b border-[var(--border)] px-1.5 py-1 text-left text-[11px]",
    "panel-head-cell": "border-b border-[var(--border)] px-1.5 py-1 text-left text-[11px] text-[var(--muted)] font-semibold",
    "panel-ellipsis": "overflow-hidden text-ellipsis whitespace-nowrap"
  }
});
