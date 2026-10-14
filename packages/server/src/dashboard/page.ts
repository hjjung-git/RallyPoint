// 대시보드 화면의 HTML 뼈대와 스타일. 동작은 /ui/main.js(packages/ui)가 맡는다.
export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";

const STYLE = `
:root {
  --paper: #EDF0F3; --surface: #FFFFFF; --ink: #16202E; --line: #CBD3DD; --slate: #6B778A;
  --teal: #0E8A8A; --violet: #6757D6; --green: #3F8F5B; --red: #C23B3B; --amber: #D9920B;
  --font: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--paper); color: var(--ink); font: 14px/1.5 var(--font); display: flex; flex-direction: column; }
[hidden] { display: none !important; }
button, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }

header.top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--line); }
header.top h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: 0; }
.brand { color: var(--slate); font-size: 13px; }
.phase { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--paper); border: 1px solid var(--line); }
.phase.is-running, .phase.is-planning { color: var(--teal); border-color: var(--teal); }
.phase.is-waiting_for_user { color: var(--amber); border-color: var(--amber); }
.usage { color: var(--slate); font-size: 12.5px; margin-left: auto; }
.tabs { display: flex; gap: 4px; }
.tabs button { border: 1px solid var(--line); background: var(--paper); padding: 4px 14px; border-radius: 8px; cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }

.banner { padding: 8px 20px; font-weight: 600; }
.banner.is-paused { background: #FBEFD2; color: #7A5200; border-bottom: 1px solid var(--amber); }
.banner.is-offline { background: #F6DCDC; color: #7C1F1F; border-bottom: 1px solid var(--red); }

.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 340px; }
.stage { overflow: auto; padding: 20px; min-width: 0; }
.side { overflow: auto; padding: 20px 20px 20px 0; display: flex; flex-direction: column; gap: 16px; }
.empty { color: var(--slate); padding: 40px 0; }

#graph { display: block; overflow: visible; }
#graph text { font-family: var(--font); fill: var(--ink); }
.lane rect { fill: rgba(255,255,255,0.55); stroke: var(--line); }
.lane text { font-size: 12.5px; font-weight: 600; fill: var(--slate); }
.edge { fill: none; stroke: #8A95A6; stroke-width: 1.4; opacity: 0.8; }
.edge.is-done { stroke: var(--green); }

.card-body { fill: var(--surface); stroke: var(--line); stroke-width: 1; }
.card-stripe { fill: var(--line); }
.card-title { font-size: 13px; font-weight: 600; }
.card-meta { font-size: 11.5px; fill: var(--slate) !important; }
.card.is-in_progress .card-stripe { fill: var(--teal); }
.card.is-in_progress .card-body { stroke: var(--teal); }
.card.is-review .card-stripe { fill: var(--violet); }
.card.is-review .card-body { stroke: var(--violet); }
.card.is-done .card-stripe { fill: var(--green); }
.card.is-done .card-title { fill: var(--slate); }
.card.is-blocked .card-stripe { fill: var(--red); }
.card.is-blocked .card-body { stroke: var(--red); }
.card.has-conflict .card-body { stroke: var(--amber); stroke-width: 2; }
.badge circle { fill: var(--red); }
.badge text { fill: #fff !important; font-size: 11px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }

.unit-body { fill: var(--surface); stroke: var(--slate); stroke-width: 1.6; }
.unit.kind-reviewer .unit-body { stroke-dasharray: 4 3; }
.unit-glyph { font-size: 14px; font-weight: 700; }
.unit-name { font-size: 11px; fill: var(--slate) !important; }
.pulse { fill: none; stroke: var(--teal); stroke-width: 2; opacity: 0; }
.unit.is-working .unit-body { stroke: var(--teal); fill: #E3F4F4; }
.unit.is-working.kind-reviewer .unit-body { stroke: var(--violet); fill: #ECE9FA; }
.unit.is-working .pulse { animation: pulse 1.6s ease-out infinite; }
.unit.is-working.kind-reviewer .pulse { stroke: var(--violet); }
.unit.is-paused .unit-body { stroke: var(--amber); }
.unit.is-failed .unit-body { stroke: var(--red); fill: #F6DCDC; }

.tether { fill: none; stroke: var(--teal); stroke-width: 2; stroke-dasharray: 6 6; animation: flow 0.9s linear infinite; }
.tether.is-review { stroke: var(--violet); }
.conflict path { stroke: var(--red); stroke-width: 2; stroke-dasharray: 3 4; fill: none; animation: flow 0.9s linear infinite; }
.conflict text { font-size: 11.5px; fill: var(--red) !important; font-weight: 600; }

@keyframes flow { to { stroke-dashoffset: -12; } }
@keyframes pulse { 0% { opacity: 0.8; transform: scale(0.85); } 100% { opacity: 0; transform: scale(1.25); } }
.pulse { transform-box: fill-box; transform-origin: center; }
@media (prefers-reduced-motion: reduce) {
  .tether, .conflict path, .unit.is-working .pulse { animation: none; }
  .unit.is-working .pulse { opacity: 0.5; }
}

#board { display: grid; gap: 10px; min-width: 760px; }
.board-row { display: grid; grid-template-columns: 110px repeat(5, minmax(120px, 1fr)); gap: 8px; align-items: start; }
.board-label { font-weight: 600; color: var(--slate); padding-top: 6px; }
.board-col-title { font-size: 12.5px; font-weight: 600; color: var(--slate); padding: 0 4px; }
.board-cell { background: rgba(255,255,255,0.55); border: 1px solid var(--line); border-radius: 10px; padding: 6px; min-height: 44px; display: flex; flex-direction: column; gap: 6px; }
.board-card { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 6px; padding: 5px 8px; }
.board-card.is-in_progress { border-left-color: var(--teal); }
.board-card.is-review { border-left-color: var(--violet); }
.board-card.is-done { border-left-color: var(--green); }
.board-card.is-blocked { border-left-color: var(--red); }
.board-card-title { font-weight: 600; font-size: 13px; }
.board-card-meta { color: var(--slate); font-size: 12px; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.panel h2 { font-size: 14px; margin: 0 0 8px; }
#prompt { border-color: var(--amber); border-width: 2px; }
.field { display: block; margin-bottom: 10px; }
.field span { display: block; margin-bottom: 4px; font-weight: 600; }
textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: var(--paper); resize: vertical; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
.btn.is-primary { background: var(--teal); border-color: var(--teal); color: #fff; font-weight: 600; }
.btn:disabled { opacity: 0.5; cursor: default; }
.prompt-error { color: var(--red); margin: 8px 0 0; min-height: 1.5em; }
.prompt-title { font-weight: 600; margin: 0 0 4px; }
.plan-summary ul { padding-left: 18px; margin: 6px 0; }
.muted { color: var(--slate); font-size: 12.5px; }
.result-text { font-weight: 600; margin: 0 0 6px; }
.iteration { margin: 0 0 4px; font-size: 13px; }
#issues { margin: 0; padding-left: 18px; color: #7C1F1F; }
#log { list-style: none; margin: 0; padding: 0; font-size: 12.5px; max-height: 320px; overflow: auto; }
#log li { padding: 3px 0; border-bottom: 1px solid var(--paper); }
#log time { color: var(--slate); font-variant-numeric: tabular-nums; }

@media (max-width: 860px) {
  .layout { display: block; overflow: auto; }
  .stage { overflow: visible; overflow-x: auto; }
  .side { overflow: visible; padding: 0 20px 20px; }
}
`;

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RallyPoint</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <span class="brand">RallyPoint</span>
  <h1 id="title">RallyPoint</h1>
  <span id="phase" class="phase">연결 중</span>
  <nav class="tabs" aria-label="보기 전환">
    <button type="button" id="tab-graph" data-view="graph" aria-selected="true">그래프</button>
    <button type="button" id="tab-board" data-view="board" aria-selected="false">보드</button>
  </nav>
  <span id="usage" class="usage"></span>
</header>
<div id="banner" class="banner" role="status" hidden></div>
<div class="layout">
  <main class="stage">
    <p id="empty" class="empty">서버에 연결하는 중입니다.</p>
    <div id="graph-wrap"><svg id="graph" role="img" aria-label="유닛과 카드의 진행 그래프" hidden></svg></div>
    <div id="board" hidden></div>
  </main>
  <aside class="side">
    <section id="prompt" class="panel" aria-live="polite" hidden></section>
    <section class="panel" id="result-panel"><h2>진행 상황</h2><div id="result" hidden></div><ul id="issues" hidden></ul></section>
    <section class="panel"><h2>최근 기록</h2><ul id="log"></ul></section>
  </aside>
</div>
<script type="module" src="/ui/main.js"></script>
</body>
</html>
`;
