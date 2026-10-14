// 서버가 "/"에서 내주는 간단한 상태 화면. 빌드 도구 없이 바로 열린다.
// 사용자 입력과 서버에서 온 글은 모두 textContent로만 넣는다(HTML로 해석하지 않는다).
export const STATUS_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RallyPoint</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; background: #fafafa; color: #222; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  h2 { font-size: 15px; margin: 16px 0 6px; }
  #status { padding: 8px 10px; background: #fff; border: 1px solid #ddd; border-radius: 6px; }
  .paused { background: #fff3cd !important; }
  #board { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
  .col { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 6px; min-height: 60px; }
  .col h3 { font-size: 12px; margin: 0 0 6px; text-transform: uppercase; color: #666; }
  .card { font-size: 12px; background: #eef3ff; border-radius: 4px; padding: 4px 6px; margin-bottom: 4px; word-break: break-word; }
  .unit { font-size: 13px; }
  .working { font-weight: 600; color: #0a6; }
  #prompt { background: #fff; border: 2px solid #36c; border-radius: 6px; padding: 10px; }
  #prompt[hidden] { display: none; }
  #prompt input[type=text], #prompt textarea { width: 100%; box-sizing: border-box; margin: 4px 0 8px; }
  #prompt button { margin-right: 6px; }
  #error { color: #b00; font-size: 13px; }
  #log { font: 12px/1.5 ui-monospace, monospace; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 6px; max-height: 240px; overflow: auto; white-space: pre-wrap; }
  pre.plan { white-space: pre-wrap; font-size: 12px; background: #f4f4f4; padding: 8px; border-radius: 4px; max-height: 260px; overflow: auto; }
</style>
</head>
<body>
<h1 id="title">RallyPoint</h1>
<div id="status">연결 중...</div>
<h2>사용자 확인</h2>
<div id="prompt" hidden></div>
<div id="error"></div>
<h2>결과</h2>
<div id="result">-</div>
<h2>유닛</h2>
<div id="units"></div>
<h2>보드</h2>
<div id="board"></div>
<h2>이벤트</h2>
<div id="log"></div>
<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function describe(ev) {
    switch (ev.type) {
      case 'card_moved': return 'card ' + ev.cardId + ': ' + ev.from + ' -> ' + ev.to;
      case 'unit_status_changed': return 'unit ' + ev.unitId + ': ' + ev.status;
      case 'conflict_detected': return 'conflict ' + ev.path + ' (' + ev.cardIds.join(', ') + ')';
      case 'conflict_resolved': return 'conflict resolved ' + ev.path;
      case 'paused': return 'paused: ' + ev.reason;
      case 'resumed': return 'resumed';
      case 'issue_raised': return 'issue ' + ev.cardId + ' (' + ev.kind + '): ' + ev.message;
      case 'review_result': return 'review ' + ev.cardId + ': ' + ev.verdict + ' - ' + ev.summary;
      case 'usage_updated': return 'usage: ' + ev.totalCalls + ' calls';
      default: return ev.type;
    }
  }
  function send(body) {
    $('error').textContent = '';
    fetch('/api/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) $('error').textContent = j.error; })
      .catch(function (e) { $('error').textContent = String(e); });
  }
  function planText(plan) {
    var lines = [];
    plan.areas.forEach(function (a) { lines.push('영역 ' + a.id + ': ' + a.goal); });
    plan.units.forEach(function (u) { lines.push('유닛 ' + u.id + ' [' + u.kind + '/' + u.permission + '] ' + u.role); });
    plan.cards.forEach(function (c) {
      lines.push('카드 ' + c.id + ' (반복 ' + c.iteration + ', 선행: ' + (c.dependsOn.join(', ') || '-') + '): ' + c.title);
      lines.push('    완료 기준: ' + c.doneCriteria);
    });
    lines.push('예상 모델 호출: 약 ' + plan.estimatedCalls + '회');
    return lines.join('\\n');
  }
  var shownPrompt = null;
  function renderPrompt(p) {
    var box = $('prompt');
    if (!p) { shownPrompt = null; box.hidden = true; box.replaceChildren(); return; }
    if (shownPrompt === p.id) return;
    shownPrompt = p.id;
    box.hidden = false;
    box.replaceChildren();
    if (p.kind === 'questions') {
      box.appendChild(el('div', 'Planner가 계획 전에 묻습니다.'));
      var inputs = p.questions.map(function (q) {
        box.appendChild(el('div', q));
        var i = el('input'); i.type = 'text'; box.appendChild(i); return i;
      });
      var b = el('button', '답변 보내기');
      b.onclick = function () { send({ promptId: p.id, kind: 'questions', answers: inputs.map(function (i) { return i.value; }) }); };
      box.appendChild(b);
    } else if (p.kind === 'plan_review') {
      box.appendChild(el('div', '계획을 확인하세요.'));
      box.appendChild(el('pre', planText(p.plan), 'plan'));
      var fb = el('textarea'); fb.rows = 3; fb.placeholder = '수정하려면 요청 내용을 적고 "수정 요청"을 누르세요.';
      box.appendChild(fb);
      var ok = el('button', '승인');
      ok.onclick = function () { send({ promptId: p.id, kind: 'plan_review', decision: { action: 'approve' } }); };
      var rv = el('button', '수정 요청');
      rv.onclick = function () { send({ promptId: p.id, kind: 'plan_review', decision: { action: 'revise', feedback: fb.value } }); };
      var cn = el('button', '취소');
      cn.onclick = function () { send({ promptId: p.id, kind: 'plan_review', decision: { action: 'cancel' } }); };
      box.appendChild(ok); box.appendChild(rv); box.appendChild(cn);
    } else {
      box.appendChild(el('div', '문제: 카드 ' + p.cardId + ' "' + p.title + '" (' + p.issueKind + ')'));
      box.appendChild(el('div', p.message));
      var rt = el('button', '다시 시도');
      rt.onclick = function () { send({ promptId: p.id, kind: 'issue', decision: 'retry' }); };
      var st = el('button', '멈추기');
      st.onclick = function () { send({ promptId: p.id, kind: 'issue', decision: 'stop' }); };
      box.appendChild(rt); box.appendChild(st);
    }
  }
  function render(s) {
    if (s.scenarioTitle) $('title').textContent = 'RallyPoint - ' + s.scenarioTitle;
    var status = $('status');
    status.textContent = '상태: ' + s.phase + (s.paused ? ' (일시정지: ' + s.pauseReason + ')' : '') +
      ' | 호출 ' + s.usage.totalCalls + '회 | 토큰 입력 ' + s.usage.inputTokens + ' / 출력 ' + s.usage.outputTokens;
    status.className = s.paused ? 'paused' : '';
    renderPrompt(s.prompt);
    $('result').textContent = s.result ? s.result.outcome + (s.result.message ? ' - ' + s.result.message : '') : '-';
    var units = $('units'); units.replaceChildren();
    ((s.plan && s.plan.units) || []).forEach(function (u) {
      var st = s.unitStatuses[u.id] || 'idle';
      units.appendChild(el('div', u.id + ' [' + u.kind + '] ' + st + ' - ' + u.role, st === 'working' ? 'unit working' : 'unit'));
    });
    var board = $('board'); board.replaceChildren();
    ['todo', 'in_progress', 'review', 'done', 'blocked'].forEach(function (st) {
      var col = el('div', undefined, 'col'); col.appendChild(el('h3', st));
      s.cards.filter(function (c) { return c.status === st; }).forEach(function (c) {
        col.appendChild(el('div', c.id + ': ' + c.title + (c.assignedUnitId ? ' @' + c.assignedUnitId : ''), 'card'));
      });
      board.appendChild(col);
    });
    var log = $('log'); log.replaceChildren();
    s.log.slice(-60).reverse().forEach(function (entry) {
      log.appendChild(el('div', entry.at.slice(11, 19) + '  ' + describe(entry.event)));
    });
  }
  var source = new EventSource('/api/stream');
  source.onmessage = function (m) {
    var msg = JSON.parse(m.data);
    if (msg.type === 'snapshot') render(msg.snapshot);
  };
  source.onerror = function () { $('status').textContent = '서버와 연결이 끊겼습니다. 다시 연결 중...'; };
})();
</script>
</body>
</html>
`;
