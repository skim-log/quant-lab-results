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

// 전략 곡선 팔레트 — 라이트/다크 양쪽에서 식별 가능한 채도(Tailwind 500–600 계열).
// 비교 오버레이(최대 17개)에서 색 충돌을 줄이려 18색으로 확장.
const PALETTE = ['#2563eb', '#10b981', '#dc2626', '#ea580c', '#9333ea', '#0891b2',
                 '#ca8a04', '#db2777', '#65a30d', '#0d9488', '#7c3aed', '#e11d48',
                 '#0284c7', '#d97706', '#4f46e5', '#059669', '#c026d3', '#84cc16'];
// 자산군 색 — 리밸런서 팔레트 정합(static 8자산 + 현금). 동적 전략의 계기자산(티커)은 PALETTE 폴백.
const CAT_COLOR = { us_stock: '#2563eb', kr_stock: '#10b981', cn_stock: '#dc2626',
  in_stock: '#ea580c', gold: '#ca8a04', silver: '#94a3b8', us_bond: '#0891b2',
  kr_bond: '#9333ea', cash: '#9ca3af' };
const FONT = '"Pretendard Variable",Pretendard,"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';

const state = {
  manifest: [],
  data: null,        // 현재 데이터셋 JSON
  colorOf: {},       // name -> color
  colToMetric: {},   // 표시컬럼 -> metrics_raw 키 (재계산 가능 컬럼 식별)
  globalStart: '',   // 데이터셋 전체 최소 날짜 (ISO)
  globalEnd: '',     // 데이터셋 전체 최대 날짜 (ISO)
  nav: { super: '', category: '', group: '', currency: '' },  // 4축 네비(대분류→소분류→그룹→통화)
  playground: false, panel: null, _pgWired: false,  // 플레이그라운드 상태
  sort: { col: null, dir: -1 },  // 성과표 리더보드 정렬(열 클릭). dir: -1=내림차순
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

// ---------------------------------------------------------------------------
// 전략 설명 (설명 패널 + 체크박스 툴팁). 동적전략은 JSON description(상세) 우선.
// ---------------------------------------------------------------------------
const STRAT_DESC = {
  '매수후보유': '시작 시점에 전액 매수해 끝까지 보유(벤치마크).',
  'DCA (월적립)': '매월 일정액 분할 매수(정액적립식) — 진입 타이밍 분산.',
  'TQQQ 매수후보유': 'TQQQ(나스닥100 3배 레버리지) 매수후보유 — 변동성·낙폭 매우 큼.',
  'QQQ 매수후보유': 'QQQ(나스닥100) 매수후보유.',
  'S&P500 매수후보유': 'S&P500 매수후보유(저변동 기준선).',
  'DCA(TQQQ,월적립)': 'TQQQ 월 정액적립.',
  'LRS(QQQ200일,TQQQ)': 'QQQ가 200일선 위면 TQQQ 100%, 아래면 현금(추세추종 레버리지 로테이션).',
  '밸류 리밸런싱(VR)': '목표 밸류라인 대비 부족분 매수·초과분 매도(밸류 애버리징).',
  '라오어 무한매수법 V1': '40분할 정액 매수 + +10% 익절 사이클(라오어 무한매수법 V1).',
  '라오어 무한매수법 V2': '무한매수법 V2 — 상단 LOC 매수·후반 분할 익절.',
};
const CAT_BLURB = {
  dynamic: '신호(모멘텀·추세)로 매달 비중을 바꾸는 동적 자산배분.',
  static: '고정 비중 정적 자산배분(주기 리밸런싱 + 표류 밴드).',
  momentum: '개별 시장 모멘텀·레버리지 전략 비교(위험=TWR, 수익=XIRR).',
  crypto: '암호화폐 전략: 매수후보유·DCA·이동평균선 추세(20/60/120/200일 × 달러·원화 신호).',
  analytics: '8자산 월수익 기반 정량분석 — 상관·효율적 프론티어·리스크패리티·위험수익(무위험 2%).',
  compare: '여러 전략을 한 곡선에 오버레이 비교(통화 토글 + 지표 열 클릭 정렬 리더보드).',
};
function stratDesc(name) {
  if (!name) return '';
  if (STRAT_DESC[name]) return STRAT_DESC[name];
  const m = name.match(/^(\d+)일선 · (달러|원화)신호$/);
  if (m) return `${m[1]}일 이동평균선 추세 — ${m[2]} 가격이 ${m[1]}일선 위면 100% 보유, 아래면 현금(신호는 ${m[2]} 기준).`;
  if (name.includes('매수후보유')) return '매수 후 보유(벤치마크).';
  if (name.includes('DCA')) return '정액 분할 매수(DCA).';
  return '';
}
function renderDescription() {
  const el = document.getElementById('strategy-desc');
  if (!el) return;
  const d = state.data;
  let txt = '';
  if (d && d.kind === 'analytics') txt = CAT_BLURB.analytics;
  else if (d && d.description) txt = d.description;        // 동적/정적: JSON 상세 설명
  else txt = stratDesc(state.nav.group) || CAT_BLURB[state.nav.category] || '';
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}

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
  renderDescription();
}

// 현재 테마의 CSS 토큰 값을 읽어옴(다크/라이트 전환 시 render() 가 새 값으로 차트를 다시 그림).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '';
}
const baseLayout = (title, yTitle) => {
  const grid = cssVar('--chart-grid'), fg = cssVar('--chart-fg'),
        muted = cssVar('--chart-muted'), paper = cssVar('--chart-paper'),
        plot = cssVar('--chart-plot'), hover = cssVar('--chart-hover-bg');
  return {
    title: { text: title, font: { size: 14, color: fg } },
    font: { family: FONT, size: 11, color: muted },
    margin: { l: 56, r: 16, t: 36, b: 40 },
    legend: { orientation: 'h', y: -0.18, font: { size: 10, color: fg } },
    xaxis: { type: 'date', gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: muted } },
    yaxis: { title: { text: yTitle, font: { color: muted } }, gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: muted } },
    hovermode: 'x unified',
    hoverlabel: { bgcolor: hover, bordercolor: grid, font: { color: fg, family: FONT } },
    plot_bgcolor: plot, paper_bgcolor: paper,
  };
};
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
  layout.xaxis = { type: 'category', gridcolor: cssVar('--chart-grid'), linecolor: cssVar('--chart-grid'), tickfont: { color: cssVar('--chart-muted') } };
  Plotly.react('chart-annual', traces, layout, PLOTCFG);
}

function renderTable(rows, fullPeriod) {
  const d = state.data;
  const cols = d.table_columns;
  const pct = new Set(d.pct_cols);
  const ratio = new Set(d.ratio_cols);

  const arrow = c => (state.sort.col === c ? (state.sort.dir < 0 ? ' ▾' : ' ▴') : '');
  const thead = '<thead><tr><th class="name sortable" data-col="이름">전략' + arrow('이름') + '</th>' +
    cols.map(c => `<th class="sortable" data-col="${c}">${c}${arrow(c)}</th>`).join('') + '</tr></thead>';

  const fmtDisplay = (col, v) => pct.has(col) ? fmtPctScaled(v) : ratio.has(col) ? fmtRatio(v) : fmtPlain(v);

  // 리더보드 정렬: 선택 열의 값으로 행 정렬(전략 비교 탭에서 순위 비교). 결측은 항상 맨 뒤.
  const sortVal = (r, col) => {
    if (col === '이름') return r.name;
    if (col === '기간') return r.period;
    if (fullPeriod) { const v = (d.table_display[r.name] || {})[col]; return (v == null) ? null : +v; }
    const mkey = state.colToMetric[col];
    if (!mkey) return null;
    const v = r.metrics[mkey];
    return (v == null || isNaN(v)) ? null : +v;
  };
  let trows = rows;
  if (state.sort.col && (state.sort.col === '이름' || cols.includes(state.sort.col))) {
    const col = state.sort.col, dir = state.sort.dir;
    trows = [...rows].sort((a, b) => {
      const va = sortVal(a, col), vb = sortVal(b, col);
      const na = (va == null || (typeof va === 'number' && isNaN(va)));
      const nb = (vb == null || (typeof vb === 'number' && isNaN(vb)));
      if (na && nb) return 0;
      if (na) return 1;          // 결측은 방향 무관 맨 뒤
      if (nb) return -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb, 'ko');
      return dir * (va - vb);
    });
  }

  const body = trows.map(r => {
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
const CAT_LABEL = { us_stock: '미국 주식', kr_stock: '한국 주식', cn_stock: '중국 주식',
  in_stock: '인도 주식', gold: '금', silver: '은', us_bond: '미국 장기국채', kr_bond: '한국 국채', cash: '현금' };
const GRADE_LABEL = { high: '높음', medium: '보통', low: '낮음' };

function setHidden(id, hidden) { document.getElementById(id).classList.toggle('hidden', hidden); }
function allocColor(key, j) { return CAT_COLOR[key] || PALETTE[j % PALETTE.length]; }

function renderExtras(rows, s, e) {
  const d = state.data;
  renderTargetComposition();
  renderAllocation(s, e);
  renderCurrent();
  renderExtCards(rows, s, e);
  renderBandAB();
  renderEvents(s, e);
  renderDiag();
  // 자산배분 데이터셋이 아니면(KR/US 등) 모든 전용 패널 숨김은 각 함수가 처리.
  void d;
}

function renderTargetComposition() {
  const tw = state.data.target_weights;
  if (!tw || !Object.keys(tw).length) { setHidden('target-comp-section', true); return; }
  setHidden('target-comp-section', false);
  const entries = Object.entries(tw).filter(([, v]) => v > 1e-9).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;
  const rows = entries.map(([asset, w], j) => {
    const label = CAT_LABEL[asset] || asset;
    const col = CAT_COLOR[asset] || PALETTE[j % PALETTE.length];
    const pct = (w * 100).toFixed(1);
    const barw = Math.max(2, (w / max) * 100);
    return `<div class="comp-row"><span class="comp-lab">${label}</span>` +
           `<span class="comp-bar"><span class="comp-fill" style="width:${barw}%;background:${col}"></span></span>` +
           `<span class="comp-pct">${pct}%</span></div>`;
  }).join('');
  document.getElementById('target-comp').innerHTML = rows;
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
    const t = stratDesc(s.name);   // 시리즈별 간략 설명(없으면 툴팁 생략)
    const tip = t ? ` title="${t.replace(/"/g, '&quot;')}"` : '';
    return `<label${tip}><input type="checkbox" value="${s.name}" checked />` +
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
    if (d.kind === 'analytics') { setStatus(''); return enterAnalytics(d); }
    if (d.mode === 'playground') { setStatus(''); return enterPlayground(d); }
    setAnalyticsMode(false); setToolsMode(false);
    state.playground = false;
    setHidden('playground', true);
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

// ---------------------------------------------------------------------------
// 테마 (라이트/다크) — 무플래시 초기화는 index.html, 여기선 토글·버튼동기화·차트 재렌더.
// ---------------------------------------------------------------------------
function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function syncThemeButton() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = currentTheme() === 'dark' ? '☀' : '☾';
}
function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem('ql-theme', theme); } catch (e) { /* ignore */ } }
  syncThemeButton();
  // 차트 색은 CSS 토큰 기반 → 재렌더로 새 테마 반영(분석·도구 뷰는 전용 렌더 경로).
  if (document.body.classList.contains('tools-mode')) {
    const t = state.tool || {};
    if (t.kind === 'paradise') renderParadise();
    else if (t.kind === 'sentiment') renderSentiment(t.data);
    else if (t.kind === 'trend') renderTrend(t.data);
  } else if (state.data) {
    if (state.data.kind === 'analytics') renderAnalytics(state.data);
    else render();
  }
}
function setupTheme() {
  syncThemeButton();
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true));
  try {   // 명시적 선택이 없으면 시스템 설정 변경을 따라감
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('ql-theme')) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  } catch (e) { /* 구형 브라우저 */ }
}

function wireControls() {
  document.getElementById('logscale').addEventListener('change', render);
  document.getElementById('start').addEventListener('change', () => { clearPresetActive(); render(); });
  document.getElementById('end').addEventListener('change', () => { clearPresetActive(); render(); });
  document.querySelectorAll('#presets button').forEach(b => {
    b.addEventListener('click', () => { setActivePreset(Number(b.dataset.years)); render(); });
  });
  // 성과표 리더보드 정렬 — 열 헤더 클릭(같은 열 재클릭 시 방향 토글).
  document.getElementById('metrics-table').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th || !state.data || state.data.kind === 'analytics') return;
    const col = th.dataset.col;
    if (state.sort.col === col) state.sort.dir *= -1;
    else state.sort = { col, dir: (col === '이름' ? 1 : -1) };
    render();
  });
}
function clearPresetActive() {
  document.querySelectorAll('#presets button').forEach(b => b.classList.remove('active'));
}

// ---------------------------------------------------------------------------
// 3축 네비 (카테고리 → 그룹 → 통화 토글)
// ---------------------------------------------------------------------------
const CAT_ORDER = { dynamic: 0, static: 1, momentum: 2, crypto: 3, analytics: 4, compare: 5,
  paradise: 6, sentiment: 7, trend: 8 };
const CAT_LABEL_NAV = { dynamic: '동적 자산배분', static: '정적 자산배분', momentum: '모멘텀',
  crypto: '코인', analytics: '정량분석', compare: '전략 비교',
  paradise: '낙원계산기', sentiment: '시장 심리', trend: '추세 경보' };
// 2단 대분류: 자산배분(8자산) / 개별전략(코인·모멘텀) / 도구·지표(계산기·심리·경보).
const SUPER_OF = { dynamic: 'alloc', static: 'alloc', analytics: 'alloc', compare: 'alloc',
  momentum: 'strat', crypto: 'strat',
  paradise: 'tools', sentiment: 'tools', trend: 'tools' };
const SUPER_ORDER = { alloc: 0, strat: 1, tools: 2 };
const SUPER_LABEL = { alloc: '자산배분', strat: '개별전략', tools: '도구·지표' };

function catsPresent() {
  return [...new Set(state.manifest.map(m => m.category))]
    .sort((a, b) => (CAT_ORDER[a] ?? 9) - (CAT_ORDER[b] ?? 9));
}
function supersPresent() {
  return [...new Set(state.manifest.map(m => SUPER_OF[m.category] || 'etc'))]
    .sort((a, b) => (SUPER_ORDER[a] ?? 9) - (SUPER_ORDER[b] ?? 9));
}
function catsInSuper(sup) {
  return catsPresent().filter(c => (SUPER_OF[c] || 'etc') === sup);
}
function groupsIn(cat) {
  const out = [];
  state.manifest.forEach(m => { if (m.category === cat && !out.includes(m.group)) out.push(m.group); });
  return out;
}
function currenciesFor(cat, g) {
  return state.manifest.filter(m => m.category === cat && m.group === g).map(m => m.currency);
}
function pickCurrency(cat, g) {
  const cs = currenciesFor(cat, g);
  for (const p of ['krw', 'usd', '']) if (cs.includes(p)) return p;
  return cs[0] || '';
}
function resolveEntry(cat, g, cur) {
  const c = state.manifest.filter(m => m.category === cat && m.group === g);
  return c.find(m => m.currency === cur) || c[0];
}

function buildNav() {
  if (!state.manifest.length) {
    setStatus('표시할 데이터셋이 없습니다. build_dashboard.py 를 먼저 실행하세요.', true);
    return;
  }
  const sups = supersPresent();
  document.getElementById('super-tabs').innerHTML =
    sups.map(s => `<button type="button" data-super="${s}">${SUPER_LABEL[s] || s}</button>`).join('');
  document.querySelectorAll('#super-tabs button').forEach(
    b => b.addEventListener('click', () => setSuperCategory(b.dataset.super)));
  document.getElementById('group').addEventListener('change', e => setGroup(e.target.value));
  document.querySelectorAll('#cur-toggle button').forEach(
    b => b.addEventListener('click', () => setCurrency(b.dataset.cur)));
  setSuperCategory(sups[0]);
}
function setSuperCategory(sup) {
  state.nav.super = sup;
  document.querySelectorAll('#super-tabs button').forEach(b => b.classList.toggle('active', b.dataset.super === sup));
  const cats = catsInSuper(sup);
  document.getElementById('cat-tabs').innerHTML =
    cats.map(c => `<button type="button" data-cat="${c}">${CAT_LABEL_NAV[c] || c}</button>`).join('');
  document.querySelectorAll('#cat-tabs button').forEach(
    b => b.addEventListener('click', () => setCategory(b.dataset.cat)));
  setCategory(cats[0]);
}
function setCategory(cat) {
  state.nav.category = cat;
  document.querySelectorAll('#cat-tabs button').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
  const groups = groupsIn(cat);
  document.getElementById('group').innerHTML =
    groups.map(g => `<option value="${g}">${g}</option>`).join('');
  setGroup(groups[0]);
}
function setGroup(g) {
  state.nav.group = g;
  document.getElementById('group').value = g;
  setCurrency(pickCurrency(state.nav.category, g));
}
function setCurrency(cur) {
  const avail = currenciesFor(state.nav.category, state.nav.group);
  if (!avail.includes(cur)) cur = pickCurrency(state.nav.category, state.nav.group);
  state.nav.currency = cur;
  document.querySelectorAll('#cur-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.cur === cur);
    b.disabled = !avail.includes(b.dataset.cur);
  });
  const entry = resolveEntry(state.nav.category, state.nav.group, cur);
  if (!entry) return;
  // 도구·지표: 낙원계산기(클라이언트)·시장심리/추세경보(JSON 로드) — mode 분기.
  if (entry.mode === 'paradise') return enterParadise();
  if (entry.mode === 'sentiment' || entry.mode === 'trend') return loadTool(entry, entry.mode);
  // 플레이그라운드: 통화 토글 시 재fetch/재빌드 없이 현 비중으로 재실행(통화만 변경).
  if (entry.mode === 'playground' && state.playground && state.panel) runPlayground();
  else if (entry.files) loadMultiDatasets(entry.files, entry.label);   // 전략 비교(다중 오버레이)
  else loadDataset(entry.file);
}

// ---------------------------------------------------------------------------
// 정량분석 뷰 (kind=analytics) — 위험수익 카드·상관 히트맵·효율적 프론티어·리스크패리티.
// rebalancer AnalyticsPage 이식. 8자산 월수익(빌드타임 계산) JSON 로드 → Plotly.
// body.analytics-mode 토글로 백테스트 섹션을 숨기고 분석 섹션만 표시한다.
// ---------------------------------------------------------------------------
function setAnalyticsMode(on) {
  document.body.classList.toggle('analytics-mode', !!on);
  if (on) setToolsMode(false);
}
function setToolsMode(on, tool) {                 // 도구·지표 전용 뷰(백테스트 섹션 숨김)
  document.body.classList.toggle('tools-mode', !!on);
  if (on) document.body.classList.remove('analytics-mode');
  ['paradise', 'sentiment', 'trend'].forEach(t => {
    const el = document.getElementById(t + '-section');
    if (el) el.classList.toggle('hidden', !(on && t === tool));
  });
}
function _apct(x, dp = 1) { return (x === null || x === undefined || isNaN(x)) ? '–' : (x * 100).toFixed(dp) + '%'; }
function _anum(x, dp = 2) { return (x === null || x === undefined || isNaN(x)) ? '–' : (+x).toFixed(dp); }

// ---------------------------------------------------------------------------
// 도구·지표: 낙원계산기 / 시장 심리 / 추세 경보
// ---------------------------------------------------------------------------
function _krwCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e8) return s + (a / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '억';
  if (a >= 1e4) return s + Math.round(a / 1e4).toLocaleString('ko-KR') + '만';
  return Math.round(n).toLocaleString('ko-KR') + '원';
}
function _pgv(id, def) { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? def : v; }

// 낙원계산기 — ParadisePage.tsx compute 이식 (keep-ones.me/#/paradise-calculator2 참고).
function enterParadise() {
  state.playground = false; state.data = null; state.tool = { kind: 'paradise' };
  setToolsMode(true, 'paradise');
  document.getElementById('meta').textContent = '낙원계산기 · keep-ones.me 참고';
  setStatus('');
  if (!state._paraWired) {
    ['para-asset', 'para-save', 'para-years', 'para-nom', 'para-infl'].forEach(id =>
      document.getElementById(id).addEventListener('input', renderParadise));
    state._paraWired = true;
  }
  renderParadise();
}
function renderParadise() {
  const start = _pgv('para-asset', 0), save = _pgv('para-save', 18000000);
  const years = Math.max(1, Math.round(_pgv('para-years', 20)));
  const r = 1 + _pgv('para-nom', 10) / 100, g = 1 + _pgv('para-infl', 2.5) / 100;
  const realRate = g > 0 ? r / g - 1 : r - g;
  const xs = [], assetSeq = [], saveSeq = [];
  for (let n = 1; n <= years; n++) {
    xs.push(n);
    assetSeq.push(start * Math.pow(r, n));
    saveSeq.push(Math.abs(r - g) < 1e-9 ? save * n * Math.pow(r, n - 1)
      : save * (Math.pow(r, n) - Math.pow(g, n)) / (r - g));
  }
  const endAsset = (assetSeq[years - 1] || start) + (saveSeq[years - 1] || 0);
  const todayPP = endAsset / Math.pow(g, years);
  const monthly = todayPP * realRate / 12;
  document.getElementById('para-results').innerHTML =
    [['은퇴 후 자산 (명목)', _krwCompact(endAsset)], ['오늘 가치 환산', _krwCompact(todayPP)],
     ['월 수입 (오늘 가치)', _krwCompact(monthly)], ['실질 수익률', (realRate * 100).toFixed(2) + '%']]
    .map(([k, v]) => `<div class="ext-card"><div class="lab">${k}</div><div class="val">${v}</div></div>`).join('');
  const muted = cssVar('--chart-muted');
  const layout = baseLayout('총 자산 증가 추이', '자산 (원)');
  layout.barmode = 'stack';
  layout.xaxis = { title: { text: '연차', font: { color: muted } }, gridcolor: cssVar('--chart-grid'), tickfont: { color: muted } };
  Plotly.react('para-chart', [
    { type: 'bar', name: '자산 성장', x: xs, y: assetSeq, marker: { color: '#2563eb' } },
    { type: 'bar', name: '저축 누적', x: xs, y: saveSeq, marker: { color: '#10b981' } },
  ], layout, PLOTCFG);
}

async function loadTool(entry, kind) {
  setToolsMode(true, kind);
  state.playground = false; state.data = null;
  setStatus('불러오는 중…');
  try {
    const d = await fetch('data/' + entry.file, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    state.tool = { kind, data: d };
    setStatus('');
    document.getElementById('meta').textContent = `${entry.group} · 생성일 ${d.generated_at || '-'}`;
    if (kind === 'sentiment') renderSentiment(d); else renderTrend(d);
  } catch (e) { setStatus(entry.group + ' 로딩 실패: ' + e.message, true); }
}

function _fgClass(v) { if (v == null) return null; return v <= 24 ? ['극단적 공포', '#dc2626'] : v <= 44 ? ['공포', '#ea580c'] : v <= 55 ? ['중립', '#6b7280'] : v <= 74 ? ['탐욕', '#84cc16'] : ['극단적 탐욕', '#10b981']; }
function _vixClass(v) { if (v == null) return null; return v < 15 ? ['평온', '#10b981'] : v < 20 ? ['정상', '#84cc16'] : v < 30 ? ['불안', '#ea580c'] : v < 40 ? ['공포', '#dc2626'] : ['패닉', '#991b1b']; }
function _kimchiClass(p) { if (p == null) return null; return p >= 20 ? ['극단적 과열', '#991b1b'] : p >= 15 ? ['과열', '#dc2626'] : p >= 10 ? ['약간 높음', '#ea580c'] : p > -10 ? ['정상', '#6b7280'] : p > -15 ? ['약간 낮음', '#84cc16'] : p > -20 ? ['역김프', '#10b981'] : ['극단적 역김프', '#14b8a6']; }
const SIG_COLOR = { red: '#dc2626', yellow: '#eab308', green: '#16a34a', na: '#9ca3af' };

function renderSentiment(d) {
  const cards = [];
  const gauge = (title, val, cls, sub) => {
    const col = cls ? cls[1] : 'var(--fg)', lab = cls ? cls[0] : '';
    cards.push(`<div class="senti-card"><div class="senti-t">${title}</div>` +
      `<div class="senti-v" style="color:${col}">${val}</div>` +
      `<div class="senti-l" style="color:${col}">${lab}</div>` +
      (sub ? `<div class="senti-s">${sub}</div>` : '') + `</div>`);
  };
  if (d.cnn_fg) gauge('CNN 공포·탐욕', _anum(d.cnn_fg.score, 0), _fgClass(d.cnn_fg.score),
    `${d.cnn_fg.rating || ''} · 1달전 ${_anum(d.cnn_fg.previous_1_month, 0)}`);
  if (d.crypto_fg) gauge('크립토 공포·탐욕', d.crypto_fg.value, _fgClass(d.crypto_fg.value), d.crypto_fg.classification);
  gauge('VIX 변동성', _anum(d.vix), _vixClass(d.vix), 'S&P500 내재변동성');
  gauge('달러 인덱스 (DXY)', _anum(d.dxy), null, '6통화 대비 달러');
  gauge('금/은 비율', _anum(d.gold_silver_ratio), null, `금 $${_anum(d.gold, 0)} · 은 $${_anum(d.silver)}`);
  if (d.btc_kimchi) gauge('비트코인 김프', _apct(d.btc_kimchi.premium_pct / 100), _kimchiClass(d.btc_kimchi.premium_pct),
    `업비트 ${_krwCompact(d.btc_kimchi.upbit_krw)}`);
  if (d.gold_kimchi) gauge('금 김프', _apct(d.gold_kimchi.premium_pct / 100), _kimchiClass(d.gold_kimchi.premium_pct), 'KRX 금 vs 국제');
  document.getElementById('senti-cards').innerHTML = cards.join('');
  const cf = d.crypto_fg;
  if (cf && cf.history && cf.history.length) {
    const h = [...cf.history].reverse();
    const x = h.map(p => new Date(p.timestamp * 1000).toISOString().slice(0, 10)), y = h.map(p => p.value);
    const layout = baseLayout('크립토 공포·탐욕 30일', '지수'); layout.yaxis.range = [0, 100];
    Plotly.react('senti-chart', [{ type: 'scatter', mode: 'lines', x, y, line: { color: '#9333ea', width: 2 } }], layout, PLOTCFG);
    setHidden('senti-chart', false);
  } else setHidden('senti-chart', true);
  const errs = Object.keys(d.errors || {});
  document.getElementById('senti-note').textContent = errs.length
    ? `미수신 지표: ${errs.join(', ')} (소스 일시 차단/지역제한 가능)` : '';
}

function renderTrend(d) {
  const SIGN = [['surge', '급등'], ['volume', '거래량'], ['consecutive', '연속상승'],
    ['gap_reversal', '갭반전'], ['ma200_distance', 'MA200이격'], ['ma30week', '30주선']];
  const order = d.order || Object.keys(d.assets || {});
  const head = '<thead><tr><th class="name">자산</th>' + SIGN.map(s => `<th>${s[1]}</th>`).join('') +
    '<th>경보</th><th>재진입</th></tr></thead>';
  const dot = sig => `<td style="text-align:center"><span class="sig-dot" style="background:${SIG_COLOR[sig] || SIG_COLOR.na}" title="${sig}"></span></td>`;
  const badge = (cls, txt) => `<td style="text-align:center"><span class="grade ${cls}">${txt}</span></td>`;
  const rows = order.filter(s => d.assets[s]).map(sym => {
    const a = d.assets[sym];
    const comp = a.composite === 'red' ? badge('low', '경보') : a.composite === 'yellow' ? badge('medium', '주의') : badge('high', '안전');
    const re = a.reentry === 'green' ? badge('high', '양호') : a.reentry === 'yellow' ? badge('medium', '중립') : badge('low', '미흡');
    return `<tr><td class="name">${a.label || sym}</td>` + SIGN.map(s => dot(a.signals[s[0]])).join('') + comp + re + '</tr>';
  }).join('');
  document.getElementById('trend-table').innerHTML = head + '<tbody>' + rows + '</tbody>';
  const errs = Object.keys(d.errors || {});
  document.getElementById('trend-meta').textContent =
    `기준일 ${d.as_of || '-'} · 6신호(급등·거래량·연속상승·갭반전·MA200이격·30주선) climax-top 분석. 정보용(투자권유 아님).`
    + (errs.length ? ` · 미수신: ${errs.join(', ')}` : '');
}

function enterAnalytics(d) {
  state.playground = false;
  state.data = d;
  setAnalyticsMode(true);
  document.getElementById('meta').textContent =
    `${d.title || '정량분석'} · 생성일 ${d.generated_at || '-'} · ${d.n_months || 0}개월`;
  renderAnalytics(d);
}

function renderAnalytics(d) {
  document.getElementById('an-period').textContent = d.period ? `· ${d.period}` : '';
  const note = document.getElementById('an-frontier-note');
  if (note && d.frontier) note.textContent =
    `long-only 랜덤 비중 ${(d.frontier.n_sims || 0).toLocaleString()}회 · ★ Max Sharpe · ◆ Min Variance · ● 단일자산 · ◇ 프리셋 (무위험 ${_apct(d.rf, 0)}).`;
  renderRiskReturn(d);
  renderCorrelation(d);
  renderFrontier(d);
  renderRiskParity(d);
  renderDescription();
}

function renderRiskReturn(d) {
  const html = (d.risk_return || []).map(r => {
    const col = r.color || 'var(--accent)';
    return `<div class="ext-card"><div class="lab"><span class="swatch" style="background:${col}"></span>${r.label}</div>` +
           `<div class="val">${_apct(r.ann_return)}</div>` +
           `<div class="sub">변동성 ${_apct(r.ann_vol)} · Sharpe ${_anum(r.sharpe)}</div>` +
           `<div class="sub">Sortino ${_anum(r.sortino)} · MDD ${_apct(-r.mdd)}</div></div>`;
  }).join('');
  document.getElementById('an-riskreturn').innerHTML = html;
}

function renderCorrelation(d) {
  const c = d.correlation || {}; const keys = c.assets || [];
  const labelOf = k => ((d.assets || []).find(a => a.key === k) || {}).label || k;
  const labels = keys.map(labelOf);
  const z = c.matrix || [];
  const text = z.map(row => row.map(v => (v === null || v === undefined) ? '' : v.toFixed(2)));
  const muted = cssVar('--chart-muted');
  const trace = {
    type: 'heatmap', z, x: labels, y: labels, text, texttemplate: '%{text}',
    textfont: { size: 11, color: '#0f172a' }, zmin: -1, zmax: 1, zmid: 0,
    colorscale: [[0, '#dc2626'], [0.25, '#fca5a5'], [0.5, '#f1f5f9'], [0.75, '#93c5fd'], [1, '#2563eb']],
    xgap: 2, ygap: 2, colorbar: { tickfont: { color: muted }, outlinewidth: 0, len: 0.92, thickness: 12 },
    hovertemplate: '%{y} · %{x}<br>상관 %{z:.2f}<extra></extra>',
  };
  const layout = baseLayout('', '');
  layout.margin = { l: 110, r: 10, t: 8, b: 100 };
  layout.xaxis = { tickfont: { color: muted, size: 10 }, tickangle: -40, automargin: true };
  layout.yaxis = { tickfont: { color: muted, size: 10 }, automargin: true, autorange: 'reversed' };
  delete layout.legend; layout.hovermode = 'closest';
  Plotly.react('an-corr', [trace], layout, PLOTCFG);
}

function renderFrontier(d) {
  const f = d.frontier || {}; const pts = f.points || [];
  const muted = cssVar('--chart-muted'), fg = cssVar('--chart-fg'), grid = cssVar('--chart-grid');
  const traces = [];
  traces.push({ type: 'scattergl', mode: 'markers', name: '시뮬', showlegend: false,
    x: pts.map(p => p[0] * 100), y: pts.map(p => p[1] * 100),
    marker: { size: 3, color: grid, opacity: 0.55 }, hoverinfo: 'skip' });
  const cv = f.curve || [];
  traces.push({ type: 'scatter', mode: 'lines', name: '효율적 경계',
    x: cv.map(p => p[0] * 100), y: cv.map(p => p[1] * 100),
    line: { color: muted, width: 1.5, dash: 'dot' }, hoverinfo: 'skip' });
  const sa = f.single_asset || [];
  traces.push({ type: 'scatter', mode: 'markers+text', name: '단일자산',
    x: sa.map(s => s.vol * 100), y: sa.map(s => s.ret * 100), text: sa.map(s => s.label),
    textposition: 'top center', textfont: { size: 9, color: muted },
    marker: { size: 9, color: sa.map(s => s.color || muted), line: { width: 1, color: cssVar('--chart-paper') } },
    hovertemplate: '%{text}<br>수익 %{y:.1f}% · 변동성 %{x:.1f}%<extra></extra>' });
  const pr = f.presets || [];
  traces.push({ type: 'scatter', mode: 'markers', name: '프리셋',
    x: pr.map(p => p.vol * 100), y: pr.map(p => p.ret * 100), text: pr.map(p => p.label),
    customdata: pr.map(p => p.sharpe),
    marker: { size: 11, symbol: 'diamond-open', color: cssVar('--accent'), line: { width: 1.5 } },
    hovertemplate: '%{text}<br>수익 %{y:.1f}% · 변동성 %{x:.1f}% · Sharpe %{customdata:.2f}<extra></extra>' });
  const ms = f.max_sharpe, mv = f.min_var;
  if (ms) traces.push({ type: 'scatter', mode: 'markers', name: 'Max Sharpe', x: [ms.vol * 100], y: [ms.ret * 100],
    marker: { size: 17, symbol: 'star', color: '#f59e0b', line: { width: 1, color: cssVar('--chart-paper') } },
    hovertemplate: 'Max Sharpe<br>수익 %{y:.1f}% · 변동성 %{x:.1f}%<extra></extra>' });
  if (mv) traces.push({ type: 'scatter', mode: 'markers', name: 'Min Variance', x: [mv.vol * 100], y: [mv.ret * 100],
    marker: { size: 13, symbol: 'diamond', color: '#10b981', line: { width: 1, color: cssVar('--chart-paper') } },
    hovertemplate: 'Min Variance<br>수익 %{y:.1f}% · 변동성 %{x:.1f}%<extra></extra>' });
  const layout = baseLayout('', '');
  layout.xaxis = { title: { text: '연환산 변동성 %', font: { color: muted } }, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted }, zeroline: false };
  layout.yaxis = { title: { text: '연환산 수익률 %', font: { color: muted } }, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted } };
  layout.hovermode = 'closest';
  layout.legend = { orientation: 'h', y: -0.16, font: { size: 10, color: fg } };
  Plotly.react('an-frontier', traces, layout, PLOTCFG);
}

function renderRiskParity(d) {
  const rows = d.risk_parity || [];
  let maxw = 0.01;
  for (const r of rows) maxw = Math.max(maxw, r.weight || 0, r.target || 0);
  const html = rows.map(r => {
    const col = r.color || 'var(--accent)';
    const w = (r.weight || 0) * 100, t = (r.target || 0) * 100;
    return `<div class="rp-row">` +
      `<span class="rp-lab"><span class="swatch" style="background:${col}"></span><span class="txt">${r.label}</span></span>` +
      `<span class="rp-track"><span class="rp-fill" style="width:${(r.weight / maxw * 100).toFixed(1)}%;background:${col}"></span>` +
      `<span class="rp-target" style="left:${Math.min(100, r.target / maxw * 100).toFixed(1)}%" title="목표 ${t.toFixed(1)}%"></span></span>` +
      `<span class="rp-nums"><b>${w.toFixed(1)}%</b> vs ${t.toFixed(1)}%</span></div>`;
  }).join('');
  document.getElementById('an-riskparity').innerHTML = html;
}

async function loadMultiDatasets(files, title) {
  setStatus('여러 데이터셋 불러오는 중…');
  setAnalyticsMode(false); setToolsMode(false);
  state.playground = false; setHidden('playground', true);
  try {
    const ds = await Promise.all(files.map(f =>
      fetch('data/' + f, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })));
    const base = ds[0];
    const merged = {
      schema_version: 1, title: title || '전략 비교', freq: base.freq,
      periods_per_year: base.periods_per_year, generated_at: base.generated_at,
      full_period_only_cols: base.full_period_only_cols || [], table_columns: base.table_columns,
      pct_cols: base.pct_cols, ratio_cols: base.ratio_cols, metric_to_col: base.metric_to_col,
      series: [], table_display: {}, metrics_raw: {},
    };
    for (const d of ds) {
      for (const s of (d.series || [])) {
        if (merged.series.some(x => x.name === s.name)) continue;   // 이름 중복(벤치마크) 1회만
        merged.series.push(s);
      }
      Object.assign(merged.table_display, d.table_display || {});
      Object.assign(merged.metrics_raw, d.metrics_raw || {});
    }
    state.data = merged;
    state.colToMetric = buildColToMetric(merged);
    buildStrategyList(merged);
    setGlobalRange(merged);
    setActivePreset(0);
    document.getElementById('meta').textContent = `${merged.title} · ${merged.series.length}개 시리즈 오버레이`;
    setStatus('');
    render();
  } catch (err) {
    setStatus('전략 비교 로딩 실패: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// 플레이그라운드 (임의 비중 즉석 백테스트 — web/alloc.js 엔진)
// ---------------------------------------------------------------------------
const STD_COLS = ['기간', 'CAGR', '연변동성', 'Sharpe', 'Sortino', 'MDD', 'Calmar', '월승률', '총수익'];
const STD_PCT = ['CAGR', '연변동성', 'MDD', '월승률', '총수익'];
const STD_RATIO = ['Sharpe', 'Sortino', 'Calmar'];
const STD_M2C = { CAGR: 'CAGR', ann_vol: '연변동성', sharpe: 'Sharpe', sortino: 'Sortino',
                  mdd: 'MDD', calmar: 'Calmar', win_rate: '월승률', total: '총수익' };

function _synthDataset(curves, title) {
  // curves: [{name, dates, nav}] → app.js 표준 데이터셋(table_display/metrics_raw 계산).
  const series = [], table_display = {}, metrics_raw = {};
  for (const c of curves) {
    const nav = c.nav, dates = c.dates;
    series.push({ name: c.name, period: `${dates[0]}~${dates[dates.length - 1]}`, dates, nav });
    const mm = computeMetrics(dates, nav, 12);
    metrics_raw[c.name] = mm;
    table_display[c.name] = {
      '기간': `${dates[0]}~${dates[dates.length - 1]}`,
      'CAGR': mm.CAGR * 100, '연변동성': mm.ann_vol * 100, 'Sharpe': mm.sharpe,
      'Sortino': mm.sortino, 'MDD': mm.mdd * 100, 'Calmar': mm.calmar,
      '월승률': mm.win_rate * 100, '총수익': mm.total * 100,
    };
  }
  return {
    schema_version: 1, title, freq: 'M', periods_per_year: 12,
    generated_at: '', full_period_only_cols: [], table_columns: STD_COLS,
    pct_cols: STD_PCT, ratio_cols: STD_RATIO, metric_to_col: STD_M2C,
    series, table_display, metrics_raw,
  };
}

function enterPlayground(panel) {
  setAnalyticsMode(false); setToolsMode(false);
  state.playground = true;
  state.panel = panel;
  setHidden('playground', false);
  // 프리셋 버튼
  document.getElementById('pg-presets').innerHTML = Object.entries(panel.presets || {})
    .map(([k, p]) => `<button type="button" data-preset="${k}">${p.label}</button>`).join('');
  // 비중 입력 (기본값 = default_weights)
  const dw = panel.default_weights || {};
  document.getElementById('pg-weights').innerHTML = panel.assets.map((a, j) => {
    const col = CAT_COLOR[a.id] || PALETTE[j % PALETTE.length];
    const v = ((dw[a.id] || 0) * 100).toFixed(1);
    return `<label class="pg-w"><span class="swatch" style="background:${col}"></span>${a.label}` +
           `<input type="number" data-asset="${a.id}" min="0" max="100" step="0.5" value="${v}" /></label>`;
  }).join('');
  // 리밸런싱 옵션
  const RMODE = { never: '없음(Buy&Hold)', monthly: '월', quarterly: '분기', semiannual: '반기', yearly: '연' };
  document.getElementById('pg-rebalance').innerHTML = (panel.rebalance_modes || ['quarterly'])
    .map(r => `<option value="${r}"${r === 'quarterly' ? ' selected' : ''}>${RMODE[r] || r}</option>`).join('');
  // 글로벌 기간 범위
  state.globalStart = panel.dates[0]; state.globalEnd = panel.dates[panel.dates.length - 1];
  const sEl = document.getElementById('start'), eEl = document.getElementById('end');
  sEl.min = state.globalStart; sEl.max = state.globalEnd; eEl.min = state.globalStart; eEl.max = state.globalEnd;
  sEl.value = state.globalStart; eEl.value = state.globalEnd;
  setActivePreset(0);
  // 핸들러 (1회 바인딩)
  if (!state._pgWired) {
    document.getElementById('pg-weights').addEventListener('input', runPlayground);
    document.getElementById('pg-rebalance').addEventListener('change', runPlayground);
    document.getElementById('pg-band').addEventListener('input', runPlayground);
    document.getElementById('pg-normalize').addEventListener('click', () => { _pgNormalize(); runPlayground(); });
    document.getElementById('pg-presets').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const p = state.panel.presets[b.dataset.preset]; if (!p) return;
      _pgSetWeights(p.weights); runPlayground();
    });
    state._pgWired = true;
  }
  document.getElementById('meta').textContent =
    `${panel.title || ''} · 생성일 ${panel.generated_at || '-'} · 사용자 입력 백테스트`;
  runPlayground();
}

function _pgWeightInputs() { return Array.from(document.querySelectorAll('#pg-weights input')); }
function _pgSetWeights(w) {
  _pgWeightInputs().forEach(inp => { inp.value = ((w[inp.dataset.asset] || 0) * 100).toFixed(1); });
}
function _pgNormalize() {
  const inps = _pgWeightInputs();
  let sum = 0; inps.forEach(i => { sum += parseFloat(i.value) || 0; });
  if (sum > 0) inps.forEach(i => { i.value = ((parseFloat(i.value) || 0) / sum * 100).toFixed(1); });
}
function runPlayground() {
  const panel = state.panel; if (!panel) return;
  const w = {}; let sum = 0;
  _pgWeightInputs().forEach(i => { const v = (parseFloat(i.value) || 0) / 100; w[i.dataset.asset] = v; sum += v; });
  document.getElementById('pg-sum').textContent = `합계 ${(sum * 100).toFixed(1)}%`;
  document.getElementById('pg-sum').className = 'pg-sum' + (Math.abs(sum - 1) <= 0.001 ? ' ok' : ' warn');
  const ids = panel.assets.map(a => a.id);
  const rebalance = document.getElementById('pg-rebalance').value;
  const band = (parseFloat(document.getElementById('pg-band').value) || 0) / 100;
  const res = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, w,
    { rebalance, bandRatio: band, costs: panel.costs });
  if (!res) { setStatus('선택한 자산의 공통 데이터가 부족합니다(비중>0 자산을 확인하세요).', true); return; }
  setStatus('');
  const ccy = state.nav.currency || 'krw';
  const fxWin = res.win.map(t => panel.fx[t]);
  const curves = [{ name: '내 배분', dates: res.dates, nav: ALLOC.navToCcy(res.navKrw, fxWin, ccy) }];
  for (const [name, b] of Object.entries(panel.benchmarks || {})) {
    const bc = ALLOC.benchCurve(b.price, b.ccy, panel.fx, ccy, res.win);
    curves.push({ name, dates: res.dates, nav: bc });
  }
  state.data = _synthDataset(curves, '사용자 배분');
  state.data.target_weights = res.weights;   // 정규화 비중 → 구성 표
  state.colToMetric = buildColToMetric(state.data);
  buildStrategyList(state.data);
  render();
}

async function init() {
  setupTheme();
  wireControls();
  try {
    const resp = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    state.manifest = await resp.json();
  } catch (err) {
    setStatus('manifest.json 로딩 실패: ' + err.message + ' (http 서버로 열어야 합니다)', true);
    return;
  }
  buildNav();
}

document.addEventListener('DOMContentLoaded', init);
