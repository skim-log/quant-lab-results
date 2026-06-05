/* quant-lab 백테스트 대시보드 — 정적 클라이언트.
 *
 * 데이터는 data/manifest.json + data/dashboard_*.json (파이썬 webexport.py 가 생성).
 * 서버 없이 브라우저에서 차트를 그리고, 기간을 바꾸면 NAV 시계열을 그 시점 기준으로
 * 재정규화해 구간 지표를 metrics.py 와 동일한 공식으로 다시 계산한다.
 *
 * 지표 공식(반드시 src/common/metrics.py 와 일치):
 *  - 수익률 r_i = nav_i / nav_{i-1} - 1
 *  - _years = (마지막일 - 첫일).days / 365.25
 *  - 변동성 = popStd(r) * sqrt(ppy)        (모집단 표준편차, ddof=0)
 *  - Sharpe = mean(r) / popStd(r) * sqrt(ppy)        (rf=0)
 *  - Sortino = mean(r) / popStd(r<0) * sqrt(ppy)      (분모는 음수수익만)
 *  - MDD = min(nav/cummax - 1),  Calmar = CAGR / |MDD|
 *  - 승률 = #(r>0)/#r,  총수익 = nav_last/nav_first - 1
 */
'use strict';

const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
                 '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f'];
const FONT = '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';

const state = {
  manifest: [],
  data: null,        // 현재 데이터셋 JSON
  colorOf: {},       // name -> color
  colToMetric: {},   // 표시컬럼 -> metrics_raw 키 (재계산 가능 컬럼 식별)
  globalStart: '',   // 데이터셋 전체 최소 날짜 (ISO)
  globalEnd: '',     // 데이터셋 전체 최대 날짜 (ISO)
};

// ---------------------------------------------------------------------------
// 수치 유틸 (metrics.py 미러링)
// ---------------------------------------------------------------------------
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function popStd(a) {
  if (!a.length) return NaN;
  const mu = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) * (x - mu), 0) / a.length);
}
function pctChanges(nav) {
  const r = [];
  for (let i = 1; i < nav.length; i++) {
    if (nav[i - 1] != null && nav[i] != null) r.push(nav[i] / nav[i - 1] - 1);
  }
  return r;
}
function yearsBetween(d0, d1) {
  return Math.max((new Date(d1) - new Date(d0)) / 86400000 / 365.25, 1e-9);
}
function drawdownSeries(nav) {
  let peak = -Infinity;
  return nav.map(v => { if (v == null) return null; if (v > peak) peak = v; return v / peak - 1; });
}
function maxDrawdown(nav) {
  let peak = -Infinity, mdd = 0;
  for (const v of nav) { if (v == null) continue; if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  return mdd;
}

/** window 슬라이스(raw nav)에서 8개 지표 재계산. metrics_raw 와 동일 키. */
function computeMetrics(datesW, navW, ppy) {
  const r = pctChanges(navW);
  const first = navW[0], last = navW[navW.length - 1];
  const yrs = yearsBetween(datesW[0], datesW[datesW.length - 1]);
  const cagr = Math.pow(last / first, 1 / yrs) - 1;
  const sd = popStd(r);
  const downside = r.filter(x => x < 0);
  const dd = popStd(downside);
  const mdd = maxDrawdown(navW);
  return {
    CAGR: cagr,
    ann_vol: sd * Math.sqrt(ppy),
    sharpe: sd > 0 ? mean(r) / sd * Math.sqrt(ppy) : NaN,
    sortino: dd > 0 ? mean(r) / dd * Math.sqrt(ppy) : NaN,
    mdd: mdd,
    calmar: mdd !== 0 ? cagr / Math.abs(mdd) : NaN,
    win_rate: r.length ? r.filter(x => x > 0).length / r.length : NaN,
    total: last / first - 1,
  };
}

// ---------------------------------------------------------------------------
// 날짜/윈도우 헬퍼 (ISO 문자열 비교)
// ---------------------------------------------------------------------------
function isoMinusYears(iso, years) {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
function sliceWindow(series, s, e) {
  // series.dates 는 정렬된 ISO 문자열 → 문자열 비교로 슬라이스
  const dW = [], nW = [];
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i];
    if (d >= s && d <= e && series.nav[i] != null) { dW.push(d); nW.push(series.nav[i]); }
  }
  return { dates: dW, nav: nW };
}

// ---------------------------------------------------------------------------
// 포맷
// ---------------------------------------------------------------------------
function fmtPct(v) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(2) + '%'; }
function fmtPctScaled(v) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(2) + '%'; } // 이미 ×100 된 값
function fmtRatio(v) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(2); }
function fmtPlain(v) { return (v == null) ? '—' : v; }

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------
function checkedNames() {
  return Array.from(document.querySelectorAll('#strategy-list input:checked')).map(c => c.value);
}
function currentWindow() {
  const s = document.getElementById('start').value || state.globalStart;
  const e = document.getElementById('end').value || state.globalEnd;
  return { s, e };
}
function isFullPeriod(s, e) { return s <= state.globalStart && e >= state.globalEnd; }

function render() {
  if (!state.data) return;
  const { s, e } = currentWindow();
  const names = checkedNames();
  const ppy = state.data.periods_per_year;
  const logscale = document.getElementById('logscale').checked;

  // 각 전략별 윈도우 슬라이스 + 재정규화
  const rows = [];
  for (const name of names) {
    const ser = state.data.series.find(x => x.name === name);
    if (!ser) continue;
    const w = sliceWindow(ser, s, e);
    if (w.nav.length < 2) continue; // 윈도우에 데이터 없음 → 제외
    const base = w.nav[0];
    const rebased = w.nav.map(v => v / base);
    rows.push({ name, dates: w.dates, nav: w.nav, rebased,
                metrics: computeMetrics(w.dates, w.nav, ppy),
                period: `${w.dates[0]}~${w.dates[w.dates.length - 1]}` });
  }

  renderEquity(rows, logscale);
  renderDrawdown(rows);
  renderAnnual(rows);
  renderTable(rows, isFullPeriod(s, e));
  renderExtras(rows, s, e);   // 글로벌 자산배분 전용 패널(데이터셋에 해당 필드가 있을 때만)

  const note = isFullPeriod(s, e)
    ? `전체 기간 (${state.globalStart} ~ ${state.globalEnd})`
    : `선택 구간 (${s} ~ ${e}) · 재정규화된 뷰 — 전체기간 전용 지표는 "—"`;
  document.getElementById('period-note').textContent = note;
}

const baseLayout = (title, yTitle) => ({
  title: { text: title, font: { size: 14 } },
  font: { family: FONT, size: 11 },
  margin: { l: 56, r: 16, t: 36, b: 40 },
  legend: { orientation: 'h', y: -0.18, font: { size: 10 } },
  xaxis: { type: 'date', gridcolor: '#eee' },
  yaxis: { title: yTitle, gridcolor: '#eee' },
  hovermode: 'x unified',
  plot_bgcolor: '#fff', paper_bgcolor: '#fff',
});
const PLOTCFG = { responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };

function renderEquity(rows, logscale) {
  const traces = rows.map(r => ({
    type: 'scatter', mode: 'lines', name: r.name, x: r.dates, y: r.rebased,
    line: { width: 1.6, color: state.colorOf[r.name] },
    hovertemplate: '%{y:.3f}<extra>' + r.name + '</extra>',
  }));
  const layout = baseLayout('수익곡선 (구간 시작=1.0 재정규화)', '누적 NAV');
  layout.yaxis.type = logscale ? 'log' : 'linear';
  Plotly.react('chart-equity', traces, layout, PLOTCFG);
}

function renderDrawdown(rows) {
  const traces = rows.map(r => ({
    type: 'scatter', mode: 'lines', name: r.name, x: r.dates,
    y: drawdownSeries(r.rebased).map(v => v == null ? null : v * 100),
    line: { width: 1.1, color: state.colorOf[r.name] },
    hovertemplate: '%{y:.1f}%<extra>' + r.name + '</extra>',
  }));
  const layout = baseLayout('낙폭 (Underwater)', '낙폭 %');
  Plotly.react('chart-dd', traces, layout, PLOTCFG);
}

/** 연도별 수익률 — plotting.py 규칙: 첫 해 = 그 해 말 NAV(재정규화) - 1, 이후 = 올해말/작년말 - 1. */
function annualReturns(dates, rebased) {
  const byYear = new Map(); // year -> 그 해 마지막 재정규화 NAV
  for (let i = 0; i < dates.length; i++) byYear.set(dates[i].slice(0, 4), rebased[i]);
  const years = Array.from(byYear.keys()).sort();
  const out = [];
  for (let k = 0; k < years.length; k++) {
    const cur = byYear.get(years[k]);
    const ret = (k === 0) ? cur - 1 : cur / byYear.get(years[k - 1]) - 1;
    out.push({ year: years[k], ret });
  }
  return out;
}
function renderAnnual(rows) {
  const traces = rows.map(r => {
    const ar = annualReturns(r.dates, r.rebased);
    return {
      type: 'bar', name: r.name, x: ar.map(a => a.year), y: ar.map(a => a.ret * 100),
      marker: { color: state.colorOf[r.name] },
      hovertemplate: '%{x}: %{y:.1f}%<extra>' + r.name + '</extra>',
    };
  });
  const layout = baseLayout('연도별 수익률', '연 수익률 %');
  layout.barmode = 'group';
  layout.xaxis = { type: 'category', gridcolor: '#eee' };
  Plotly.react('chart-annual', traces, layout, PLOTCFG);
}

function renderTable(rows, fullPeriod) {
  const d = state.data;
  const cols = d.table_columns;
  const pct = new Set(d.pct_cols);
  const ratio = new Set(d.ratio_cols);

  const thead = '<thead><tr><th class="name">전략</th>' +
    cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';

  const fmtDisplay = (col, v) => pct.has(col) ? fmtPctScaled(v) : ratio.has(col) ? fmtRatio(v) : fmtPlain(v);

  const body = rows.map(r => {
    const disp = d.table_display[r.name] || {};
    const tds = cols.map(col => {
      // 기간: 항상 현재 윈도우에서 도출
      if (col === '기간') return `<td>${r.period}</td>`;

      // 전체기간 → CSV(table_display) 값을 그대로 표시: 프로젝트 요약표와 100% 일치.
      // (KR 전략 행은 CSV가 엔진 내부 수익률로 계산 → NAV 재계산과 2dp에서 갈릴 수 있어
      //  헤드라인은 CSV 값을 신뢰원으로 사용.)
      if (fullPeriod) return `<td>${fmtDisplay(col, disp[col])}</td>`;

      // 구간 선택 → NAV 기반 클라이언트 재계산(재정규화). 브라우저엔 NAV만 있다.
      const mkey = state.colToMetric[col];
      if (mkey) {
        const v = r.metrics[mkey];
        const txt = pct.has(col) ? fmtPct(v) : ratio.has(col) ? fmtRatio(v) : fmtPlain(v);
        return `<td>${txt}</td>`;
      }
      // 구간에서는 재계산 불가(연회전율/XIRR/양도세 등) → —
      return '<td class="muted">—</td>';
    }).join('');
    const sw = `<span class="swatch" style="background:${state.colorOf[r.name]}"></span>`;
    return `<tr><td class="name">${sw}${r.name}</td>${tds}</tr>`;
  }).join('');

  document.getElementById('metrics-table').innerHTML = thead + '<tbody>' + body + '</tbody>';
}

// ---------------------------------------------------------------------------
// 글로벌 자산배분 전용 패널 (allocation·regimes·current·extended·band_ab·events·diagnostics)
// ---------------------------------------------------------------------------
const CAT_LABEL = { us_stock: '미국주식', kr_stock: '한국주식', cn_stock: '중국주식',
  in_stock: '인도주식', gold: '금', silver: '은', us_bond: '미국채', kr_bond: '한국채', cash: '현금' };
const GRADE_LABEL = { high: '높음', medium: '보통', low: '낮음' };

function setHidden(id, hidden) { document.getElementById(id).classList.toggle('hidden', hidden); }
function allocColor(key, j) { return key === 'cash' ? '#9ca3af' : PALETTE[j % PALETTE.length]; }

function renderExtras(rows, s, e) {
  const d = state.data;
  renderAllocation(s, e);
  renderCurrent();
  renderExtCards(rows, s, e);
  renderBandAB();
  renderEvents(s, e);
  renderDiag();
  // 자산배분 데이터셋이 아니면(KR/US 등) 모든 전용 패널 숨김은 각 함수가 처리.
  void d;
}

function renderAllocation(s, e) {
  const a = state.data.allocation;
  if (!a || !a.dates || !a.dates.length) { setHidden('alloc-section', true); return; }
  setHidden('alloc-section', false);
  const idx = [];
  for (let i = 0; i < a.dates.length; i++) if (a.dates[i] >= s && a.dates[i] <= e) idx.push(i);
  const x = idx.map(i => a.dates[i]);
  const series = a.assets.map(k => ({ key: k, vals: a.weights[k] || [] }));
  series.push({ key: 'cash', vals: a.cash || [] });
  const traces = series.map((so, j) => ({
    type: 'scatter', mode: 'lines', name: CAT_LABEL[so.key] || so.key, x,
    y: idx.map(i => (so.vals[i] || 0) * 100), stackgroup: 'one',
    line: { width: 0.5, color: allocColor(so.key, j) }, fillcolor: allocColor(so.key, j),
    hovertemplate: '%{y:.1f}%<extra>' + (CAT_LABEL[so.key] || so.key) + '</extra>',
  }));
  const title = state.data.kind === 'dynamic'
    ? '포지션 추이 — 매달 보유 비중 % (색 전환 = 자산 교체)'
    : '자산배분 추이 — 보유 비중 % (드리프트 + 리밸런싱 스냅)';
  const layout = baseLayout(title, '비중 %');
  layout.yaxis.range = [0, 100];
  layout.hovermode = 'x unified';
  Plotly.react('chart-alloc', traces, layout, PLOTCFG);
}

function renderCurrent() {
  const c = state.data.current;
  if (!c) { setHidden('current-section', true); return; }
  setHidden('current-section', false);
  document.getElementById('current-meta').textContent = `${c.date} 기준 · ${c.regime}`;
  const w = c.weights || {};
  const pills = Object.keys(w).map((k, j) => {
    const col = PALETTE[j % PALETTE.length];
    return `<span class="pill" style="border-color:${col}"><span class="swatch" style="background:${col}"></span>` +
           `${k} ${(w[k] * 100).toFixed(1)}%</span>`;
  }).join('');
  document.getElementById('current-pos').innerHTML = pills || '<span class="muted">—</span>';
}

function bestWorstMonth(dates, rebased) {
  let best = null, worst = null;
  for (let i = 1; i < rebased.length; i++) {
    const v = rebased[i] / rebased[i - 1] - 1;
    if (best === null || v > best.v) best = { v, d: dates[i].slice(0, 7) };
    if (worst === null || v < worst.v) worst = { v, d: dates[i].slice(0, 7) };
  }
  return { best, worst };
}
function bestWorstYear(dates, rebased) {
  const ar = annualReturns(dates, rebased);
  if (!ar.length) return { best: null, worst: null };
  let best = ar[0], worst = ar[0];
  for (const a of ar) { if (a.ret > best.ret) best = a; if (a.ret < worst.ret) worst = a; }
  return { best: { v: best.ret, d: best.year }, worst: { v: worst.ret, d: worst.year } };
}
function mddEpisodeJS(dates, nav) {
  let peak = nav[0], peakI = 0, maxdd = 0, mp = 0, mt = 0;
  for (let i = 0; i < nav.length; i++) {
    const v = nav[i]; if (v > peak) { peak = v; peakI = i; }
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxdd) { maxdd = dd; mp = peakI; mt = i; }
  }
  const pv = nav[mp]; let rec = false, ri = nav.length - 1;
  for (let i = mt + 1; i < nav.length; i++) if (nav[i] >= pv) { rec = true; ri = i; break; }
  const uw = rec ? ri - mp : nav.length - 1 - mp;
  return { peak: dates[mp].slice(0, 7), trough: dates[mt].slice(0, 7),
           recovery: rec ? dates[ri].slice(0, 7) : '', underwater: uw, recovered: rec };
}
function renderExtCards(rows, s, e) {
  const em = state.data.extended_metrics;
  if (!em) { setHidden('ext-section', true); return; }
  const pname = Object.keys(em)[0];
  const row = rows.find(r => r.name === pname);
  if (!row) { setHidden('ext-section', true); return; }
  setHidden('ext-section', false);
  document.getElementById('ext-for').textContent = `— ${pname} (선택 구간 재계산)`;
  const bm = bestWorstMonth(row.dates, row.rebased);
  const by = bestWorstYear(row.dates, row.rebased);
  const ep = mddEpisodeJS(row.dates, row.rebased);
  const card = (lab, val, sub) => `<div class="ext-card"><div class="lab">${lab}</div>` +
    `<div class="val">${val}</div><div class="sub">${sub}</div></div>`;
  const sign = v => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const html =
    card('최고 월', bm.best ? sign(bm.best.v) : '—', bm.best ? bm.best.d : '') +
    card('최악 월', bm.worst ? sign(bm.worst.v) : '—', bm.worst ? bm.worst.d : '') +
    card('최고 연도', by.best ? sign(by.best.v) : '—', by.best ? by.best.d : '') +
    card('최악 연도', by.worst ? sign(by.worst.v) : '—', by.worst ? by.worst.d : '') +
    card('MDD 회복', ep.recovered ? `${ep.underwater}개월` : `${ep.underwater}개월+ 미회복`,
         `${ep.peak} → ${ep.trough}${ep.recovery ? ' → ' + ep.recovery : ''}`);
  document.getElementById('ext-cards').innerHTML = html;
}

function renderBandAB() {
  const ab = state.data.band_ab;
  if (!ab || !ab.on || !ab.off) { setHidden('bandab-section', true); return; }
  setHidden('bandab-section', false);
  const defs = [
    ['CAGR', 'CAGR', 'pct', 1], ['MDD', 'MDD', 'pct', 1], ['연변동성', 'ann_vol', 'pct', -1],
    ['Sharpe', 'sharpe', 'ratio', 1], ['Sortino', 'sortino', 'ratio', 1],
    ['Calmar', 'calmar', 'ratio', 1], ['월승률', 'win_rate', 'pct', 1],
  ];
  const f = (k, v) => k === 'pct' ? fmtPct(v) : fmtRatio(v);
  const rowsH = defs.map(([lab, key, kind, better]) => {
    const on = ab.on[key], off = ab.off[key];
    const diff = (on - off) * better;   // >0 → 밴드 ON 이 더 나음
    const cls = Math.abs(on - off) < 1e-9 ? '' : (diff > 0 ? 'pos' : 'neg');
    const diffTxt = kind === 'pct' ? fmtPct(on - off) : fmtRatio(on - off);
    return `<tr><td class="name">${lab}</td><td>${f(kind, on)}</td><td>${f(kind, off)}</td>` +
           `<td class="${cls}">${diffTxt}</td></tr>`;
  }).join('');
  document.getElementById('bandab-table').innerHTML =
    '<thead><tr><th class="name">지표</th><th>밴드 ON</th><th>밴드 OFF</th><th>차이</th></tr></thead>' +
    '<tbody>' + rowsH + '</tbody>';
}

function renderEvents(s, e) {
  const ev = state.data.rebalance_events;
  if (!ev) { setHidden('events-section', true); return; }
  setHidden('events-section', false);
  const sm = s.slice(0, 7), em = e.slice(0, 7);
  const inWin = ev.filter(x => x.date >= sm && x.date <= em);
  document.getElementById('events-count').textContent = inWin.length;
  document.getElementById('events').innerHTML = inWin.map(x => {
    const cls = x.trigger === 'band' ? 'badge band' : 'badge';
    const lab = x.trigger === 'band' ? '밴드' : '정기';
    return `<span class="${cls}">${x.date} ${lab} ${(x.turnover * 100).toFixed(0)}%</span>`;
  }).join('') || '<span class="muted">구간 내 리밸런싱 없음</span>';
}

function renderDiag() {
  const dg = state.data.diagnostics;
  if (!dg) { setHidden('diag-section', true); return; }
  setHidden('diag-section', false);
  const assetRows = (dg.assets || []).map(a => {
    const grade = a.grade ? `<span class="grade ${a.grade}">${GRADE_LABEL[a.grade] || a.grade}</span>` : '';
    const proxy = (a.proxy || []).join(' + ');
    return `<tr><td class="name">${a.label || a.asset}</td><td>${grade}</td>` +
           `<td>${a.range || ''}</td><td class="muted">${proxy}</td><td class="muted">${a.note || ''}</td></tr>`;
  }).join('');
  const assetTable = assetRows
    ? '<table class="diag-table"><thead><tr><th class="name">자산</th><th>신뢰도</th><th>실제 범위</th>' +
      '<th>프록시</th><th>비고</th></tr></thead><tbody>' + assetRows + '</tbody></table>'
    : '';
  const fx = (dg.fx_labels && dg.fx_labels.length)
    ? `<p class="diag-fx">USD/KRW 환율: <span class="muted">${dg.fx_labels.join(' + ')}</span></p>` : '';
  const errRows = (dg.error_rows || []).map(r =>
    `<tr><td class="name">${CAT_LABEL[r.asset] || r.asset}</td><td class="muted">${r.cause}</td>` +
    `<td>${r.cagr_err}</td><td class="muted">${r.note || ''}</td></tr>`).join('');
  const errTable = errRows
    ? '<h3>오차 추정</h3><table class="diag-table"><thead><tr><th class="name">자산</th><th>주된 오차 원인</th>' +
      '<th>CAGR 오차</th><th>비고</th></tr></thead><tbody>' + errRows + '</tbody></table>' : '';
  const impact = (dg.error_impact || []).map(t => `<li>${t}</li>`).join('');
  const impactBlock = impact ? `<ul class="diag-impact">${impact}</ul>` : '';
  const warns = (dg.warnings || []).filter(Boolean);
  const warnBlock = warns.length
    ? `<details class="diag-warn"><summary>경고 (${warns.length})</summary><ul>` +
      warns.map(w => `<li>${w}</li>`).join('') + '</ul></details>' : '';
  document.getElementById('diag').innerHTML = assetTable + fx + errTable + impactBlock + warnBlock;
}

// ---------------------------------------------------------------------------
// 데이터셋 로딩 / UI 구성
// ---------------------------------------------------------------------------
function buildColToMetric(d) {
  const m = {};
  for (const [mkey, col] of Object.entries(d.metric_to_col || {})) m[col] = mkey;
  return m;
}

function buildStrategyList(d) {
  state.colorOf = {};
  d.series.forEach((s, i) => { state.colorOf[s.name] = PALETTE[i % PALETTE.length]; });
  const html = d.series.map(s => {
    const c = state.colorOf[s.name];
    return `<label><input type="checkbox" value="${s.name}" checked />` +
           `<span class="swatch" style="background:${c}"></span>${s.name}</label>`;
  }).join('');
  const list = document.getElementById('strategy-list');
  list.innerHTML = html;
  list.querySelectorAll('input').forEach(c => c.addEventListener('change', render));
}

function setGlobalRange(d) {
  let lo = null, hi = null;
  for (const s of d.series) {
    if (!s.dates.length) continue;
    const a = s.dates[0], b = s.dates[s.dates.length - 1];
    if (lo === null || a < lo) lo = a;
    if (hi === null || b > hi) hi = b;
  }
  state.globalStart = lo; state.globalEnd = hi;
  const sEl = document.getElementById('start'), eEl = document.getElementById('end');
  sEl.min = lo; sEl.max = hi; eEl.min = lo; eEl.max = hi;
  sEl.value = lo; eEl.value = hi;
}

async function loadDataset(file) {
  setStatus('데이터 불러오는 중…');
  try {
    const resp = await fetch('data/' + file, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const d = await resp.json();
    state.data = d;
    state.colToMetric = buildColToMetric(d);
    buildStrategyList(d);
    setGlobalRange(d);
    setActivePreset(0); // 전체
    document.getElementById('meta').textContent =
      `${d.title || ''} · 생성일 ${d.generated_at || '-'} · 빈도 ${d.freq === 'D' ? '일별' : '월별'}`;
    setStatus('');
    render();
  } catch (err) {
    setStatus('데이터 로딩 실패: ' + err.message + ' (로컬에서 볼 때는 file:// 가 아니라 http 서버로 열어야 합니다)', true);
  }
}

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

function setActivePreset(years) {
  document.querySelectorAll('#presets button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.years) === years);
  });
  const sEl = document.getElementById('start'), eEl = document.getElementById('end');
  if (years === 0) { sEl.value = state.globalStart; }
  else {
    const cand = isoMinusYears(state.globalEnd, years);
    sEl.value = cand < state.globalStart ? state.globalStart : cand;
  }
  eEl.value = state.globalEnd;
}

function wireControls() {
  document.getElementById('logscale').addEventListener('change', render);
  document.getElementById('start').addEventListener('change', () => { clearPresetActive(); render(); });
  document.getElementById('end').addEventListener('change', () => { clearPresetActive(); render(); });
  document.querySelectorAll('#presets button').forEach(b => {
    b.addEventListener('click', () => { setActivePreset(Number(b.dataset.years)); render(); });
  });
}
function clearPresetActive() {
  document.querySelectorAll('#presets button').forEach(b => b.classList.remove('active'));
}

async function init() {
  wireControls();
  try {
    const resp = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    state.manifest = await resp.json();
  } catch (err) {
    setStatus('manifest.json 로딩 실패: ' + err.message + ' (http 서버로 열어야 합니다)', true);
    return;
  }
  const sel = document.getElementById('dataset');
  sel.innerHTML = state.manifest.map(m => `<option value="${m.file}">${m.label}</option>`).join('');
  sel.addEventListener('change', () => loadDataset(sel.value));
  if (state.manifest.length) loadDataset(state.manifest[0].file);
  else setStatus('표시할 데이터셋이 없습니다. build_dashboard.py 를 먼저 실행하세요.', true);
}

document.addEventListener('DOMContentLoaded', init);
