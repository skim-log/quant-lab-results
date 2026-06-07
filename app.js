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
  analyticsActive: false, analyticsPayload: null, _analyticsCur: null,   // 정량분석 기간조절 재계산(월수익 행렬 보관)
  explorerCtx: null, explorer: null, _expWired: false,   // 전략 탐색기(위험성향 슬라이더·내 비중 점)
  selectedAssets: [], _assetWired: false,                // 정량분석 분석 자산 선택(부분집합)
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

// MDD 열을 CAGR 바로 뒤로 재배치(가독성). 둘 다 있을 때만.
function _mddAfterCagr(cols) {
  if (!cols || !cols.includes('CAGR') || !cols.includes('MDD')) return cols;
  const c = cols.filter(x => x !== 'MDD');
  c.splice(c.indexOf('CAGR') + 1, 0, 'MDD');
  return c;
}
function renderTable(rows, fullPeriod) {
  const d = state.data;
  const cols = _mddAfterCagr(d.table_columns);
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
      if (col === '기간') return `<td data-label="기간">${r.period}</td>`;

      // 전체기간 → CSV(table_display) 값을 그대로 표시: 프로젝트 요약표와 100% 일치.
      // (KR 전략 행은 CSV가 엔진 내부 수익률로 계산 → NAV 재계산과 2dp에서 갈릴 수 있어
      //  헤드라인은 CSV 값을 신뢰원으로 사용.)
      if (fullPeriod) return `<td data-label="${col}">${fmtDisplay(col, disp[col])}</td>`;

      // 구간 선택 → NAV 기반 클라이언트 재계산(재정규화). 브라우저엔 NAV만 있다.
      const mkey = state.colToMetric[col];
      if (mkey) {
        const v = r.metrics[mkey];
        const txt = pct.has(col) ? fmtPct(v) : ratio.has(col) ? fmtRatio(v) : fmtPlain(v);
        return `<td data-label="${col}">${txt}</td>`;
      }
      // 구간에서는 재계산 불가(연회전율/XIRR/양도세 등) → —
      return `<td class="muted" data-label="${col}">—</td>`;
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
    return `<tr><td class="name">${lab}</td><td data-label="밴드 ON">${f(kind, on)}</td><td data-label="밴드 OFF">${f(kind, off)}</td>` +
           `<td class="${cls}" data-label="차이">${diffTxt}</td></tr>`;
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
    return `<tr><td class="name">${a.label || a.asset}</td><td data-label="신뢰도">${grade}</td>` +
           `<td data-label="실제 범위">${a.range || ''}</td><td class="muted" data-label="프록시">${proxy}</td><td class="muted" data-label="비고">${a.note || ''}</td></tr>`;
  }).join('');
  const assetTable = assetRows
    ? '<table class="diag-table"><thead><tr><th class="name">자산</th><th>신뢰도</th><th>실제 범위</th>' +
      '<th>프록시</th><th>비고</th></tr></thead><tbody>' + assetRows + '</tbody></table>'
    : '';
  const fx = (dg.fx_labels && dg.fx_labels.length)
    ? `<p class="diag-fx">USD/KRW 환율: <span class="muted">${dg.fx_labels.join(' + ')}</span></p>` : '';
  const errRows = (dg.error_rows || []).map(r =>
    `<tr><td class="name">${CAT_LABEL[r.asset] || r.asset}</td><td class="muted" data-label="주된 오차 원인">${r.cause}</td>` +
    `<td data-label="CAGR 오차">${r.cagr_err}</td><td class="muted" data-label="비고">${r.note || ''}</td></tr>`).join('');
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
    state.analyticsActive = false;
    if (d.kind === 'analytics') { setStatus(''); return enterAnalytics(d); }
    if (d.mode === 'playground') { setStatus(''); return enterPlayground(d); }
    setAnalyticsMode(false); setToolsMode(false);
    state.playground = false; state._analyticsCur = null;
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

function onPeriodChange() { if (state.analyticsActive) recomputeAnalytics(); else render(); }
function wireControls() {
  document.getElementById('logscale').addEventListener('change', render);
  document.getElementById('start').addEventListener('change', () => { clearPresetActive(); onPeriodChange(); });
  document.getElementById('end').addEventListener('change', () => { clearPresetActive(); onPeriodChange(); });
  document.querySelectorAll('#presets button').forEach(b => {
    b.addEventListener('click', () => { setActivePreset(Number(b.dataset.years)); onPeriodChange(); });
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
  paradise: 6, sentiment: 7, trend: 8, reliability: 9 };
const CAT_LABEL_NAV = { dynamic: '동적 자산배분', static: '정적 자산배분', momentum: '모멘텀',
  crypto: '코인', analytics: '정량분석', compare: '전략 비교',
  paradise: '낙원계산기', sentiment: '시장 심리', trend: '추세 경보', reliability: '데이터 정확도' };
// 2단 대분류: 자산배분(8자산) / 개별전략(코인·모멘텀) / 도구·지표(계산기·심리·경보·데이터정확도).
const SUPER_OF = { dynamic: 'alloc', static: 'alloc', analytics: 'alloc', compare: 'alloc',
  momentum: 'strat', crypto: 'strat',
  paradise: 'tools', sentiment: 'tools', trend: 'tools', reliability: 'tools' };
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
  // 도구·지표: 낙원계산기(클라이언트)·시장심리/추세경보/데이터정확도(JSON 로드) — mode 분기.
  if (entry.mode === 'paradise') return enterParadise();
  if (entry.mode === 'sentiment' || entry.mode === 'trend' || entry.mode === 'reliability')
    return loadTool(entry, entry.mode);
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
  ['paradise', 'sentiment', 'trend', 'reliability'].forEach(t => {
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
function _pgv(id, def) { const v = parseFloat(String(document.getElementById(id).value).replace(/,/g, '')); return isNaN(v) ? def : v; }

// 금액 입력칸: 입력 즉시 천단위 콤마 포맷(정수 won). 캐럿은 좌측 자릿수 기준으로 복원.
function _attachComma(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const caret = el.selectionStart || 0;
    const digitsLeft = el.value.slice(0, caret).replace(/[^\d]/g, '').length;
    const raw = el.value.replace(/[^\d]/g, '');
    el.value = raw === '' ? '' : parseInt(raw, 10).toLocaleString('en-US');
    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < digitsLeft) { if (/\d/.test(el.value[pos])) seen++; pos++; }
    el.setSelectionRange(pos, pos);
    if (onChange) onChange();
  });
}

// 낙원계산기 — ParadisePage.tsx compute 이식 (keep-ones.me/#/paradise-calculator2 참고).
function enterParadise() {
  state.playground = false; state.analyticsActive = false; state._analyticsCur = null; state.data = null; state.tool = { kind: 'paradise' };
  setToolsMode(true, 'paradise');
  document.getElementById('meta').textContent = '낙원계산기 · keep-ones.me 참고';
  setStatus('');
  if (!state._paraWired) {
    _attachComma('para-asset', renderParadise);
    _attachComma('para-save', renderParadise);
    ['para-years', 'para-nom', 'para-infl'].forEach(id =>
      document.getElementById(id).addEventListener('input', renderParadise));
    state._paraWired = true;
  }
  renderParadise();
}
function renderParadise() {
  const start = _pgv('para-asset', 0), save = _pgv('para-save', 18000000);
  const years = Math.max(1, Math.round(_pgv('para-years', 20)));
  const hint = document.getElementById('para-save-hint');
  if (hint) hint.textContent = `월 ${_krwCompact(save / 12)} × 12 · 매년 물가만큼 증가 가정`;
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
  state.playground = false; state.analyticsActive = false; state._analyticsCur = null; state.data = null;
  setStatus('불러오는 중…');
  try {
    const d = await fetch('data/' + entry.file, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    state.tool = { kind, data: d };
    setStatus('');
    document.getElementById('meta').textContent = `${entry.group} · 생성일 ${d.generated_at || '-'}`;
    if (kind === 'sentiment') renderSentiment(d);
    else if (kind === 'reliability') renderReliability(d);
    else renderTrend(d);
  } catch (e) { setStatus(entry.group + ' 로딩 실패: ' + e.message, true); }
}

// 시장심리 분류 (signals.py와 동일 임계·설명) — {l:라벨, c:색, d:설명}.
function _fgClass(v) { if (v == null) return null; return v <= 24 ? { l: '극단적 공포', c: '#dc2626', d: '시장에 강한 공포 — 종종 매수 기회' } : v <= 44 ? { l: '공포', c: '#ea580c', d: '투자자들이 위험을 회피 중' } : v <= 55 ? { l: '중립', c: '#6b7280', d: '균형 잡힌 시장 심리' } : v <= 74 ? { l: '탐욕', c: '#84cc16', d: '강한 매수 심리 — 주의 필요' } : { l: '극단적 탐욕', c: '#10b981', d: '시장 과열 — 종종 매도 기회' }; }
function _vixClass(v) { if (v == null) return null; return v < 15 ? { l: '평온', c: '#10b981', d: '시장 안정 / 변동성 낮음' } : v < 20 ? { l: '정상', c: '#84cc16', d: '평소 변동성 수준' } : v < 30 ? { l: '불안', c: '#ea580c', d: '변동성 상승 / 투자자 우려' } : v < 40 ? { l: '공포', c: '#dc2626', d: '큰 변동성 / 시장 스트레스' } : { l: '패닉', c: '#991b1b', d: '극단적 변동성 / 위기 상황' }; }
function _dxyClass(v) { if (v == null) return null; return v < 95 ? { l: '약달러', c: '#10b981', d: '위험자산(주식·코인) 유리' } : v < 105 ? { l: '정상 범위', c: '#6b7280', d: '평소 달러 강도' } : { l: '강달러', c: '#ea580c', d: '위험자산 부담 / Risk-off' }; }
function _gsrClass(v) { if (v == null) return null; return v < 50 ? { l: 'Silver 강세', c: '#10b981', d: '위험 선호 / 산업 수요 강함' } : v < 80 ? { l: '정상 범위', c: '#6b7280', d: '평소 금/은 비율' } : { l: 'Gold 강세', c: '#ea580c', d: '위험 회피 / 안전자산 선호' }; }
function _kimchiClass(p) { if (p == null) return null; return p >= 20 ? { l: '극단적 과열', c: '#991b1b', d: '한국 시장 매우 과열 — 매수 주의' } : p >= 15 ? { l: '과열', c: '#dc2626', d: '한국 매수세 강함' } : p >= 10 ? { l: '약간 높음', c: '#ea580c', d: '한국이 글로벌 대비 비쌈' } : p > -10 ? { l: '정상', c: '#6b7280', d: '글로벌과 동조' } : p > -15 ? { l: '약간 낮음', c: '#84cc16', d: '한국이 글로벌 대비 쌈' } : p > -20 ? { l: '역김프', c: '#10b981', d: 'Risk-off / 청산 압박' } : { l: '극단적 역김프', c: '#14b8a6', d: '한국 시장 매우 저평가' }; }
const SIG_COLOR = { red: '#dc2626', yellow: '#eab308', green: '#16a34a', na: '#9ca3af' };

// 공포·탐욕 게이지 바(0~100 그라디언트 + 현재값 바늘). cls={l,c,d}, subhtml=추가행.
function _fgGauge(title, value, cls, subhtml) {
  if (value == null || isNaN(value)) return '';
  const pct = Math.max(0, Math.min(100, value)), col = cls ? cls.c : 'var(--fg)';
  return `<div class="fg-gauge"><div class="fg-head"><span class="fg-title">${title}</span>` +
    `<span class="fg-val" style="color:${col}">${Math.round(value)}</span>` +
    `<span class="fg-lab" style="color:${col}">${cls ? cls.l : ''}</span></div>` +
    `<div class="fg-bar"><span class="fg-needle" style="left:${pct}%"></span></div>` +
    `<div class="fg-scale"><span>0 극공포</span><span>25</span><span>50 중립</span><span>75</span><span>100 극탐욕</span></div>` +
    (cls && cls.d ? `<div class="fg-desc">${cls.d}</div>` : '') + (subhtml || '') + `</div>`;
}

function renderSentiment(d) {
  // ① CNN·크립토 공포탐욕 게이지 바 (+ CNN 이전값 그리드)
  let fg = '';
  if (d.cnn_fg && d.cnn_fg.score != null) {
    const prev = [['전일', d.cnn_fg.previous_close], ['1주전', d.cnn_fg.previous_1_week], ['1달전', d.cnn_fg.previous_1_month]]
      .filter(([, v]) => v != null).map(([k, v]) => `<span><b>${_anum(v, 0)}</b> ${k}</span>`).join('');
    fg += _fgGauge('CNN 공포·탐욕', d.cnn_fg.score, _fgClass(d.cnn_fg.score),
      `<div class="fg-prev">🇺🇸 미국 주식${d.cnn_fg.rating ? ' · ' + d.cnn_fg.rating : ''}${prev ? ' · ' + prev : ''}</div>`);
  }
  if (d.crypto_fg && d.crypto_fg.value != null) {
    fg += _fgGauge('크립토 공포·탐욕', d.crypto_fg.value, _fgClass(d.crypto_fg.value),
      `<div class="fg-prev">🪙 코인${d.crypto_fg.classification ? ' · ' + d.crypto_fg.classification : ''}</div>`);
  }
  document.getElementById('senti-fg').innerHTML = fg;

  // ② 크립토 공포탐욕 30일 추이 (컬러 존 배경)
  const cf = d.crypto_fg;
  if (cf && cf.history && cf.history.length) {
    const h = [...cf.history].reverse();
    const x = h.map(p => new Date(p.timestamp * 1000).toISOString().slice(0, 10)), y = h.map(p => p.value);
    const layout = baseLayout('크립토 공포·탐욕 30일', '지수'); layout.yaxis.range = [0, 100];
    const zones = [[0, 25, '#dc2626'], [25, 45, '#ea580c'], [45, 55, '#6b7280'], [55, 75, '#84cc16'], [75, 100, '#10b981']];
    layout.shapes = zones.map(([y0, y1, c]) => ({ type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0, y1, fillcolor: c, opacity: 0.12, line: { width: 0 }, layer: 'below' }));
    Plotly.react('senti-chart', [{ type: 'scatter', mode: 'lines', x, y, line: { color: cssVar('--chart-fg'), width: 2 } }], layout, PLOTCFG);
    setHidden('senti-chart', false);
  } else setHidden('senti-chart', true);

  // ③ VIX·DXY·금/은비·김프 카드 (색·라벨·설명·임계)
  const cards = [];
  const card = (title, val, cls, hint, thresh) => {
    const col = cls ? cls.c : 'var(--fg)';
    cards.push(`<div class="senti-card"><div class="senti-t">${title}</div>` +
      `<div class="senti-v" style="color:${col}">${val}</div>` +
      `<div class="senti-l" style="color:${col}">${cls ? cls.l : ''}</div>` +
      (cls && cls.d ? `<div class="senti-s">${cls.d}</div>` : (hint ? `<div class="senti-s">${hint}</div>` : '')) +
      (thresh ? `<div class="senti-th">${thresh}</div>` : '') + `</div>`);
  };
  card('VIX 변동성', _anum(d.vix), _vixClass(d.vix), 'S&P500 향후 30일 내재변동성', '평온&lt;15 · 정상15-20 · 불안20-30 · 공포30-40 · 패닉≥40');
  card('달러 인덱스 (DXY)', _anum(d.dxy), _dxyClass(d.dxy), '6통화 대비 달러 강도', '약달러&lt;95 · 정상95-105 · 강달러≥105');
  card('금/은 비율', _anum(d.gold_silver_ratio), _gsrClass(d.gold_silver_ratio), `금 $${_anum(d.gold, 0)} · 은 $${_anum(d.silver)}`, 'Silver&lt;50 · 정상50-80 · Gold≥80(위험회피)');
  if (d.btc_kimchi) card('비트코인 김프', _apct(d.btc_kimchi.premium_pct / 100), _kimchiClass(d.btc_kimchi.premium_pct), `업비트 ${_krwCompact(d.btc_kimchi.upbit_krw)}`, '정상|값|&lt;10% · 과열15-20% · 극단≥20%');
  if (d.gold_kimchi) card('금 김프', _apct(d.gold_kimchi.premium_pct / 100), _kimchiClass(d.gold_kimchi.premium_pct), 'KRX 금 vs 국제(USD 환산)', '양수=한국이 비쌈');
  document.getElementById('senti-cards').innerHTML = cards.join('');

  const errs = Object.keys(d.errors || {});
  document.getElementById('senti-note').textContent = errs.length
    ? `미수신 지표: ${errs.join(', ')} (소스 일시 차단/지역제한 가능 — best-effort)` : '';
}

const TREND_CT = [
  ['surge', '급등', '3주(15거래일) 종가 변화율 — 15%/25% 임계'],
  ['volume', '거래량', '최근 5일 평균 / 이전 45일 평균 — 1.5×/2.5× 임계'],
  ['consecutive', '연속상승', '최근 10거래일 중 상승일 수 — 6/8 임계'],
  ['gap_reversal', '갭반전', '갭상승 후 전일저가 이탈 횟수(10일) — 1/2회 임계'],
  ['ma200_distance', 'MA200이격', '200일선 대비 이격도 — +30%/+70% 임계'],
  ['ma30week', '30주선', '150일선 대비 위치(Stage 분석) — ±2% 임계']];
const TREND_RE = [
  ['ma30_slope', '30주↗', '30주선(150MA) 4주 슬로프 — 전환구간 +0.3~+2.0% 🟢'],
  ['ma30_position', '30주위', '30주선 대비 위치 — 방금 돌파 0~+10% 🟢'],
  ['base_width', '베이스', '8주 베이스 폭 (max−min)/min — ≤15% 🟢'],
  ['from_low52w', '저점', '52주 저점 대비 — +20~+50% 🟢'],
  ['breakout_volume', '거래량', 'Breakout 거래량 5일/직전20일 — ≥1.5× 🟢'],
  ['ma200_slope', '200d↗', '200일선 4주 슬로프 — +0.3~+1.5% 🟢']];

function _trendDot(sig, lab) {
  return `<td data-label="${lab}" style="text-align:center"><span class="sig-dot" style="background:${SIG_COLOR[sig] || SIG_COLOR.na}" title="${sig}"></span></td>`;
}
function _trendBadge(cls, txt, lab) {
  return `<td data-label="${lab}" style="text-align:center"><span class="grade ${cls}">${txt}</span></td>`;
}
function _trendTableHTML(order, assets, SIGN, getSignals, compHead, compCell) {
  const head = '<thead><tr><th class="name">자산</th>' + SIGN.map(s => `<th title="${s[2]}">${s[1]}</th>`).join('') + compHead + '</tr></thead>';
  const rows = order.filter(s => assets[s]).map(sym => {
    const a = assets[sym], sigs = getSignals(a) || {};
    return `<tr><td class="name" data-label="자산">${a.label || sym}</td>` +
      SIGN.map(s => _trendDot(sigs[s[0]], s[1])).join('') + compCell(a) + '</tr>';
  }).join('');
  return head + '<tbody>' + rows + '</tbody>';
}

function renderTrend(d) {
  const order = d.order || Object.keys(d.assets || {});
  // 천장(매도) 표 — 6신호 + 경보
  document.getElementById('trend-table').innerHTML = _trendTableHTML(order, d.assets, TREND_CT,
    a => a.signals,
    '<th title="빨간 신호 개수: 0개 🟢 안전 / 1~2개 🟡 주의 / 3개+ 🔴 경보">경보</th>',
    a => a.composite === 'red' ? _trendBadge('low', '경보', '경보')
      : a.composite === 'yellow' ? _trendBadge('medium', '주의', '경보') : _trendBadge('high', '안전', '경보'));
  // 재진입(매수) 표 — Stage-2 6신호 + 종합
  const ret = document.getElementById('trend-reentry-table');
  if (ret) ret.innerHTML = _trendTableHTML(order, d.assets, TREND_RE,
    a => (a.reentry && a.reentry.signals) || {},
    '<th title="초록 신호 개수: 3개+ 🟢 재진입 영역 / 1~2개 🟡 / 0개 🔴">종합</th>',
    a => { const r = (a.reentry && a.reentry.composite) || 'na'; return r === 'green' ? _trendBadge('high', '재진입', '종합')
      : r === 'yellow' ? _trendBadge('medium', '관찰', '종합') : _trendBadge('low', '아직', '종합'); });
  const errs = Object.keys(d.errors || {});
  document.getElementById('trend-meta').textContent =
    `기준일 ${d.as_of || '-'} · 천장(매도)·재진입(매수) 각 6신호. 정보용(투자권유 아님).`
    + (errs.length ? ` · 미수신: ${errs.join(', ')}` : '');
  setupBacktest(d);
}

// ── 시그널 정확도 백테스트 (사전계산 결과 렌더; 모드 토글 + 자산 드롭다운) ──
function setupBacktest(d) {
  const bt = d.backtest || {};
  const sel = document.getElementById('bt-asset');
  if (!sel) return;
  const syms = (d.order || Object.keys(bt)).filter(s => bt[s]);
  if (!syms.length) { setHidden('backtest-block', true); return; }
  setHidden('backtest-block', false);
  sel.innerHTML = syms.map(s => `<option value="${s}">${bt[s].label || s}</option>`).join('');
  if (!state.trendBt || !bt[state.trendBt.sym]) state.trendBt = { sym: syms[0], mode: 'climax_top' };
  sel.value = state.trendBt.sym;
  document.querySelectorAll('#bt-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.trendBt.mode));
  state._btData = d;
  if (!state._btWired) {
    sel.addEventListener('change', () => { state.trendBt.sym = sel.value; renderBacktest(); });
    document.querySelectorAll('#bt-mode button').forEach(b => b.addEventListener('click', () => {
      state.trendBt.mode = b.dataset.mode;
      document.querySelectorAll('#bt-mode button').forEach(x => x.classList.toggle('active', x === b));
      renderBacktest();
    }));
    state._btWired = true;
  }
  renderBacktest();
}

function renderBacktest() {
  const d = state._btData; if (!d) return;
  const { sym, mode } = state.trendBt;
  const rep = ((d.backtest || {})[sym] || {})[mode];
  if (!rep) return;
  const isCT = mode === 'climax_top', markColor = isCT ? '#dc2626' : '#16a34a';
  const ps = rep.price_series || [], trigs = ps.filter(p => p.triggered);
  const traces = [
    { type: 'scatter', mode: 'lines', name: '종가', x: ps.map(p => p.date), y: ps.map(p => p.close),
      line: { color: cssVar('--chart-muted'), width: 1.3 }, hoverinfo: 'skip' },
    { type: 'scatter', mode: 'markers', name: isCT ? '천장 신호' : '바닥 신호',
      x: trigs.map(p => p.date), y: trigs.map(p => p.close),
      marker: { size: 10, color: markColor, symbol: isCT ? 'triangle-down' : 'triangle-up', line: { width: 1, color: cssVar('--chart-paper') } },
      hovertemplate: '%{x}<br>%{y}<extra></extra>' },
  ];
  const layout = baseLayout('', '종가 (로그)'); layout.yaxis.type = 'log';
  layout.legend = { orientation: 'h', y: -0.18, font: { size: 10, color: cssVar('--chart-fg') } };
  Plotly.react('bt-chart', traces, layout, PLOTCFG);

  const s = rep.summary || {}, H = ['d20', 'd60', 'd120', 'd250'], HL = ['+20일', '+60일', '+120일', '+250일'];
  const srow = (label, obj) => `<tr><td class="name" data-label="구분">${label}</td>` +
    H.map((h, i) => `<td data-label="${HL[i]}">${_apct(obj[h])}</td>`).join('') + '</tr>';
  const hr = s.hit_rate || {};
  document.getElementById('bt-summary').innerHTML =
    '<thead><tr><th class="name">구분</th>' + HL.map(l => `<th>${l}</th>`).join('') + '</tr></thead><tbody>' +
    srow('신호 평균 수익', s.trigger_avg_fwd || {}) + srow('베이스라인 평균', s.baseline_avg_fwd || {}) +
    `<tr><td class="name" data-label="구분">${isCT ? '적중률 (≤−5/−10%)' : '적중률 (≥+5/+10%)'}</td>` +
    `<td data-label="+20일">${_apct(hr.d20)}</td><td data-label="+60일">${_apct(hr.d60)}</td>` +
    `<td data-label="+120일">${_apct(hr.d120)}</td><td data-label="+250일">–</td></tr></tbody>`;

  const evs = (rep.events || []).slice().reverse();
  document.getElementById('bt-events').innerHTML =
    '<thead><tr><th class="name">날짜</th><th>신호</th><th>+20일</th><th>+60일</th><th>+120일</th><th>+250일</th></tr></thead><tbody>' +
    (evs.length ? evs.map(e => `<tr><td class="name" data-label="날짜">${e.date}</td>` +
      `<td data-label="신호">${e.trigger_count}/6 ${(e.trigger_labels || []).join('')}</td>` +
      `<td data-label="+20일">${_apct(e.fwd.d20)}</td><td data-label="+60일">${_apct(e.fwd.d60)}</td>` +
      `<td data-label="+120일">${_apct(e.fwd.d120)}</td><td data-label="+250일">${_apct(e.fwd.d250)}</td></tr>`).join('')
      : '<tr><td class="muted" colspan="6">트리거 이벤트 없음 (표본 부족 또는 신호 미발생)</td></tr>') + '</tbody>';

  const meta = document.getElementById('bt-meta');
  if (meta) meta.textContent = `${rep.start_date}~${rep.end_date} · 평가 ${rep.evaluated_days}일 · 트리거 ${s.total_triggers || 0}건 · ` +
    (isCT ? '🔴 천장: 신호 평균이 베이스라인보다 낮을수록(음수) 적중' : '🟢 바닥: 신호 평균이 베이스라인보다 높을수록(양수) 적중');
}

function enterAnalytics(payload) {
  state.playground = false;
  setAnalyticsMode(true);
  // 폴백: returns 미동봉(구 JSON)이거나 엔진 미로드 → 사전계산 그대로(기간 고정).
  if (!payload.returns || !payload.dates || typeof ANALYTICS === 'undefined') {
    state.analyticsActive = false; state.analyticsPayload = null; state.data = payload;
    document.getElementById('meta').textContent =
      `${payload.title || '정량분석'} · 생성일 ${payload.generated_at || '-'} · ${payload.n_months || 0}개월`;
    renderAnalytics(payload); return;
  }
  // 인터랙티브: 월수익 행렬을 보관하고 선택 구간을 브라우저에서 즉석 재계산.
  const wasAnalytics = state._analyticsCur != null;     // 직전도 정량분석(통화 토글)이면 구간 유지
  state.analyticsActive = true; state.analyticsPayload = payload;
  const dts = payload.dates; state.globalStart = dts[0]; state.globalEnd = dts[dts.length - 1];
  const sEl = document.getElementById('start'), eEl = document.getElementById('end');
  sEl.min = state.globalStart; sEl.max = state.globalEnd; eEl.min = state.globalStart; eEl.max = state.globalEnd;
  if (wasAnalytics) {                                   // 통화 토글: 기존 선택 구간 유지(유효 범위로 클램프)
    if (!sEl.value || sEl.value < state.globalStart || sEl.value > state.globalEnd) sEl.value = state.globalStart;
    if (!eEl.value || eEl.value > state.globalEnd || eEl.value < state.globalStart) eEl.value = state.globalEnd;
  } else {                                              // 새 진입: 전체기간 기본(‘전체’ 프리셋)
    setActivePreset(0);
  }
  state._analyticsCur = payload.currency || '';
  // 분석 자산: 새 진입이면 전체, 통화 토글이면 기존 선택 유지(같은 8키).
  const allKeys = (payload.assets || []).map(a => a.key);
  if (!wasAnalytics || !(state.selectedAssets || []).length) state.selectedAssets = allKeys.slice();
  renderAssetSelector();
  recomputeAnalytics();
}

// 정량분석 전통 포트폴리오 유니버스 프리셋(자산 부분집합). keys=null → 전체.
const ANALYTICS_UNIVERSES = [
  { label: '전체 (8자산)', keys: null, tip: '8자산 전부' },
  { label: '미국 60/40', keys: ['us_stock', 'us_bond'], tip: '미국 주식·장기국채(클래식 60/40)' },
  { label: '영구 포트폴리오', keys: ['us_stock', 'us_bond', 'gold'], tip: '해리 브라운 — 주식·장기채·금(+현금)' },
  { label: '올웨더 근사', keys: ['us_stock', 'us_bond', 'gold', 'silver'], tip: '레이 달리오 풍 — 주식·채권·금·은' },
  { label: '글로벌 주식', keys: ['us_stock', 'kr_stock', 'cn_stock', 'in_stock'], tip: '미·한·중·인 주식' },
  { label: '글로벌 주식+채권', keys: ['us_stock', 'kr_stock', 'cn_stock', 'in_stock', 'us_bond', 'kr_bond'], tip: '4국 주식 + 미·한 채권' },
];

function renderAssetSelector() {
  const p = state.analyticsPayload; if (!p) return;
  const uh = document.getElementById('an-universe'), ah = document.getElementById('an-assets');
  if (uh && !uh.dataset.built) {
    uh.innerHTML = ANALYTICS_UNIVERSES.map((u, i) => `<button type="button" data-univ="${i}" title="${u.tip || ''}">${u.label}</button>`).join('');
    uh.dataset.built = '1';
  }
  if (ah) {
    const sel = new Set(state.selectedAssets);
    ah.innerHTML = (p.assets || []).map(a => {
      const col = a.color || (typeof CAT_COLOR !== 'undefined' && CAT_COLOR[a.key]) || 'var(--muted)';
      return `<label class="an-asset${sel.has(a.key) ? ' on' : ''}"><input type="checkbox" data-asset="${a.key}"${sel.has(a.key) ? ' checked' : ''}/>` +
        `<span class="swatch" style="background:${col}"></span>${a.label}</label>`;
    }).join('');
  }
  if (!state._assetWired) {
    if (ah) ah.addEventListener('change', e => {
      const cb = e.target.closest('input[data-asset]'); if (!cb) return;
      const s = new Set(state.selectedAssets); cb.checked ? s.add(cb.dataset.asset) : s.delete(cb.dataset.asset);
      state.selectedAssets = (p.assets || []).map(a => a.key).filter(k => s.has(k));
      recomputeAnalytics(); renderAssetSelector();
    });
    if (uh) uh.addEventListener('click', e => {
      const b = e.target.closest('button[data-univ]'); if (!b) return;
      const all = (p.assets || []).map(a => a.key), u = ANALYTICS_UNIVERSES[+b.dataset.univ];
      state.selectedAssets = (u.keys || all).filter(k => all.includes(k));
      renderAssetSelector(); recomputeAnalytics();
    });
    state._assetWired = true;
  }
}

// 선택 구간(start/end) + 선택 자산 → 클라이언트 재계산(상관·프론티어·접점·결과지표·리스크패리티).
function recomputeAnalytics() {
  const p = state.analyticsPayload; if (!p) return;
  const allKeys = (p.assets || []).map(a => a.key);
  const sel = (state.selectedAssets && state.selectedAssets.length) ? state.selectedAssets : allKeys;
  const an = document.getElementById('an-assets-note');
  if (sel.length < 2) {                       // 프론티어엔 2개 이상 필요 — 직전 뷰 유지
    if (an) { an.classList.remove('hidden'); an.textContent = '분석할 자산을 2개 이상 선택하세요.'; }
    return;
  }
  if (an) an.classList.add('hidden');
  const { s, e } = currentWindow();
  const d = ANALYTICS.buildAnalytics(p, { s, e }, sel);
  state.data = d; state.explorer = null;     // 탐색기 마커는 아래에서 재설정
  const full = isFullPeriod(s, e), subset = sel.length < allKeys.length;
  document.getElementById('meta').textContent =
    `${d.title || '정량분석'} · ${d.n_months}개월 · ${d.period}` + (full ? ' (전체기간)' : ' · 조절구간') +
    (subset ? ` · ${sel.length}자산 선택` : '');
  renderAnalytics(d);
  const note = document.getElementById('an-range-note');
  if (note) {
    const small = d.n_months < 24;
    note.classList.toggle('hidden', !small);
    if (small) note.textContent = `⚠️ 표본 ${d.n_months}개월 — 구간이 짧아 효율적 프론티어·접점이 불안정할 수 있습니다(24개월 이상 권장).`;
  }
  // 전략 탐색기: 같은 구간·자산으로 재생성 → 기본(접점) 비중·슬라이더 세팅 → 렌더
  state.explorerCtx = ANALYTICS.makeExplorer(p, { s, e }, sel);
  initExplorer();
  renderExplorer();
}

function renderAnalytics(d) {
  document.getElementById('an-period').textContent = d.period ? `· ${d.period}` : '';
  const note = document.getElementById('an-frontier-note');
  const hasMk = d.frontier && d.frontier.markowitz && (d.frontier.markowitz.curve_mv || []).length;
  if (note && d.frontier) note.textContent = hasMk
    ? `마코위츠 경계(정확, scipy) + 몬테카를로 ${(d.frontier.n_sims || 0).toLocaleString()}회 구름(실현가능영역) · ★ 접점(Max Sharpe) · ◆ 최소분산(GMV) · ● 단일자산 · ◇ 프리셋 (무위험 ${_apct(d.rf, 0)}).`
    : `long-only 랜덤 비중 ${(d.frontier.n_sims || 0).toLocaleString()}회 · ★ Max Sharpe · ◆ Min Variance · ● 단일자산 · ◇ 프리셋 (무위험 ${_apct(d.rf, 0)}).`;
  renderRiskReturn(d);
  renderCorrelation(d);
  renderFrontier(d);
  renderFrontierStats(d);
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
  const mk = f.markowitz;
  const hasMk = mk && mk.curve_mv && mk.curve_mv.length;
  const cv = hasMk ? mk.curve_mv : (f.curve || []);
  traces.push({ type: 'scatter', mode: 'lines', name: hasMk ? '마코위츠 경계' : '효율적 경계',
    x: cv.map(p => p[0] * 100), y: cv.map(p => p[1] * 100),
    line: { color: hasMk ? cssVar('--accent') : muted, width: 2, dash: hasMk ? 'solid' : 'dot' }, hoverinfo: 'skip' });
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
  const ms = hasMk ? mk.tangency : f.max_sharpe, mv = hasMk ? mk.gmv : f.min_var;
  const msName = hasMk ? '접점 (Max Sharpe)' : 'Max Sharpe', mvName = hasMk ? '최소분산 (GMV)' : 'Min Variance';
  if (ms) traces.push({ type: 'scatter', mode: 'markers', name: msName, x: [ms.vol * 100], y: [ms.ret * 100],
    marker: { size: 17, symbol: 'star', color: '#f59e0b', line: { width: 1, color: cssVar('--chart-paper') } },
    hovertemplate: `${msName}<br>CAGR %{y:.1f}% · 변동성 %{x:.1f}%` + (ms.stats ? ` · MDD ${(ms.stats.mdd * 100).toFixed(1)}% · Sharpe ${(+ms.sharpe).toFixed(2)}` : '') + '<extra></extra>' });
  if (mv) traces.push({ type: 'scatter', mode: 'markers', name: mvName, x: [mv.vol * 100], y: [mv.ret * 100],
    marker: { size: 13, symbol: 'diamond', color: '#10b981', line: { width: 1, color: cssVar('--chart-paper') } },
    hovertemplate: `${mvName}<br>CAGR %{y:.1f}% · 변동성 %{x:.1f}%` + (mv.stats ? ` · MDD ${(mv.stats.mdd * 100).toFixed(1)}%` : '') + '<extra></extra>' });
  const exp = state.explorer;             // 전략 탐색기: 내 포트폴리오 점(◇)
  if (exp && exp.mine) traces.push({ type: 'scatter', mode: 'markers', name: '내 포트폴리오',
    x: [exp.mine.vol * 100], y: [exp.mine.ret * 100],
    marker: { size: 16, symbol: 'diamond-open', color: '#e11d48', line: { width: 2.5, color: '#e11d48' } },
    hovertemplate: '내 포트폴리오<br>CAGR %{y:.1f}% · 변동성 %{x:.1f}%<extra></extra>' });
  const layout = baseLayout('', '');
  layout.xaxis = { title: { text: '연환산 변동성 %', font: { color: muted } }, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted }, zeroline: false };
  layout.yaxis = { title: { text: '연환산 수익률 %', font: { color: muted } }, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted } };
  layout.hovermode = 'closest';
  layout.legend = { orientation: 'h', y: -0.16, font: { size: 10, color: fg } };
  Plotly.react('an-frontier', traces, layout, PLOTCFG);
}

// ── 전략 탐색기 (위험성향 슬라이더 + 내 비중 점 찍기) ───────────────────────
function _expInputs() { return Array.from(document.querySelectorAll('#exp-weights input')); }
function _expSetWeights(wObj) { _expInputs().forEach(i => { i.value = ((wObj[i.dataset.asset] || 0) * 100).toFixed(1); }); }
function _expNormalize() { const inps = _expInputs(); let s = 0; inps.forEach(i => s += parseFloat(i.value) || 0); if (s > 0) inps.forEach(i => i.value = ((parseFloat(i.value) || 0) / s * 100).toFixed(1)); }
function _expReadWeights() { const w = {}; let s = 0; _expInputs().forEach(i => { const v = (parseFloat(i.value) || 0) / 100; w[i.dataset.asset] = v; s += v; }); return { w, s }; }

function initExplorer() {
  const ex = state.explorerCtx, host = document.getElementById('exp-weights');
  if (!ex || !host) return;
  host.innerHTML = ex.keys.map((k, j) => {
    const col = ((state.data.assets || []).find(a => a.key === k) || {}).color || (typeof CAT_COLOR !== 'undefined' && CAT_COLOR[k]) || PALETTE[j % PALETTE.length];
    return `<label class="pg-w"><span class="swatch" style="background:${col}"></span>${ex.labels[k]}` +
      `<input type="number" data-asset="${k}" min="0" max="100" step="0.5" value="0" /></label>`;
  }).join('');
  _expSetWeights(ex.tangency.weights);    // 기본 = 접점(Max Sharpe)
  const rng = document.getElementById('exp-risk');
  if (rng && ex.maxReturn > ex.gmvReturn) {
    const t = (ex.tangencyReturn - ex.gmvReturn) / (ex.maxReturn - ex.gmvReturn);
    rng.value = String(Math.round(Math.max(0, Math.min(1, t)) * 100));
  }
  if (!state._expWired) {
    host.addEventListener('input', renderExplorer);
    if (rng) rng.addEventListener('input', onRiskSlider);
    const nb = document.getElementById('exp-normalize'); if (nb) nb.addEventListener('click', () => { _expNormalize(); renderExplorer(); });
    document.querySelectorAll('#explorer-section [data-set]').forEach(b => b.addEventListener('click', () => applyExpPreset(b.dataset.set)));
    state._expWired = true;
  }
}
function onRiskSlider() {
  const ex = state.explorerCtx; if (!ex) return;
  const t = (+document.getElementById('exp-risk').value) / 100;
  const target = ex.gmvReturn + t * (ex.maxReturn - ex.gmvReturn);
  _expSetWeights(ex.efficientForReturn(target).weights);
  renderExplorer();
}
function applyExpPreset(which) {
  const ex = state.explorerCtx; if (!ex) return;
  const p = { tangency: ex.tangency, gmv: ex.gmv, equal: ex.equalWeight }[which];
  if (p) { _expSetWeights(p.weights); renderExplorer(); }
}
function renderExplorer() {
  const ex = state.explorerCtx; if (!ex) return;
  const { w, s } = _expReadWeights();
  const sumEl = document.getElementById('exp-sum');
  if (sumEl) { sumEl.textContent = `합계 ${(s * 100).toFixed(1)}%`; sumEl.className = 'pg-sum' + (Math.abs(s - 1) <= 0.001 ? ' ok' : ' warn'); }
  const mine = ex.evalWeights(w); const st = mine.stats;
  state.explorer = { mine: { vol: mine.vol, ret: mine.ret } };
  const fr = ex.frontierReturnAt(mine.vol), gap = fr != null ? fr - mine.ret : null;
  const gapTxt = gap == null ? '' : (gap <= 0.0005
    ? '✓ 효율적 경계 위 — 같은 위험에서 거의 최적'
    : `효율 갭 −${(gap * 100).toFixed(2)}%p · 같은 위험(${_apct(mine.vol)})에서 경계 최대수익 ${_apct(fr)}`);
  const ro = document.getElementById('exp-risk-readout');
  if (ro) ro.textContent = `→ 변동성 ${_apct(mine.vol)} · 수익(CAGR) ${_apct(mine.ret)} · Sharpe ${_anum(mine.sharpe)}`;
  document.getElementById('exp-result').innerHTML =
    `<div class="fstat-card"><div class="fstat-h"><span class="swatch" style="background:#e11d48"></span>내 포트폴리오</div>` +
    `<div class="fstat-grid"><div><b>${_apct(mine.ret)}</b><span>CAGR</span></div><div><b>${_apct(mine.vol)}</b><span>변동성</span></div>` +
    `<div><b>${_anum(mine.sharpe)}</b><span>Sharpe</span></div><div><b>${_anum(st.sortino)}</b><span>Sortino</span></div>` +
    `<div><b>${_apct(st.mdd)}</b><span>MDD</span></div><div><b>${_apct(st.total_return)}</b><span>총수익</span></div></div>` +
    `<div class="exp-gap ${gap != null && gap > 0.0005 ? 'warn' : 'ok'}">${gapTxt}</div></div>`;
  if (state.data) renderFrontier(state.data);   // 프론티어에 ◇ 내 점 갱신
}

// 포트폴리오 결과 카드(접점·GMV·강건 대안) + 성장 곡선. (마코위츠 없으면 MC max_sharpe/min_var 폴백.)
const _ALT_COLOR = { equal_weight: '#64748b', min_variance: '#10b981', risk_parity: '#9333ea' };
function renderFrontierStats(d) {
  const host = document.getElementById('an-frontier-stats');
  if (!host) return;
  const f = d.frontier || {}, mk = f.markowitz;
  let ports = [];
  if (mk) {
    if (mk.tangency) ports.push({ label: '접점 (Max Sharpe)', color: '#f59e0b', p: mk.tangency });
    if (mk.gmv) ports.push({ label: '최소분산 (GMV)', color: '#10b981', p: mk.gmv });
    (mk.alternatives || []).filter(a => !(mk.gmv && a.name === 'min_variance')).forEach((a, i) =>
      ports.push({ label: a.label, color: _ALT_COLOR[a.name] || PALETTE[i % PALETTE.length], p: a }));
  } else {
    if (f.max_sharpe) ports.push({ label: 'Max Sharpe', color: '#f59e0b', p: f.max_sharpe });
    if (f.min_var) ports.push({ label: 'Min Variance', color: '#10b981', p: f.min_var });
  }
  const ap = document.getElementById('an-fstats-period');
  if (ap) ap.textContent = d.period || '';
  const labelOf = k => ((d.assets || []).find(a => a.key === k) || {}).label || k;
  const colorOf = k => ((d.assets || []).find(a => a.key === k) || {}).color;
  host.innerHTML = ports.map(({ label, color, p }) => {
    const st = p.stats || {};
    const wbars = Object.entries(p.weights || {}).sort((a, b) => b[1] - a[1]).map(([k, w]) =>
      `<div class="wbar-row"><span class="wbar-lab">${labelOf(k)}</span>` +
      `<span class="wbar-track"><span class="wbar-fill" style="width:${(w * 100).toFixed(0)}%;background:${colorOf(k) || color}"></span></span>` +
      `<span class="wbar-val">${(w * 100).toFixed(0)}%</span></div>`).join('');
    return `<div class="fstat-card"><div class="fstat-h"><span class="swatch" style="background:${color}"></span>${label}</div>` +
      `<div class="fstat-grid">` +
      `<div><b>${_apct(p.ret)}</b><span>CAGR</span></div><div><b>${_apct(p.vol)}</b><span>변동성</span></div>` +
      `<div><b>${_anum(p.sharpe)}</b><span>Sharpe</span></div><div><b>${_anum(st.sortino)}</b><span>Sortino</span></div>` +
      `<div><b>${_apct(st.mdd)}</b><span>MDD</span></div><div><b>${_apct(st.total_return)}</b><span>총수익</span></div>` +
      `</div><div class="wbars">${wbars}</div></div>`;
  }).join('');

  if (mk && mk.dates && mk.dates.length) {
    const x = mk.dates;
    const traces = ports.filter(({ p }) => p.nav && p.nav.length).map(({ label, color, p }) =>
      ({ type: 'scatter', mode: 'lines', name: label, x, y: p.nav, line: { width: 1.8, color } }));
    const layout = baseLayout('', '성장 배수 (로그)');
    layout.yaxis.type = 'log';
    layout.legend = { orientation: 'h', y: -0.2, font: { size: 10, color: cssVar('--chart-fg') } };
    Plotly.react('an-frontier-growth', traces, layout, PLOTCFG);
    setHidden('an-frontier-growth', false);
  } else setHidden('an-frontier-growth', true);
}

// 데이터 정확도 (도구·지표) — 자산별 신뢰도·실측범위·프록시 출처(기간별)·오차추정·포트폴리오 영향.
function renderReliability(d) {
  const assetRows = (d.assets || []).map(a => {
    const grade = a.grade ? `<span class="grade ${a.grade}">${GRADE_LABEL[a.grade] || a.grade}</span>` : '';
    const segs = (a.segments || []).map(s =>
      `${s.label}${s.since ? ` <span class="muted">(${s.since}~)</span>` : ''}${s.transform ? ` <span class="muted">[${s.transform}]</span>` : ''}`).join(' ← ');
    return `<tr><td class="name">${a.label || a.key}</td><td data-label="신뢰도">${grade}</td><td data-label="실측 범위">${a.range || ''}</td>` +
      `<td class="muted" data-label="프록시 출처">${segs}</td><td class="muted" data-label="비고">${a.note || ''}</td></tr>`;
  }).join('');
  const assetTable = '<table class="diag-table"><thead><tr><th class="name">자산</th><th>신뢰도</th>' +
    '<th>실측 범위</th><th>프록시 출처 (최신 ← 과거)</th><th>비고</th></tr></thead><tbody>' + assetRows + '</tbody></table>';
  const errRows = (d.error_rows || []).map(r =>
    `<tr><td class="name">${CAT_LABEL[r.asset] || r.asset}</td><td class="muted" data-label="주된 오차 원인">${r.cause}</td>` +
    `<td data-label="CAGR 오차">${r.cagr_err}</td><td class="muted" data-label="비고">${r.note || ''}</td></tr>`).join('');
  const errTable = errRows ? '<h3>오차 추정</h3><table class="diag-table"><thead><tr><th class="name">자산</th>' +
    '<th>주된 오차 원인</th><th>CAGR 오차</th><th>비고</th></tr></thead><tbody>' + errRows + '</tbody></table>' : '';
  const impact = (d.error_impact || []).map(t => `<li>${t}</li>`).join('');
  const impactBlock = impact ? '<h3>포트폴리오 영향</h3><ul class="diag-impact">' + impact + '</ul>' : '';
  document.getElementById('reliability-body').innerHTML = assetTable + errTable + impactBlock;
  document.getElementById('reliability-meta').textContent =
    `생성일 ${d.generated_at || '-'} · 신뢰도 등급: 높음 / 보통 / 낮음`;
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
      // first-wins: 벤치마크(KOSPI 등)는 시리즈를 첫 데이터셋만 채택하므로 표/지표도 같은
      // 데이터셋 행을 써야 곡선=표가 일치(데이터셋마다 벤치마크를 자기 구간으로 재정규화하기 때문).
      for (const [k, v] of Object.entries(d.table_display || {})) if (!(k in merged.table_display)) merged.table_display[k] = v;
      for (const [k, v] of Object.entries(d.metrics_raw || {})) if (!(k in merged.metrics_raw)) merged.metrics_raw[k] = v;
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
