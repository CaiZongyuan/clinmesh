import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { BenchmarkSuiteReport } from './types.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`
  const direct = process.argv.find(a => a.startsWith(prefix))
  if (direct) return direct.slice(prefix.length)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!
  return fallback
}

function escapeJsonForScript(obj: unknown): string {
  return JSON.stringify(obj).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

export function renderBenchmarkHtml(report: BenchmarkSuiteReport): string {
  const safeData = escapeJsonForScript(report)
  const generatedShort = report.generatedAt.replace('T', ' ').slice(0, 19) + ' UTC'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>ClinMesh Agent Harness Real Benchmark · ${report.modelId}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f8fb;
      --surface: #ffffff;
      --surface-2: #eef2f7;
      --surface-hover: #e5ebf4;
      --border: #d5deea;
      --border-strong: #b6c4d8;
      --text: #0f172a;
      --text-muted: #475569;
      --text-faint: #64748b;
      --accent: #0f62fe;
      --accent-soft: #e5f0ff;
      --teal: #0d9488;
      --teal-soft: #ccfbf1;
      --green: #15803d;
      --green-soft: #dcfce7;
      --amber: #b45309;
      --amber-soft: #fef3c7;
      --red: #b91c1c;
      --red-soft: #fee2e2;
      --purple: #6d28d9;
      --purple-soft: #ede9fe;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 6px 20px rgba(15, 23, 42, 0.04);
      --radius: 12px;
      --radius-sm: 8px;
      --font-sans: "Inter", "PingFang SC", "Microsoft YaHei UI", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0b1120;
        --surface: #111a2e;
        --surface-2: #17233b;
        --surface-hover: #1e2d4c;
        --border: #243452;
        --border-strong: #344a72;
        --text: #f1f5f9;
        --text-muted: #94a3b8;
        --text-faint: #64748b;
        --accent: #60a5fa;
        --accent-soft: #172a4a;
        --teal: #2dd4bf;
        --teal-soft: #113537;
        --green: #4ade80;
        --green-soft: #133423;
        --amber: #fbbf24;
        --amber-soft: #3a2a0d;
        --red: #f87171;
        --red-soft: #3d171a;
        --purple: #c084fc;
        --purple-soft: #2b1a47;
        --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.28);
      }
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b1120;
      --surface: #111a2e;
      --surface-2: #17233b;
      --surface-hover: #1e2d4c;
      --border: #243452;
      --border-strong: #344a72;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --text-faint: #64748b;
      --accent: #60a5fa;
      --accent-soft: #172a4a;
      --teal: #2dd4bf;
      --teal-soft: #113537;
      --green: #4ade80;
      --green-soft: #133423;
      --amber: #fbbf24;
      --amber-soft: #3a2a0d;
      --red: #f87171;
      --red-soft: #3d171a;
      --purple: #c084fc;
      --purple-soft: #2b1a47;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.28);
    }

    :root[data-theme="light"] {
      color-scheme: light;
    }

    @supports (color: light-dark(white, black)) {
      :root {
        --bg: light-dark(#f6f8fb, #0b1120);
        --surface: light-dark(#ffffff, #111a2e);
        --surface-2: light-dark(#eef2f7, #17233b);
        --surface-hover: light-dark(#e5ebf4, #1e2d4c);
        --border: light-dark(#d5deea, #243452);
        --border-strong: light-dark(#b6c4d8, #344a72);
        --text: light-dark(#0f172a, #f1f5f9);
        --text-muted: light-dark(#475569, #94a3b8);
        --text-faint: light-dark(#64748b, #64748b);
        --accent: light-dark(#0f62fe, #60a5fa);
        --accent-soft: light-dark(#e5f0ff, #172a4a);
        --teal: light-dark(#0d9488, #2dd4bf);
        --teal-soft: light-dark(#ccfbf1, #113537);
        --green: light-dark(#15803d, #4ade80);
        --green-soft: light-dark(#dcfce7, #133423);
        --amber: light-dark(#b45309, #fbbf24);
        --amber-soft: light-dark(#fef3c7, #3a2a0d);
        --red: light-dark(#b91c1c, #f87171);
        --red-soft: light-dark(#fee2e2, #3d171a);
        --purple: light-dark(#6d28d9, #c084fc);
        --purple-soft: light-dark(#ede9fe, #2b1a47);
      }
    }

    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .app-shell {
      max-width: 1420px;
      margin: 0 auto;
      padding: 20px 24px 64px;
    }

    /* Header */
    .hero {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 22px 26px;
      border-radius: var(--radius);
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      margin-bottom: 18px;
    }
    .hero-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--accent);
      background: var(--accent-soft);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 8px;
    }
    .hero h1 {
      margin: 0 0 6px;
      font-size: clamp(1.35rem, 2.2vw, 1.8rem);
      letter-spacing: -0.02em;
      font-weight: 700;
    }
    .hero-sub {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.92rem;
      max-width: 780px;
    }
    .meta-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-family: var(--font-mono);
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .segmented {
      display: inline-flex;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 3px;
      gap: 2px;
    }
    .segmented button {
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
    }
    .segmented button[aria-pressed="true"] {
      background: var(--surface);
      color: var(--text);
      outline: 1px solid var(--border-strong);
    }
    .btn {
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      padding: 7px 13px;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
    }
    .btn:hover { background: var(--surface-hover); }

    /* Tabs (modern-web-guidance compliant: single row, aria-selected::after border, no box-shadow indicator, no aria-controls) */
    .tabs-bar {
      display: flex;
      flex-wrap: nowrap;
      overflow-x: auto;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
      scrollbar-width: thin;
    }
    .tab-btn {
      position: relative;
      flex: 0 0 auto;
      white-space: nowrap;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 12px 16px;
      cursor: pointer;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn[aria-selected="true"] {
      color: var(--accent);
    }
    .tab-btn[aria-selected="true"]::after {
      content: "";
      position: absolute;
      inset-inline: 10px;
      inset-block-end: 0;
      border-block-end: 3px solid currentColor;
      border-radius: 3px 3px 0 0;
    }
    .tab-btn:focus-visible, .btn:focus-visible, .segmented button:focus-visible, select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Complex layout containment (modern-web-guidance: content-visibility + fallback) */
    .panel-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 22px;
      box-shadow: var(--shadow);
      content-visibility: auto;
      contain-intrinsic-size: auto 380px;
    }
    @supports not (content-visibility: auto) {
      .panel-card { contain: layout style paint; }
    }
    .panel-card h2 {
      margin: 0 0 4px;
      font-size: 1.08rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .panel-desc {
      margin: 0 0 16px;
      color: var(--text-muted);
      font-size: 0.86rem;
    }

    /* KPI Strip */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      box-shadow: var(--shadow);
    }
    .kpi-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 1.7rem;
      font-weight: 800;
      font-family: var(--font-mono);
      letter-spacing: -0.03em;
      line-height: 1.15;
    }
    .kpi-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .tone-green { color: var(--green); }
    .tone-accent { color: var(--accent); }
    .tone-teal { color: var(--teal); }
    .tone-purple { color: var(--purple); }
    .tone-amber { color: var(--amber); }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(520px, 1fr));
      gap: 18px;
      margin-bottom: 18px;
    }
    @media (max-width: 640px) {
      .grid-2 { grid-template-columns: 1fr; }
    }

    .card-header-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .metric-select {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
    }

    /* Charts */
    .chart-box {
      width: 100%;
      overflow-x: auto;
    }
    .chart-box svg {
      display: block;
      width: 100%;
      height: auto;
      font-family: var(--font-sans);
    }
    .legend-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }

    /* Heatmap Matrix */
    .matrix-grid {
      display: grid;
      gap: 10px;
      overflow-x: auto;
    }
    .matrix-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 6px;
    }
    .matrix-table th {
      text-align: left;
      font-size: 12.5px;
      color: var(--text-muted);
      padding: 6px 8px;
      font-weight: 700;
    }
    .matrix-cell {
      border-radius: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      cursor: pointer;
      text-align: left;
      width: 100%;
      color: var(--text);
      font-family: inherit;
      transition: transform 0.12s ease, border-color 0.12s ease;
    }
    .matrix-cell:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
    }
    .matrix-cell.pass { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 40%, var(--border)); }
    .matrix-cell.warn { background: var(--amber-soft); border-color: color-mix(in srgb, var(--amber) 45%, var(--border)); }
    .matrix-cell.fail { background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 45%, var(--border)); }
    .cell-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }
    .cell-score {
      font-family: var(--font-mono);
      font-weight: 800;
      font-size: 15px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .badge-pass { background: var(--green); color: #fff; }
    .badge-fail { background: var(--red); color: #fff; }
    .badge-neutral { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); }
    .cell-stats {
      font-size: 11.5px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    /* Responsive Table (modern-web-guidance: region, tabindex, container-type, sticky header + first col, stacked fallback) */
    .table-wrap {
      container-type: inline-size;
      overflow: auto;
      max-height: 540px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    table.data-table caption {
      text-align: left;
      padding: 10px 14px;
      font-weight: 700;
      color: var(--text-muted);
      font-size: 12.5px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    table.data-table thead th {
      position: sticky;
      inset-block-start: 0;
      z-index: 2;
      background: var(--surface-2);
      color: var(--text);
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-strong);
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    table.data-table tbody th {
      position: sticky;
      inset-inline-start: 0;
      z-index: 1;
      background: var(--surface);
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-weight: 700;
      white-space: nowrap;
    }
    table.data-table tbody td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 12.5px;
      white-space: nowrap;
    }
    table.data-table tbody tr:hover td,
    table.data-table tbody tr:hover th {
      background: var(--surface-hover);
      cursor: pointer;
    }

    @container (width < 600px) {
      table.data-table thead { display: none; }
      table.data-table, table.data-table tbody, table.data-table tr, table.data-table th, table.data-table td {
        display: block;
        width: 100%;
      }
      table.data-table tr {
        border-bottom: 2px solid var(--border-strong);
        padding: 8px 0;
      }
      table.data-table tbody th {
        position: static;
        background: var(--surface-2);
      }
      table.data-table tbody td {
        display: flex;
        justify-content: space-between;
        white-space: normal;
      }
      table.data-table tbody td::before {
        content: attr(data-label);
        font-family: var(--font-sans);
        font-weight: 600;
        color: var(--text-muted);
        margin-right: 12px;
      }
    }

    /* Inspector */
    .inspector-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
      align-items: center;
    }
    .waterfall-turn {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 10px;
      background: var(--surface-2);
    }
    .wf-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .wf-bar-track {
      height: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      margin-bottom: 8px;
    }
    .wf-seg-ttft { background: var(--amber); }
    .wf-seg-gen { background: var(--accent); }
    .wf-seg-tool { background: var(--teal); }
    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 6px;
    }
    .tool-chip {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .tool-chip.err { border-color: var(--red); background: var(--red-soft); }
    .nested-list {
      margin-top: 6px;
      padding-left: 14px;
      border-left: 2px solid var(--purple);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .oracle-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 8px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      margin-bottom: 6px;
      font-size: 13px;
    }
    .oracle-item.ok { border-left: 4px solid var(--green); }
    .oracle-item.bad { border-left: 4px solid var(--red); }

    pre.answer-box {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-sans);
      font-size: 13px;
      max-height: 360px;
      overflow: auto;
      margin: 8px 0 0;
    }

    /* Tooltip */
    .svg-tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 999;
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 9px;
      padding: 10px 12px;
      font-size: 12px;
      box-shadow: var(--shadow);
      max-width: 300px;
      opacity: 0;
      transition: opacity 0.1s ease;
    }
    .svg-tooltip.show { opacity: 1; }

    .method-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 14px;
    }
    .method-item {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
    }
    .method-item h3 { margin: 0 0 6px; font-size: 13.5px; color: var(--accent); }
    .method-item p { margin: 0; font-size: 13px; color: var(--text-muted); }

    .stack-gap { display: flex; flex-direction: column; gap: 18px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="hero">
      <div>
        <div class="hero-eyebrow">ClinMesh Agent Harness · Live Real-Model Benchmark</div>
        <h1>前后端工具 Harness 真实 Agent 基准评测报告</h1>
        <p class="hero-sub">
          基于真实 ClinMesh SQLite 临床工作流、真实 React 19 + <code>@ui-sdk/react</code> Playwright 浏览器环境与真实本地 <code>pi:magpie</code> 模型流，
          系统对比后端 6 条路线（Flat MCP / Legacy CLI / Multica CLI / 2026 Stateless MCP / Hybrid ToolSearch+Macro / QuickJS Codemode）与前端 3 条路线（Raw DOM / Flat UI-SDK / Dual-Track UI-SDK）。
        </p>
        <div class="meta-pills">
          <span class="pill">Model: ${report.modelId}</span>
          <span class="pill">Provider: ${report.provider}</span>
          <span class="pill">Branch: ${report.gitBranch}@${report.gitCommit}</span>
          <span class="pill">Efforts: ${report.effortsTested.join(' / ')}</span>
          <span class="pill">Runs: ${report.runs.length}</span>
          <span class="pill">Generated: ${generatedShort}</span>
        </div>
      </div>
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="推理强度筛选">
          <button type="button" data-effort-filter="all" aria-pressed="true">全部档位</button>
          <button type="button" data-effort-filter="off" aria-pressed="false">none (off)</button>
          <button type="button" data-effort-filter="low" aria-pressed="false">low</button>
        </div>
        <div class="segmented" role="group" aria-label="配色主题">
          <button type="button" data-theme-set="system" aria-pressed="true">跟随系统</button>
          <button type="button" data-theme-set="light" aria-pressed="false">亮色</button>
          <button type="button" data-theme-set="dark" aria-pressed="false">暗色</button>
        </div>
        <button type="button" class="btn" id="btn-export-json">导出原始 JSON</button>
      </div>
    </header>

    <nav class="tabs-bar" role="tablist" aria-label="评测报告视图">
      <button class="tab-btn" type="button" role="tab" id="tab-overview" aria-selected="true" tabindex="0">总览与帕累托前沿</button>
      <button class="tab-btn" type="button" role="tab" id="tab-matrix" aria-selected="false" tabindex="-1">任务 × 路线矩阵</button>
      <button class="tab-btn" type="button" role="tab" id="tab-frontend" aria-selected="false" tabindex="-1">前端 UI-SDK 实测</button>
      <button class="tab-btn" type="button" role="tab" id="tab-inspector" aria-selected="false" tabindex="-1">逐轮轨迹剖析器</button>
      <button class="tab-btn" type="button" role="tab" id="tab-method" aria-selected="false" tabindex="-1">基准审计与方法论</button>
    </nav>

    <main>
      <!-- Panel 1: Overview -->
      <section class="stack-gap" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
        <div class="kpi-grid" id="kpi-strip"></div>

        <div class="grid-2">
          <article class="panel-card">
            <div class="card-header-row">
              <div>
                <h2>帕累托前沿：总 Token 消耗 vs 端到端耗时</h2>
                <p class="panel-desc">左下角越优；气泡大小代表工具调用次数，点击任意气泡直达逐轮轨迹剖析。</p>
              </div>
              <select class="metric-select" id="pareto-track-select" aria-label="帕累托视图轨道">
                <option value="backend">后端 6 路线 (T1-T3)</option>
                <option value="frontend">前端 3 路线 (U1-U2)</option>
                <option value="all">全部路线</option>
              </select>
            </div>
            <div class="chart-box" id="chart-pareto"></div>
            <div class="legend-row">
              <span class="legend-item"><i class="dot" style="background:#ef4444"></i>传统基线 (B1/B2/F1)</span>
              <span class="legend-item"><i class="dot" style="background:#f59e0b"></i>CLI / MCP 外露协议 (B3/B4)</span>
              <span class="legend-item"><i class="dot" style="background:#0f62fe"></i>Hybrid 内部收敛架构 (B5/B6)</span>
              <span class="legend-item"><i class="dot" style="background:#0d9488"></i>前端 UI-SDK (F2/F3)</span>
            </div>
          </article>

          <article class="panel-card">
            <div class="card-header-row">
              <div>
                <h2>后端 6 路线多指标对比（none vs low）</h2>
                <p class="panel-desc">按 3 项真实门诊临床任务均值聚合，支持切换任意核心工程指标。</p>
              </div>
              <select class="metric-select" id="bar-metric-select" aria-label="选择对比指标">
                <option value="turn1InputTokens">首轮输入 Tokens (Schema+引导开销)</option>
                <option value="totalTokens">总 Token 消耗 (越低越优)</option>
                <option value="wallDurationMs">端到端耗时 ms (越低越优)</option>
                <option value="oracleScore">真值 Oracle 得分 % (越高越优)</option>
                <option value="llmTurns">LLM 交互轮次 (越低越优)</option>
                <option value="cacheHitRatePct">Prompt Cache 命中率 %</option>
                <option value="avgTtftMs">平均首字延迟 TTFT ms</option>
              </select>
            </div>
            <div class="chart-box" id="chart-backend-bars"></div>
          </article>
        </div>

        <article class="panel-card">
          <div class="card-header-row">
            <div>
              <h2>路线首轮静态上下文构成 & 渐进式披露效率</h2>
              <p class="panel-desc">直观对比 Turn-1 实际送入模型的 Prompt Tokens 与传统 73 全量 MCP / 35KB 全量 SKILL.md 的压降幅度。</p>
            </div>
          </div>
          <div class="chart-box" id="chart-turn1-drop"></div>
        </article>
      </section>

      <!-- Panel 2: Matrix -->
      <section class="stack-gap" role="tabpanel" id="panel-matrix" aria-labelledby="tab-matrix" hidden>
        <article class="panel-card">
          <h2>后端 6 路线 × 3 临床任务热力矩阵</h2>
          <p class="panel-desc">点击任意单元格即可跳转至该次真实运行的逐轮瀑布流与 SQLite/Contract 真值核验细节。</p>
          <div class="matrix-grid" id="backend-matrix"></div>
        </article>

        <article class="panel-card">
          <h2>前端 Playwright 3 路线 × 2 临床交互任务矩阵</h2>
          <p class="panel-desc">覆盖未保存手改保护 + 独立撤销（U1）与批量分诊 + data-agent-confirm 人工确认门禁（U2）。</p>
          <div class="matrix-grid" id="frontend-matrix"></div>
        </article>

        <article class="panel-card">
          <h2 id="full-table-heading">全量真实运行记录表（支持点击表头排序与行钻取）</h2>
          <p class="panel-desc">每条记录均来自独立 SQLite 实例与真实 <code>pi:magpie</code> 提供商回执。</p>
          <div class="table-wrap" tabindex="0" role="region" aria-labelledby="full-table-heading">
            <table class="data-table" id="runs-table">
              <caption>ClinMesh Agent Harness 完整运行数据明细（点击任意行查看轨迹剖析）</caption>
              <thead>
                <tr>
                  <th scope="col" data-sort="armId">路线 (Arm)</th>
                  <th scope="col" data-sort="taskId">任务 (Task)</th>
                  <th scope="col" data-sort="effort">档位</th>
                  <th scope="col" data-sort="scorePct">真值得分</th>
                  <th scope="col" data-sort="turn1InputTokens">首轮 Tokens</th>
                  <th scope="col" data-sort="totalTokens">总 Tokens</th>
                  <th scope="col" data-sort="cacheHitRatePct">缓存命中</th>
                  <th scope="col" data-sort="wallDurationMs">耗时 (s)</th>
                  <th scope="col" data-sort="llmTurns">轮次</th>
                  <th scope="col" data-sort="toolCallCount">工具调用</th>
                  <th scope="col" data-sort="toolErrorCount">工具报错</th>
                  <th scope="col" data-sort="safety">安全红线</th>
                </tr>
              </thead>
              <tbody id="runs-tbody"></tbody>
            </table>
          </div>
        </article>
      </section>

      <!-- Panel 3: Frontend UI-SDK -->
      <section class="stack-gap" role="tabpanel" id="panel-frontend" aria-labelledby="tab-frontend" hidden>
        <div class="kpi-grid" id="frontend-kpi-strip"></div>
        <div class="grid-2">
          <article class="panel-card">
            <h2>前端三路线效率对比（Token / 耗时 / 工具调用 / 快照体积）</h2>
            <p class="panel-desc">真实 Playwright Chromium 渲染 <code>apps/web/dist</code> 测量，非 JSDOM 模拟。</p>
            <div class="chart-box" id="chart-frontend-compare"></div>
          </article>
          <article class="panel-card">
            <h2>人机协作安全红线验收清单（手改保护 · 撤销隔离 · 确认门禁 · 侧边栏隔离）</h2>
            <p class="panel-desc">对比 Raw DOM、Flat UI-SDK 与收敛后 Dual-Track UI-SDK 的物理安全护栏实测结果。</p>
            <div id="frontend-safety-cards"></div>
          </article>
        </div>
      </section>

      <!-- Panel 4: Inspector -->
      <section class="stack-gap" role="tabpanel" id="panel-inspector" aria-labelledby="tab-inspector" hidden>
        <article class="panel-card">
          <h2>交互式逐轮轨迹与真值验收剖析器</h2>
          <p class="panel-desc">选择任意一次真实运行，检查每一轮的 TTFT、Prompt/Cache/Output Token、工具入参/出参、QuickJS Codemode 嵌套调用与 SQLite/DOM Oracle 断言。</p>
          <div class="inspector-controls">
            <label>选择运行记录：
              <select class="metric-select" id="inspector-run-select" aria-label="选择要剖析的运行记录"></select>
            </label>
          </div>
          <div id="inspector-body"></div>
        </article>
      </section>

      <!-- Panel 5: Methodology -->
      <section class="stack-gap" role="tabpanel" id="panel-method" aria-labelledby="tab-method" hidden>
        <article class="panel-card">
          <h2>check-benchmark 严谨性审计与可复现方法论</h2>
          <p class="panel-desc">以下记录本次基准的真实执行边界、变量控制、真值预言机与可复现命令，杜绝虚构或不可比结论。</p>
          <div class="method-grid" id="method-grid"></div>
        </article>
        <article class="panel-card">
          <h2>路线架构定义清单</h2>
          <p class="panel-desc">参与评测的 6 条后端路线与 3 条前端路线的精确能力边界。</p>
          <div class="method-grid" id="arms-desc-grid"></div>
        </article>
      </section>
    </main>
  </div>

  <div class="svg-tooltip" id="svg-tooltip" role="status" aria-live="polite"></div>

  <script id="benchmark-data" type="application/json">${safeData}</script>
  <script>
    (() => {
      const DATA = JSON.parse(document.getElementById('benchmark-data').textContent);
      const state = {
        effort: 'all',
        paretoTrack: 'backend',
        barMetric: 'turn1InputTokens',
        sortKey: 'armId',
        sortDir: 1,
        selectedRunId: DATA.runs[0]?.runId ?? '',
      };

      const armMap = new Map(DATA.arms.map(a => [a.id, a]));
      const taskMap = new Map(DATA.tasks.map(t => [t.id, t]));
      const tooltip = document.getElementById('svg-tooltip');

      // Theme management (modern-web-guidance: handle matchMedia change event + data-theme)
      const root = document.documentElement;
      const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
      let themePref = 'system';
      function applyTheme() {
        if (themePref === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', themePref);
        document.querySelectorAll('[data-theme-set]').forEach(btn => {
          btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === themePref));
        });
      }
      darkMedia.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });
      document.querySelectorAll('[data-theme-set]').forEach(btn => {
        btn.addEventListener('click', () => { themePref = btn.dataset.themeSet; applyTheme(); });
      });

      // Tabs (roving tabindex + arrow keys + hidden attribute)
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const panels = [
        document.getElementById('panel-overview'),
        document.getElementById('panel-matrix'),
        document.getElementById('panel-frontend'),
        document.getElementById('panel-inspector'),
        document.getElementById('panel-method'),
      ];
      function activateTab(idx, focusTab = false) {
        tabs.forEach((tab, i) => {
          const active = i === idx;
          tab.setAttribute('aria-selected', String(active));
          tab.tabIndex = active ? 0 : -1;
          panels[i].hidden = !active;
          if (active && focusTab) tab.focus();
        });
      }
      tabs.forEach((tab, idx) => {
        tab.addEventListener('click', () => activateTab(idx));
        tab.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); activateTab((idx + 1) % tabs.length, true); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); activateTab((idx - 1 + tabs.length) % tabs.length, true); }
          else if (e.key === 'Home') { e.preventDefault(); activateTab(0, true); }
          else if (e.key === 'End') { e.preventDefault(); activateTab(tabs.length - 1, true); }
        });
      });

      // Helpers
      const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');
      const fmtSec = (ms) => (ms / 1000).toFixed(1) + 's';
      const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      function filteredRuns() {
        return DATA.runs.filter(r => state.effort === 'all' || r.effort === state.effort);
      }

      function armColor(armId) {
        if (armId === 'B1-flat-mcp' || armId === 'F1-raw-dom-a11y') return '#ef4444';
        if (armId === 'B2-legacy-cli') return '#f97316';
        if (armId === 'B3-multica-cli') return '#d97706';
        if (armId === 'B4-stateless-mcp-2026') return '#8b5cf6';
        if (armId === 'B5-hybrid-tool-search') return '#0f62fe';
        if (armId === 'B6-hybrid-codemode') return '#0d9488';
        if (armId === 'F2-flat-ui-sdk') return '#3b82f6';
        if (armId === 'F3-dual-track-ui-sdk') return '#10b981';
        return '#64748b';
      }

      function showTooltip(evt, html) {
        tooltip.innerHTML = html;
        tooltip.style.left = Math.min(window.innerWidth - 320, evt.clientX + 14) + 'px';
        tooltip.style.top = Math.min(window.innerHeight - 160, evt.clientY + 14) + 'px';
        tooltip.classList.add('show');
      }
      function hideTooltip() { tooltip.classList.remove('show'); }

      function jumpToRun(runId) {
        state.selectedRunId = runId;
        document.getElementById('inspector-run-select').value = runId;
        renderInspector();
        activateTab(3);
      }

      // KPI Strip
      function renderKpis() {
        const runs = filteredRuns();
        const bRuns = runs.filter(r => r.track === 'backend');
        const fRuns = runs.filter(r => r.track === 'frontend');
        const b1 = bRuns.filter(r => r.armId === 'B1-flat-mcp');
        const b5 = bRuns.filter(r => r.armId === 'B5-hybrid-tool-search');
        const b6 = bRuns.filter(r => r.armId === 'B6-hybrid-codemode');
        const bestHybrid = [...b5, ...b6];
        const b1T1 = avg(b1.map(r => r.turn1InputTokens));
        const b5T1 = avg(b5.map(r => r.turn1InputTokens));
        const b6T1 = avg(b6.map(r => r.turn1InputTokens));
        const bestT1 = Math.min(b5T1 || Infinity, b6T1 || Infinity);
        const t1Drop = b1T1 > 0 && Number.isFinite(bestT1) ? ((1 - bestT1 / b1T1) * 100).toFixed(1) : '—';

        const b1Tok = avg(b1.map(r => r.totalTokens));
        const hybTok = avg(bestHybrid.map(r => r.totalTokens));
        const tokDrop = b1Tok > 0 && hybTok > 0 ? ((1 - hybTok / b1Tok) * 100).toFixed(1) : '—';

        const b1Lat = avg(b1.map(r => r.wallDurationMs));
        const hybLat = avg(bestHybrid.map(r => r.wallDurationMs));
        const speedup = hybLat > 0 && b1Lat > 0 ? (b1Lat / hybLat).toFixed(2) + 'x' : '—';

        const hybPass = bestHybrid.filter(r => r.oracle.passed).length;
        const hybScore = avg(bestHybrid.map(r => r.oracle.scorePct));
        const zeroLeaks = runs.filter(r => !r.oracle.caseTruthLeaked).length;

        const f3 = fRuns.filter(r => r.armId === 'F3-dual-track-ui-sdk');
        const f3Pass = f3.filter(r => r.oracle.passed).length;
        const cacheRate = avg(bestHybrid.map(r => r.cacheHitRatePct));

        const cards = [
          {
            label: '首轮 Prompt 压降 (Hybrid vs Flat MCP)',
            value: t1Drop === '—' ? '—' : '-' + t1Drop + '%',
            sub: b1T1 ? ('B1 ' + fmtInt(Math.round(b1T1)) + ' → Hybrid ' + fmtInt(Math.round(bestT1)) + ' tok') : '需要 B1 + Hybrid 数据',
            tone: 'tone-green',
          },
          {
            label: '任务总 Token 节省 (Hybrid vs Flat MCP)',
            value: tokDrop === '—' ? '—' : (Number(tokDrop) >= 0 ? '-' : '+') + Math.abs(Number(tokDrop)).toFixed(1) + '%',
            sub: b1Tok ? ('B1 均值 ' + fmtInt(Math.round(b1Tok)) + ' vs Hybrid ' + fmtInt(Math.round(hybTok))) : '—',
            tone: 'tone-accent',
          },
          {
            label: '端到端响应提速 (Hybrid vs Flat MCP)',
            value: speedup,
            sub: b1Lat ? ('B1 ' + fmtSec(b1Lat) + ' → Hybrid ' + fmtSec(hybLat)) : '—',
            tone: 'tone-teal',
          },
          {
            label: 'Hybrid 真值通过率 & 均分',
            value: bestHybrid.length ? (hybPass + '/' + bestHybrid.length + ' · ' + hybScore.toFixed(1) + '%') : '—',
            sub: 'Reveal Policy 零泄露：' + zeroLeaks + '/' + runs.length + ' 次运行',
            tone: 'tone-purple',
          },
          {
            label: '前端 Dual-Track UI-SDK & 缓存命中',
            value: f3.length ? ('F3 ' + f3Pass + '/' + f3.length + ' PASS') : (cacheRate.toFixed(1) + '%'),
            sub: 'Hybrid Prompt Cache 命中率均值：' + cacheRate.toFixed(1) + '%',
            tone: 'tone-amber',
          },
        ];

        document.getElementById('kpi-strip').innerHTML = cards.map(c => \`
          <div class="kpi-card">
            <div class="kpi-label">\${esc(c.label)}</div>
            <div class="kpi-value \${c.tone}">\${esc(c.value)}</div>
            <div class="kpi-sub">\${esc(c.sub)}</div>
          </div>
        \`).join('');
      }

      // Pareto Scatter Chart
      function renderPareto() {
        const container = document.getElementById('chart-pareto');
        const runs = filteredRuns().filter(r => state.paretoTrack === 'all' || r.track === state.paretoTrack);
        if (!runs.length) { container.innerHTML = '<p class="panel-desc">当前筛选下无数据</p>'; return; }

        const W = 620, H = 340, pad = { top: 24, right: 32, bottom: 48, left: 64 };
        const minTok = Math.max(5000, Math.min(...runs.map(r => r.totalTokens)) * 0.8);
        const maxTok = Math.max(...runs.map(r => r.totalTokens), 10000) * 1.18;
        const maxMs = Math.max(...runs.map(r => r.wallDurationMs), 2000) * 1.15;
        const logMin = Math.log10(minTok);
        const logMax = Math.log10(maxTok);
        const x = (tok) => pad.left + ((Math.log10(Math.max(minTok, tok)) - logMin) / Math.max(0.01, logMax - logMin)) * (W - pad.left - pad.right);
        const y = (ms) => H - pad.bottom - (ms / maxMs) * (H - pad.top - pad.bottom);

        let grid = '';
        const xTicks = [10000, 25000, 50000, 100000, 200000, 400000].filter(v => v >= minTok * 0.9 && v <= maxTok * 1.05);
        for (const gv of xTicks) {
          const gx = x(gv);
          grid += \`<line x1="\${gx}" y1="\${pad.top}" x2="\${gx}" y2="\${H - pad.bottom}" stroke="var(--border)" stroke-dasharray="3 4" />\`;
          grid += \`<text x="\${gx}" y="\${H - pad.bottom + 18}" text-anchor="middle" fill="var(--text-muted)" font-size="11">\${Math.round(gv / 1000)}k</text>\`;
        }
        for (let i = 0; i <= 4; i++) {
          const mv = (maxMs / 4) * i;
          const gy = y(mv);
          grid += \`<line x1="\${pad.left}" y1="\${gy}" x2="\${W - pad.right}" y2="\${gy}" stroke="var(--border)" stroke-dasharray="3 4" />\`;
          grid += \`<text x="\${pad.left - 8}" y="\${gy + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">\${(mv / 1000).toFixed(1)}s</text>\`;
        }

        // Plot individual runs cleanly on log-X axis; place labels for off-effort or distinct points
        const dots = runs.map((r, idx) => {
          const cx = x(r.totalTokens);
          const cy = y(r.wallDurationMs);
          const rad = Math.max(6, Math.min(16, 5 + r.toolCallCount * 0.9));
          const col = armColor(r.armId);
          const stroke = r.oracle.passed ? 'var(--surface)' : '#ef4444';
          const dash = r.oracle.passed ? '' : 'stroke-dasharray="3 2"';
          const shortArm = armMap.get(r.armId)?.shortLabel ?? r.armId;
          const showLabel = state.effort !== 'all' || r.effort === 'off';
          const labelY = idx % 2 === 0 ? cy - rad - 4 : cy + rad + 11;
          return \`
            <g class="pareto-dot" data-run-idx="\${idx}" style="cursor:pointer">
              <circle cx="\${cx}" cy="\${cy}" r="\${rad}" fill="\${col}" fill-opacity="0.8" stroke="\${stroke}" stroke-width="\${r.oracle.passed ? 1.8 : 2.6}" \${dash} />
              \${showLabel ? \`<text x="\${cx}" y="\${labelY}" text-anchor="middle" fill="var(--text)" font-size="9.5" font-weight="600">\${esc(shortArm.split(' ')[0])}/\${esc(r.taskId.slice(0,2))}</text>\` : ''}
            </g>
          \`;
        }).join('');

        container.innerHTML = \`
          <svg viewBox="0 0 \${W} \${H}" role="img" aria-label="总 Token 消耗（对数轴）与耗时帕累托散点图">
            <rect x="\${pad.left}" y="\${pad.top}" width="\${W - pad.left - pad.right}" height="\${H - pad.top - pad.bottom}" fill="var(--surface-2)" fill-opacity="0.45" rx="6" />
            \${grid}
            <text x="\${W / 2}" y="\${H - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="12" font-weight="600">总 Token 消耗 · 对数刻度（越靠左越省）</text>
            <text x="16" y="\${H / 2}" text-anchor="middle" transform="rotate(-90 16 \${H / 2})" fill="var(--text-muted)" font-size="12" font-weight="600">端到端耗时（越靠下越快）</text>
            \${dots}
          </svg>
        \`;

        container.querySelectorAll('.pareto-dot').forEach(el => {
          const r = runs[Number(el.dataset.runIdx)];
          el.addEventListener('mousemove', (e) => showTooltip(e, \`
            <strong>\${esc(armMap.get(r.armId)?.label ?? r.armId)}</strong><br/>
            任务：\${esc(taskMap.get(r.taskId)?.shortLabel ?? r.taskId)} (\${esc(r.effort)})<br/>
            真值得分：<b>\${r.oracle.scorePct}%</b> (\${r.oracle.passed ? 'PASS' : 'FAIL'})<br/>
            总 Tokens：<b>\${fmtInt(r.totalTokens)}</b>（首轮 \${fmtInt(r.turn1InputTokens)}）<br/>
            耗时：<b>\${fmtSec(r.wallDurationMs)}</b> · \${r.llmTurns} 轮 · \${r.toolCallCount} 次工具<br/>
            <em>点击查看逐轮轨迹</em>
          \`));
          el.addEventListener('mouseleave', hideTooltip);
          el.addEventListener('click', () => jumpToRun(r.runId));
        });
      }

      // Backend Grouped Bar Chart
      function renderBackendBars() {
        const container = document.getElementById('chart-backend-bars');
        const metric = state.barMetric;
        const bArms = DATA.arms.filter(a => a.track === 'backend');
        const runs = filteredRuns().filter(r => r.track === 'backend');

        const getVal = (list) => {
          if (!list.length) return 0;
          if (metric === 'oracleScore') return avg(list.map(r => r.oracle.scorePct));
          if (metric === 'avgTtftMs') return avg(list.map(r => r.avgTtftMs ?? 0));
          return avg(list.map(r => Number(r[metric] ?? 0)));
        };
        const fmtVal = (v) => {
          if (metric === 'oracleScore' || metric === 'cacheHitRatePct') return v.toFixed(1) + '%';
          if (metric === 'wallDurationMs') return (v / 1000).toFixed(1) + 's';
          if (metric === 'llmTurns') return v.toFixed(1);
          return fmtInt(Math.round(v));
        };

        const effortsToShow = state.effort === 'all' ? DATA.effortsTested : [state.effort];
        const rows = bArms.map(arm => ({
          arm,
          vals: effortsToShow.map(ef => ({
            effort: ef,
            v: getVal(runs.filter(r => r.armId === arm.id && r.effort === ef)),
          })),
        }));

        const maxV = Math.max(...rows.flatMap(r => r.vals.map(x => x.v)), 1) * 1.18;
        const W = 620, rowH = effortsToShow.length > 1 ? 52 : 40;
        const pad = { top: 18, right: 86, bottom: 26, left: 152 };
        const H = pad.top + pad.bottom + rows.length * rowH;

        let svg = '';
        rows.forEach((row, i) => {
          const y0 = pad.top + i * rowH;
          svg += \`<text x="\${pad.left - 10}" y="\${y0 + rowH / 2 + 4}" text-anchor="end" fill="var(--text)" font-size="12" font-weight="600">\${esc(row.arm.shortLabel)}</text>\`;
          row.vals.forEach((item, j) => {
            const barH = effortsToShow.length > 1 ? 16 : 22;
            const by = y0 + (effortsToShow.length > 1 ? 6 + j * 20 : 9);
            const bw = Math.max(2, (item.v / maxV) * (W - pad.left - pad.right));
            const fill = j === 0 ? armColor(row.arm.id) : 'color-mix(in srgb, ' + armColor(row.arm.id) + ' 55%, #94a3b8)';
            svg += \`
              <rect x="\${pad.left}" y="\${by}" width="\${bw}" height="\${barH}" rx="4" fill="\${fill}" />
              <text x="\${pad.left + bw + 6}" y="\${by + barH - 4}" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">\${esc(fmtVal(item.v))}\${effortsToShow.length > 1 ? ' (' + item.effort + ')' : ''}</text>
            \`;
          });
        });

        container.innerHTML = \`<svg viewBox="0 0 \${W} \${H}" role="img" aria-label="后端 6 路线指标对比柱状图">\${svg}</svg>\`;
      }

      // Turn-1 Context Drop Visualization
      function renderTurn1Drop() {
        const container = document.getElementById('chart-turn1-drop');
        const runs = filteredRuns().filter(r => r.track === 'backend');
        const bArms = DATA.arms.filter(a => a.track === 'backend');
        const items = bArms.map(arm => {
          const ar = runs.filter(r => r.armId === arm.id);
          return {
            arm,
            turn1: Math.round(avg(ar.map(r => r.turn1InputTokens))),
            total: Math.round(avg(ar.map(r => r.totalTokens))),
            offered: arm.offeredToolsTurn1,
          };
        });
        const baseline = items[0]?.turn1 || 1;
        const maxT = Math.max(...items.map(i => i.turn1), 1000) * 1.15;
        const W = 1120, H = 220, pad = { top: 28, right: 24, bottom: 52, left: 60 };
        const slotW = (W - pad.left - pad.right) / items.length;

        let bars = '';
        items.forEach((it, idx) => {
          const bx = pad.left + idx * slotW + slotW * 0.18;
          const bw = slotW * 0.64;
          const bh = Math.max(4, (it.turn1 / maxT) * (H - pad.top - pad.bottom));
          const by = H - pad.bottom - bh;
          const delta = idx === 0 ? '基准' : (((it.turn1 - baseline) / baseline) * 100).toFixed(0) + '%';
          bars += \`
            <rect x="\${bx}" y="\${by}" width="\${bw}" height="\${bh}" rx="6" fill="\${armColor(it.arm.id)}" fill-opacity="0.88" />
            <text x="\${bx + bw / 2}" y="\${by - 8}" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="700" font-family="var(--font-mono)">\${fmtInt(it.turn1)} (\${delta})</text>
            <text x="\${bx + bw / 2}" y="\${H - pad.bottom + 18}" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="600">\${esc(it.arm.shortLabel)}</text>
            <text x="\${bx + bw / 2}" y="\${H - pad.bottom + 35}" text-anchor="middle" fill="var(--text-muted)" font-size="11">Turn-1 工具数: \${it.offered}</text>
          \`;
        });
        container.innerHTML = \`<svg viewBox="0 0 \${W} \${H}" role="img" aria-label="首轮 Prompt Token 压降柱状图">\${bars}</svg>\`;
      }

      // Heatmap Matrices
      function renderMatrix(containerId, track) {
        const container = document.getElementById(containerId);
        const arms = DATA.arms.filter(a => a.track === track);
        const tasks = DATA.tasks.filter(t => t.track === track);
        const runs = filteredRuns().filter(r => r.track === track);

        let html = '<table class="matrix-table"><thead><tr><th>路线 (Arm)</th>';
        for (const t of tasks) html += \`<th>\${esc(t.shortLabel)}</th>\`;
        html += '</tr></thead><tbody>';

        for (const arm of arms) {
          html += \`<tr><th>\${esc(arm.shortLabel)}</th>\`;
          for (const task of tasks) {
            const matched = runs.filter(r => r.armId === arm.id && r.taskId === task.id);
            if (!matched.length) {
              html += '<td><div class="matrix-cell"><span class="cell-stats">未运行</span></div></td>';
              continue;
            }
            const cellsHtml = matched.map(r => {
              const cls = r.oracle.passed ? 'pass' : (r.oracle.scorePct >= 60 ? 'warn' : 'fail');
              const safetyTags = [];
              if (!r.oracle.caseTruthLeaked) safetyTags.push('🔒零泄露');
              else safetyTags.push('⚠真值泄露');
              if (r.oracle.humanEditPreserved === true) safetyTags.push('✋手改保护');
              if (r.oracle.confirmGateDeniedBlocked === true) safetyTags.push('🛡️门禁拦截');
              if (r.nestedCodemodeCallCount > 0) safetyTags.push('⚡' + r.nestedCodemodeCallCount + 'cm');
              return \`
                <button type="button" class="matrix-cell \${cls}" data-jump-run="\${esc(r.runId)}" style="margin-bottom:\${matched.length > 1 ? '6px' : '0'}">
                  <div class="cell-top">
                    <span class="cell-score">\${r.oracle.scorePct}%</span>
                    <span class="badge \${r.oracle.passed ? 'badge-pass' : 'badge-fail'}">\${esc(r.effort)} · \${r.oracle.passed ? 'PASS' : 'FAIL'}</span>
                  </div>
                  <div class="cell-stats">
                    <span>\${fmtInt(r.totalTokens)} tok</span>
                    <span>\${fmtSec(r.wallDurationMs)}</span>
                    <span>\${r.llmTurns}轮/\${r.toolCallCount}调</span>
                    <span>\${safetyTags.join(' ')}</span>
                  </div>
                </button>
              \`;
            }).join('');
            html += \`<td>\${cellsHtml}</td>\`;
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
        container.querySelectorAll('[data-jump-run]').forEach(btn => {
          btn.addEventListener('click', () => jumpToRun(btn.dataset.jumpRun));
        });
      }

      // Full Sortable Table
      function renderRunsTable() {
        const tbody = document.getElementById('runs-tbody');
        const runs = [...filteredRuns()].sort((a, b) => {
          const val = (r) => {
            if (state.sortKey === 'scorePct') return r.oracle.scorePct;
            if (state.sortKey === 'safety') return r.oracle.caseTruthLeaked ? 0 : 1;
            return r[state.sortKey] ?? '';
          };
          const av = val(a), bv = val(b);
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.sortDir;
          return String(av).localeCompare(String(bv)) * state.sortDir;
        });

        tbody.innerHTML = runs.map(r => \`
          <tr data-jump-run="\${esc(r.runId)}">
            <th scope="row">\${esc(armMap.get(r.armId)?.shortLabel ?? r.armId)}</th>
            <td data-label="任务">\${esc(taskMap.get(r.taskId)?.shortLabel ?? r.taskId)}</td>
            <td data-label="档位">\${esc(r.effort)}</td>
            <td data-label="真值得分"><span class="badge \${r.oracle.passed ? 'badge-pass' : 'badge-fail'}">\${r.oracle.scorePct}% (\${r.oracle.passedChecks}/\${r.oracle.totalChecks})</span></td>
            <td data-label="首轮 Tokens">\${fmtInt(r.turn1InputTokens)}</td>
            <td data-label="总 Tokens">\${fmtInt(r.totalTokens)}</td>
            <td data-label="缓存命中">\${r.cacheHitRatePct.toFixed(1)}%</td>
            <td data-label="耗时">\${fmtSec(r.wallDurationMs)}</td>
            <td data-label="轮次">\${r.llmTurns}</td>
            <td data-label="工具调用">\${r.toolCallCount}\${r.nestedCodemodeCallCount ? '+' + r.nestedCodemodeCallCount + 'cm' : ''}</td>
            <td data-label="工具报错">\${r.toolErrorCount}</td>
            <td data-label="安全红线">\${r.oracle.caseTruthLeaked ? '❌真值泄露' : '✅合规'}</td>
          </tr>
        \`).join('');

        tbody.querySelectorAll('tr').forEach(tr => {
          tr.addEventListener('click', () => jumpToRun(tr.dataset.jumpRun));
        });
      }

      document.querySelectorAll('#runs-table thead th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.dataset.sort;
          if (state.sortKey === key) state.sortDir *= -1;
          else { state.sortKey = key; state.sortDir = 1; }
          renderRunsTable();
        });
      });

      // Frontend Tab
      function renderFrontendPanel() {
        const fRuns = filteredRuns().filter(r => r.track === 'frontend');
        const fArms = DATA.arms.filter(a => a.track === 'frontend');

        const f1 = fRuns.filter(r => r.armId === 'F1-raw-dom-a11y');
        const f2 = fRuns.filter(r => r.armId === 'F2-flat-ui-sdk');
        const f3 = fRuns.filter(r => r.armId === 'F3-dual-track-ui-sdk');

        const f1Snap = avg(f1.map(r => r.frontendMetrics?.snapshotChars ?? 0));
        const f3Snap = avg(f3.map(r => r.frontendMetrics?.snapshotChars ?? 0));
        const snapDrop = f1Snap > 0 ? ((1 - f3Snap / f1Snap) * 100).toFixed(1) : '—';

        document.getElementById('frontend-kpi-strip').innerHTML = [
          { label: 'F3 快照体积压降 (vs F1 ARIA)', value: snapDrop === '—' ? '—' : '-' + snapDrop + '%', sub: 'F1 ' + fmtInt(Math.round(f1Snap)) + ' chars → F3 ' + fmtInt(Math.round(f3Snap)) + ' chars', tone: 'tone-green' },
          { label: 'F3 侧边栏控件泄露 (data-agent-hidden)', value: f3.every(r => (r.frontendMetrics?.sidebarControlsExposed ?? 0) === 0) ? '0 控件' : '发现泄露', sub: 'F1 Raw ARIA 暴露侧边栏控件：' + Math.round(avg(f1.map(r => r.frontendMetrics?.sidebarControlsExposed ?? 0))) + ' 个', tone: 'tone-teal' },
          { label: 'F3 医生手改保护 + Agent 独立撤销', value: f3.filter(r => r.taskId.startsWith('U1')).every(r => r.oracle.humanEditPreserved) ? '100% 保护' : '需核查', sub: 'stageChanges 手改锁 + history.undoSource("agent")', tone: 'tone-accent' },
          { label: 'F3 data-agent-confirm 高危门禁', value: f3.filter(r => r.taskId.startsWith('U2')).every(r => r.oracle.confirmGateDeniedBlocked && r.oracle.confirmGateApprovedCommitted) ? '拒绝0写入 / 批准落库' : '需核查', sub: '真实 POST /record-triage 网络与 SQLite 双验收', tone: 'tone-purple' },
        ].map(c => \`
          <div class="kpi-card">
            <div class="kpi-label">\${esc(c.label)}</div>
            <div class="kpi-value \${c.tone}">\${esc(c.value)}</div>
            <div class="kpi-sub">\${esc(c.sub)}</div>
          </div>
        \`).join('');

        // Frontend comparison bars
        const metrics = [
          { label: '总 Tokens', fn: (list) => avg(list.map(r => r.totalTokens)), fmt: (v) => fmtInt(Math.round(v)) },
          { label: '端到端耗时 (s)', fn: (list) => avg(list.map(r => r.wallDurationMs / 1000)), fmt: (v) => v.toFixed(1) + 's' },
          { label: '工具调用次数', fn: (list) => avg(list.map(r => r.toolCallCount)), fmt: (v) => v.toFixed(1) },
          { label: '单次快照字符数', fn: (list) => avg(list.map(r => r.frontendMetrics?.snapshotChars ?? 0)), fmt: (v) => fmtInt(Math.round(v)) },
        ];
        const W = 580, blockH = 82, pad = { left: 118, right: 78, top: 14 };
        const H = pad.top + metrics.length * blockH + 10;
        let svg = '';
        metrics.forEach((m, mi) => {
          const vals = fArms.map(a => ({ arm: a, v: m.fn(fRuns.filter(r => r.armId === a.id)) }));
          const maxV = Math.max(...vals.map(x => x.v), 1) * 1.15;
          const y0 = pad.top + mi * blockH;
          svg += \`<text x="\${pad.left - 10}" y="\${y0 + 36}" text-anchor="end" fill="var(--text)" font-size="12" font-weight="700">\${esc(m.label)}</text>\`;
          vals.forEach((item, ai) => {
            const by = y0 + ai * 22 + 4;
            const bw = Math.max(2, (item.v / maxV) * (W - pad.left - pad.right));
            svg += \`
              <rect x="\${pad.left}" y="\${by}" width="\${bw}" height="16" rx="4" fill="\${armColor(item.arm.id)}" />
              <text x="\${pad.left + bw + 6}" y="\${by + 12}" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">\${esc(m.fmt(item.v))} (\${esc(item.arm.id.slice(0,2))})</text>
            \`;
          });
        });
        document.getElementById('chart-frontend-compare').innerHTML = \`<svg viewBox="0 0 \${W} \${H}" role="img" aria-label="前端三路线多维度对比图">\${svg}</svg>\`;

        // Safety verdict cards
        document.getElementById('frontend-safety-cards').innerHTML = fArms.map(arm => {
          const ar = fRuns.filter(r => r.armId === arm.id);
          const u1 = ar.filter(r => r.taskId.startsWith('U1'));
          const u2 = ar.filter(r => r.taskId.startsWith('U2'));
          const avgScore = avg(ar.map(r => r.oracle.scorePct));
          const u1Protect = u1.every(r => r.oracle.humanEditPreserved);
          const u1Undo = u1.some(r => r.frontendMetrics?.agentFieldAfterUndoCleared === true);
          const u2Deny = u2.every(r => r.oracle.confirmGateDeniedBlocked);
          const u2Commit = u2.every(r => r.oracle.confirmGateApprovedCommitted);
          return \`
            <div class="oracle-item \${avgScore >= 80 ? 'ok' : 'bad'}" style="flex-direction:column;gap:6px">
              <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
                <strong>\${esc(arm.label)}</strong>
                <span class="badge \${avgScore >= 80 ? 'badge-pass' : 'badge-fail'}">均分 \${avgScore.toFixed(1)}%</span>
              </div>
              <div class="cell-stats">
                <span>U1手改保留: \${u1Protect ? '✅' : '❌'}</span>
                <span>U1独立撤销: \${u1Undo ? '✅' : '—'}</span>
                <span>U2拒绝拦截: \${u2Deny ? '✅' : '❌'}</span>
                <span>U2批准落库: \${u2Commit ? '✅' : '❌'}</span>
              </div>
            </div>
          \`;
        }).join('');
      }

      // Inspector
      function populateInspectorSelect() {
        const sel = document.getElementById('inspector-run-select');
        const runs = filteredRuns();
        sel.innerHTML = runs.map(r => \`
          <option value="\${esc(r.runId)}">[\${r.oracle.passed ? 'PASS' : 'FAIL'} \${r.oracle.scorePct}%] \${esc(r.armId)} · \${esc(r.taskId)} · effort=\${esc(r.effort)} (\${fmtInt(r.totalTokens)} tok, \${fmtSec(r.wallDurationMs)})</option>
        \`).join('');
        if (!runs.some(r => r.runId === state.selectedRunId) && runs.length) {
          state.selectedRunId = runs[0].runId;
        }
        sel.value = state.selectedRunId;
      }

      function renderInspector() {
        const body = document.getElementById('inspector-body');
        const r = DATA.runs.find(x => x.runId === state.selectedRunId);
        if (!r) { body.innerHTML = '<p class="panel-desc">暂无运行记录</p>'; return; }

        const maxTurnMs = Math.max(...r.turns.map(t => t.durationMs), 100);
        const turnsHtml = r.turns.map(t => {
          const ttft = t.ttftMs ?? 0;
          const gen = Math.max(0, t.durationMs - ttft);
          const ttftPct = Math.min(100, (ttft / maxTurnMs) * 100);
          const genPct = Math.min(100 - ttftPct, (gen / maxTurnMs) * 100);
          const toolsHtml = t.toolCalls.map(tc => {
            const nested = (tc.nestedCalls ?? []).map(nc => \`
              <div class="tool-chip \${nc.status === 'error' ? 'err' : ''}">
                ⚡ QuickJS nested: <strong>\${esc(nc.name)}</strong> [\${esc(nc.status)}] \${nc.durationMs !== undefined ? nc.durationMs + 'ms' : ''} · args: <code>\${esc(nc.argsPreview ?? '')}</code> \${nc.error ? ' · ERR: ' + esc(nc.error) : ''}
              </div>
            \`).join('');
            return \`
              <div class="tool-chip \${tc.isError ? 'err' : ''}">
                <div><strong>\${esc(tc.name)}</strong> · \${tc.durationMs}ms · out=\${fmtInt(tc.outputChars)} chars \${tc.isError ? '· [ERROR]' : ''}</div>
                <div style="color:var(--text-muted);margin-top:3px">args: <code>\${esc(tc.argsPreview)}</code></div>
                <div style="color:var(--text-faint);margin-top:2px">out: <code>\${esc(tc.outputPreview)}</code></div>
                \${nested ? '<div class="nested-list">' + nested + '</div>' : ''}
              </div>
            \`;
          }).join('');
          return \`
            <div class="waterfall-turn">
              <div class="wf-head">
                <span>Turn #\${t.turnIndex} · \${t.stopReason} · 耗时 \${fmtSec(t.durationMs)} (TTFT \${t.ttftMs !== null ? t.ttftMs + 'ms' : '—'})</span>
                <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">
                  in=\${fmtInt(t.inputTokens)} · cache=\${fmtInt(t.cacheReadTokens)} · out=\${fmtInt(t.outputTokens)} · offeredTools=\${t.offeredToolCount}
                </span>
              </div>
              <div class="wf-bar-track" title="TTFT vs 生成耗时">
                <div class="wf-seg-ttft" style="width:\${ttftPct}%"></div>
                <div class="wf-seg-gen" style="width:\${genPct}%"></div>
              </div>
              \${toolsHtml ? '<div class="tool-list">' + toolsHtml + '</div>' : '<div style="font-size:12px;color:var(--text-muted)">纯文本输出（无工具调用）</div>'}
            </div>
          \`;
        }).join('');

        const oracleHtml = r.oracle.checks.map(c => \`
          <div class="oracle-item \${c.passed ? 'ok' : 'bad'}">
            <span>\${c.passed ? '✅' : '❌'}</span>
            <div>
              <div><strong>[\${esc(c.category)} · \${c.weight}分] \${esc(c.label)}</strong></div>
              <div style="font-size:12px;color:var(--text-muted)">\${esc(c.detail)}</div>
            </div>
          </div>
        \`).join('');

        const receiptHtml = r.skillReceipt ? \`
          <div class="meta-pills" style="margin-bottom:12px">
            <span class="pill">SkillReceipt: \${esc(r.skillReceipt.skillBundle)}</span>
            <span class="pill">SHA-256: \${esc(r.skillReceipt.sha256)}</span>
            <span class="pill">Injected: \${fmtInt(r.skillReceipt.injectedBytes)} B</span>
          </div>
        \` : '';

        body.innerHTML = \`
          <div class="meta-pills" style="margin-bottom:12px">
            <span class="pill">Run: \${esc(r.runId)}</span>
            <span class="pill">Score: \${r.oracle.scorePct}% (\${r.oracle.passed ? 'PASS' : 'FAIL'})</span>
            <span class="pill">Total Tokens: \${fmtInt(r.totalTokens)} (Turn-1: \${fmtInt(r.turn1InputTokens)})</span>
            <span class="pill">Cache Hit: \${r.cacheHitRatePct}%</span>
            <span class="pill">Wall: \${fmtSec(r.wallDurationMs)}</span>
          </div>
          \${receiptHtml}
          <div class="grid-2">
            <div>
              <h3 style="margin:0 0 10px;font-size:15px">逐轮耗时与工具调用瀑布流</h3>
              \${turnsHtml}
            </div>
            <div>
              <h3 style="margin:0 0 10px;font-size:15px">确定性 SQLite / DOM / Contract 真值验收</h3>
              \${oracleHtml}
              <h3 style="margin:14px 0 6px;font-size:15px">模型最终回复（已脱敏）</h3>
              <pre class="answer-box">\${esc(r.finalAnswerFull)}</pre>
            </div>
          </div>
        \`;
      }

      // Methodology
      function renderMethodology() {
        const entries = [
          ['真实数据库隔离', DATA.methodology.database],
          ['真实浏览器环境', DATA.methodology.browser],
          ['变量控制与隔离', DATA.methodology.isolation],
          ['Token 统计口径', DATA.methodology.tokenSource],
          ['真值隔离红线 (Reveal Policy)', DATA.methodology.revealPolicyGuard],
          ['失败与重试纪律', DATA.methodology.retryPolicy],
        ];
        document.getElementById('method-grid').innerHTML = entries.map(([k, v]) => \`
          <div class="method-item"><h3>\${esc(k)}</h3><p>\${esc(v)}</p></div>
        \`).join('');

        document.getElementById('arms-desc-grid').innerHTML = DATA.arms.map(a => \`
          <div class="method-item">
            <h3>\${esc(a.label)}</h3>
            <p>\${esc(a.summary)}</p>
            <div class="meta-pills">
              <span class="pill">Turn-1 工具数: \${a.offeredToolsTurn1}</span>
              <span class="pill">渐进披露: \${a.supportsProgressiveDisclosure ? '是' : '否'}</span>
              <span class="pill">沙箱编排: \${a.supportsCodeExecution ? 'QuickJS' : '否'}</span>
            </div>
          </div>
        \`).join('');
      }

      function renderAll() {
        renderKpis();
        renderPareto();
        renderBackendBars();
        renderTurn1Drop();
        renderMatrix('backend-matrix', 'backend');
        renderMatrix('frontend-matrix', 'frontend');
        renderRunsTable();
        renderFrontendPanel();
        populateInspectorSelect();
        renderInspector();
      }

      // Events
      document.querySelectorAll('[data-effort-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.effort = btn.dataset.effortFilter;
          document.querySelectorAll('[data-effort-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
          renderAll();
        });
      });
      document.getElementById('pareto-track-select').addEventListener('change', (e) => {
        state.paretoTrack = e.target.value;
        renderPareto();
      });
      document.getElementById('bar-metric-select').addEventListener('change', (e) => {
        state.barMetric = e.target.value;
        renderBackendBars();
      });
      document.getElementById('inspector-run-select').addEventListener('change', (e) => {
        state.selectedRunId = e.target.value;
        renderInspector();
      });
      document.getElementById('btn-export-json').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clinmesh-agent-harness-benchmark.json';
        a.click();
        URL.revokeObjectURL(url);
      });

      renderMethodology();
      renderAll();
    })();
  </script>
</body>
</html>
`
}

async function main(): Promise<void> {
  const inputPath = resolve(REPO_ROOT, parseArg('in', 'benchmarks/agent-harness/results/latest.json'))
  const outputPath = resolve(REPO_ROOT, parseArg('out', 'benchmarks/agent-harness/report.html'))
  const raw = await readFile(inputPath, 'utf8')
  const report = JSON.parse(raw) as BenchmarkSuiteReport
  const html = renderBenchmarkHtml(report)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, html, 'utf8')
  console.log(`Generated interactive benchmark report: ${outputPath} (${Buffer.byteLength(html, 'utf8').toLocaleString()} bytes, ${report.runs.length} runs)`)
}

main().catch((error) => {
  console.error('Report generation failed:', error)
  process.exitCode = 1
})
