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
  kr_bond: '#9333ea', cash: '#9ca3af', commodities: '#a16207',
  re_kr: '#92400e', re_seoul: '#e11d48' };
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
  allocCtx: null, panelCache: null,                      // 정적 리밸런싱 셀렉터(즉석 재계산)
  rolling: { years: 0 }, topddCurve: null,               // 롤링 수익률 창·낙폭표 곡선 선택
  sweep: null, sweepMetric: 'CAGR',                      // 리밸런싱 민감도 스윕 결과·지표
  paraMode: 'det', mcBoot: null,                         // 낙원계산기 모드(결정론/몬테카를로)·부트스트랩 캐시
  blendCcy: 'krw', blendMode: 'lump', blendCache: null, _blendWired: false,  // 전략 블렌딩·적립식
  sort: { col: null, dir: -1 },  // 성과표 리더보드 정렬(열 클릭). dir: -1=내림차순
  apt: { index: null, bundles: {}, txCache: {},          // 단지 조회(molit_apt) — 구별 번들 레이지 캐시
         txFail: {}, _inflight: {},                      // 거래상세 실패 표시·중복 fetch 방지
         sel: { sgg: '', ci: -1, band: null, startMi: null },
         preselect: null, _wired: false },
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
  'DCA (월적립)': '매월 일정액 분할 매수(정액적립식) — 진입 타이밍 분산. 수익곡선(TWR)은 자산 수익률이라 매수후보유와 거의 겹침 — 적립 효과는 아래 적립식 패널과 표의 XIRR로 본다.',
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
  crypto: '암호화폐 전략: 매수후보유·DCA·이동평균선 추세(20/60/120/200일 × 달러·원화 신호). 곡선=TWR(위험비교), 적립 수익=XIRR.',
  analytics: '8자산 월수익 기반 정량분석 — 상관·효율적 프론티어·리스크패리티·위험수익(무위험 2%).',
  compare: '여러 전략을 한 곡선에 오버레이 비교(통화 토글 + 지표 열 클릭 정렬 리더보드).',
  re_index: '국내 아파트 지수(한국부동산원·KB) 기반 — 매수후보유·전세vs매매·갭투자(정적·갭×추세·매크로 레짐 게이트)·지역 모멘텀. 월간·비유동 자료라 지수 평활로 변동성·Sharpe 해석에 주의.',
};
const MA_SUFFIX = ' · MA200';   // Python 곡선명 접미사(f"{name} · MA200")와 동일
function stratDesc(name) {
  if (!name) return '';
  if (STRAT_DESC[name]) return STRAT_DESC[name];
  if (name.endsWith(MA_SUFFIX)) {
    const base = stratDesc(name.slice(0, -MA_SUFFIX.length));
    return '200일 이동평균선 필터 — 자산별 월말 가격이 200일선 위일 때만 보유, 아래면 그 자산 비중은 '
      + '현금(0%·무이자)으로 이동. 판단은 리밸 주기와 무관하게 매월, 돌파한 달에 전체 리밸런싱.'
      + (base ? ' ' + base : '');
  }
  const m = name.match(/^(\d+)일선 · (달러|원화)신호$/);
  if (m) return `${m[1]}일 이동평균선 추세 — ${m[2]} 가격이 ${m[1]}일선 위면 100% 보유, 아래면 현금(신호는 ${m[2]} 기준).`;
  if (name.includes('매수후보유')) return '매수 후 보유(벤치마크).';
  if (name.includes('DCA')) return '정액 분할 매수(DCA).';
  return '';
}
const REBAL_KOR = { never: '없음(Buy&Hold)', monthly: '월', quarterly: '분기', semiannual: '반기', yearly: '연' };
function renderDescription() {
  const el = document.getElementById('strategy-desc');
  if (!el) return;
  const d = state.data;
  let txt = '';
  if (d && d.kind === 'analytics') txt = CAT_BLURB.analytics;
  else if (d && d.description) txt = d.description;        // 동적/정적: JSON 상세 설명
  else txt = stratDesc(state.nav.group) || CAT_BLURB[state.nav.category] || '';
  // 리밸런싱 주기 표기 — 동적=신호 기반 매월, 정적/플레이그라운드=주기(+밴드)
  if (d) {
    if (d.kind === 'dynamic') txt += (txt ? ' · ' : '') + '신호 기반 매월 리밸런싱';
    else if (d.rebalance) txt += (txt ? ' · ' : '') + `리밸런싱: ${REBAL_KOR[d.rebalance] || d.rebalance}`
      + (d.band_ratio != null ? (d.band_ratio > 0 ? ` (밴드 ±${(d.band_ratio * 100).toFixed(0)}%)` : ' (밴드 없음)') : '');
    if (d.ma_on) txt += (txt ? ' · ' : '') + '200일선 필터 ON';
  }
  // (가) 데이터 신선도: 현 데이터셋 시계열의 최신 끝날짜 + 빌드 생성일 표기 → 갱신이 멈추면(stale) 눈에 띔.
  if (d && Array.isArray(d.series) && d.series.length) {
    let last = '';
    for (const ser of d.series) {
      const end = (ser.period || '').split('~')[1];
      if (end && end > last) last = end;
    }
    if (last) txt += (txt ? ' · ' : '') + `📅 데이터 기준 ${last}`
      + (d.generated_at ? ` (갱신 ${d.generated_at})` : '');
  }
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}

function render() {
  if (!state.data) return;
  if (!_hasCryptoMa(state.data)) setHidden('crypto-ma-section', true);   // 코인 아닌 뷰(블렌드·플레이그라운드 등)에선 숨김
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
  renderRolling(rows);        // 분석 강화(모든 백테스트 뷰): 롤링 수익률
  renderTopDD(rows);          //   최대 낙폭 Top-N
  renderMonthlyHeatmap(rows); //   월별 수익률 히트맵
  renderCryptoDca(rows);      //   코인 전용: 적립식(DCA) 납입 vs 평가액·XIRR (TWR 곡선이 겹치는 이유 해설)

  const note = isFullPeriod(s, e)
    ? `전체 기간 (${state.globalStart} ~ ${state.globalEnd})`
    : `선택 구간 (${s} ~ ${e}) · 재정규화된 뷰 — 전체기간 전용 지표는 "—"`;
  document.getElementById('period-note').textContent = note;
  renderFreqNote();
  renderDescription();
}

// 데이터 주기(월봉/일봉) 안내 — 데이터셋 freq 필드 기반(수익곡선·낙폭 차트 아래 + 성과표 아래에 자동 표기).
// 월봉(freq≠'D')이면 월말 종가라 장중 급락이 눌려 MDD·변동성이 실제보다 축소될 수 있음을 명시한다.
// 크립토는 일별(freq='D')이라 경고를 낮추고, 블렌드·플레이그라운드 synth 데이터셋은 freq='M'(월봉).
function renderFreqNote() {
  const daily = !!(state.data && state.data.freq === 'D');
  const txt = daily
    ? '📅 <strong>일별(日) 종가</strong> 기준 백테스트 — 장중 저점까지는 반영되지 않습니다.'
    : '⚠️ <strong>월말(月末) 종가</strong> 기준 백테스트 — MDD·연변동성 등 위험지표는 장중 실제 낙폭보다 '
      + '<strong>축소</strong>될 수 있습니다 (예: 코로나 2020-03 — 월말 −20% vs 장중 −34%).';
  ['freq-note-dd', 'freq-note-table'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = txt;
    el.classList.toggle('freq-note-warn', !daily);   // 월봉일 때만 강조(왼쪽 액센트)
    el.classList.remove('hidden');
  });
}

// 코인 적립식(DCA) — 매월 동일액 적립 시 납입누계 vs 평가액 + XIRR(금액가중). 메인 곡선은 TWR(현금흐름
// 중립)이라 매수후보유와 DCA가 겹쳐 보이는데, 적립의 실제 효과를 금액가중으로 보완 표시(순수 클라이언트).
function renderCryptoDca(rows) {
  const sec = document.getElementById('cryptodca-section');
  if (!sec) return;
  const bh = (rows || []).find(r => r.name === '매수후보유');   // 현재 통화·구간의 자산 성장 곡선
  if (state.nav.category !== 'crypto' || !bh || !bh.nav || bh.nav.length < 2) { sec.classList.add('hidden'); return; }
  const ccy = state.nav.currency || 'usd';
  const amt = ccy === 'usd' ? 1000 : 1000000;   // 매월 동일액 가정(XIRR·납입대비 비율은 금액 스케일에 불변)
  // dcaResult는 데이터점마다 1회 매수 → 일별 곡선을 월말로 리샘플해 '월 적립'으로 변환
  const mEnd = new Map();
  for (let i = 0; i < bh.dates.length; i++) mEnd.set(bh.dates[i].slice(0, 7), { d: bh.dates[i], v: bh.nav[i] });
  const mk = [...mEnd.keys()].sort();
  const mdates = mk.map(k => mEnd.get(k).d), mnav = mk.map(k => mEnd.get(k).v);
  if (mnav.length < 2) { sec.classList.add('hidden'); return; }
  const dca = dcaResult(mdates, mnav, amt);      // 기존 적립식 엔진 재사용 (app.js dcaResult)
  const unit = ccy === 'usd' ? '$' : '₩', hov = ccy === 'usd' ? '$%{y:,.0f}' : '%{y:,.0f}원';
  const card = (l, v, s) => `<div class="ext-card"><div class="lab">${l}</div><div class="val">${v}</div><div class="sub">${s || ''}</div></div>`;
  document.getElementById('cryptodca-cards').innerHTML =
    card('최종 평가액', _moneyCompact(dca.final, ccy), `${dca.dates.length}개월 적립`) +
    card('총 납입액', _moneyCompact(dca.totalInvested, ccy), `매월 ${_moneyCompact(amt, ccy)} 가정`) +
    card('평가손익', _moneyCompact(dca.final - dca.totalInvested, ccy), '') +
    card('XIRR (금액가중)', fmtPct(dca.xirr), '연율 · 적립 수익률');
  const muted = cssVar('--chart-muted');
  Plotly.react('chart-cryptodca', [
    { type: 'scatter', mode: 'lines', name: '평가액', x: dca.dates, y: dca.value, line: { width: 2, color: cssVar('--accent') }, hovertemplate: hov + '<extra>평가액</extra>' },
    { type: 'scatter', mode: 'lines', name: '납입 누계', x: dca.dates, y: dca.invested, line: { width: 1.4, color: muted, dash: 'dot' }, hovertemplate: hov + '<extra>납입</extra>' },
  ], baseLayout('적립식 — 매월 동일액 적립 시 납입 누계 vs 평가액', `금액 (${unit})`), PLOTCFG);
  sec.classList.remove('hidden');
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
    legend: { orientation: 'h', yanchor: 'top', y: -0.2, font: { size: 10, color: fg } },
    xaxis: { type: 'date', automargin: true, gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: muted } },
    yaxis: { title: { text: yTitle, font: { color: muted } }, automargin: true, gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickfont: { color: muted } },
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
  layout.xaxis = { type: 'category', automargin: true, gridcolor: cssVar('--chart-grid'), linecolor: cssVar('--chart-grid'), tickfont: { color: cssVar('--chart-muted') } };
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
  // 월봉 데이터셋(freq≠'D')이면 월말 종가라 장중 낙폭이 안 잡혀 위험지표가 축소될 수 있음을 열 헤더 툴팁으로 안내.
  const TH_TIP = (d.freq !== 'D') ? {
    'MDD': '월말 종가 기준 최대낙폭 — 장중 저점은 반영되지 않아 실제보다 축소될 수 있습니다',
    '연변동성': '월간 수익률의 연환산 변동성 — 일간 등락은 반영되지 않습니다',
    'Calmar': 'CAGR ÷ |MDD| — MDD가 월말 기준이라 실제보다 커(좋아) 보일 수 있습니다',
    'Sharpe': '월간 수익률 기준 — 월말 데이터라 위험이 과소평가될 수 있습니다',
    'Sortino': '월간 하락 수익률 기준 — 월말 데이터라 위험이 과소평가될 수 있습니다',
  } : {};
  const thCell = c => {
    const tip = TH_TIP[c];
    return `<th class="sortable${tip ? ' has-tip' : ''}" data-col="${c}"${tip ? ` title="${tip}"` : ''}>${c}${arrow(c)}</th>`;
  };
  const thead = '<thead><tr><th class="name sortable" data-col="이름">전략' + arrow('이름') + '</th>' +
    cols.map(thCell).join('') + '</tr></thead>';

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
  in_stock: '인도 주식', gold: '금', silver: '은', us_bond: '미국 장기국채', kr_bond: '한국 국채', cash: '현금', commodities: '원자재' };
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
  renderMaAB();
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
function monthsBetween(d1, d2) {            // "YYYY-MM[-DD]" → 정수 달력 개월 차(freq 무관)
  const a = d1.split('-'), b = d2.split('-');
  return (b[0] - a[0]) * 12 + (b[1] - a[1]);
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
  // 인덱스 간격이 아니라 날짜 기준 달력 개월(일별·월별 트랙 모두 정확).
  const uw = monthsBetween(dates[mp], dates[rec ? ri : nav.length - 1]);
  return { peak: dates[mp].slice(0, 7), trough: dates[mt].slice(0, 7),
           recovery: rec ? dates[ri].slice(0, 7) : '', underwater: uw, recovered: rec };
}
function renderExtCards(rows, s, e) {
  const em = state.data.extended_metrics;
  if (!em) { setHidden('ext-section', true); return; }
  const row = primaryRow(rows);                 // 주력(또는 첫 표시) 전략 — 비교 뷰에서도 견고
  if (!row) { setHidden('ext-section', true); return; }
  setHidden('ext-section', false);
  document.getElementById('ext-for').textContent = `— ${row.name} (선택 구간 재계산)`;
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

// ---------------------------------------------------------------------------
// 분석 강화(클라이언트): 롤링 수익률 · 최대 낙폭 Top-N · 월별 수익률 히트맵
// 활성 데이터셋의 NAV(rows)에서 즉석 계산. render() 경로(백테스트 뷰)에서만 호출됨.
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function primaryRow(rows) {
  const em = state.data.extended_metrics;
  const pname = em ? Object.keys(em)[0] : null;
  return rows.find(r => r.name === pname) || rows[0];
}
/** 롤링 N년 CAGR — 각 끝점 i에서 ≥years 인 가장 짧은 창(시작 k). k 단조증가(투포인터). */
function rollingCagr(dates, nav, years) {
  const out = []; let k = 0;
  for (let i = 0; i < nav.length; i++) {
    while (k + 1 <= i && yearsBetween(dates[k + 1], dates[i]) >= years) k++;
    if (yearsBetween(dates[k], dates[i]) >= years - 1e-6) {
      const yr = yearsBetween(dates[k], dates[i]);
      out.push({ date: dates[i], cagr: Math.pow(nav[i] / nav[k], 1 / yr) - 1 });
    }
  }
  return out;
}
function renderRolling(rows) {
  if (!rows.length) { setHidden('rolling-section', true); return; }
  const pr = primaryRow(rows);
  const span = yearsBetween(pr.dates[0], pr.dates[pr.dates.length - 1]);
  if (span < 1) { setHidden('rolling-section', true); return; }   // 1년 미만이면 롤링 무의미
  setHidden('rolling-section', false);
  let years = (state.rolling && state.rolling.years) || 0;
  if (!years) years = span >= 10 ? 5 : span >= 6 ? 3 : 1;          // 자동
  const sel = document.getElementById('rolling-window');
  if (sel) sel.value = String((state.rolling && state.rolling.years) || 0);
  const traces = [], pPts = [];
  for (const r of rows) {
    const rc = rollingCagr(r.dates, r.nav, years);
    if (!rc.length) continue;
    traces.push({ type: 'scatter', mode: 'lines', name: r.name, x: rc.map(p => p.date),
      y: rc.map(p => p.cagr * 100), line: { width: 1.4, color: state.colorOf[r.name] },
      hovertemplate: `%{y:.1f}%<extra>${r.name} · ${years}년 롤링</extra>` });
    if (r.name === pr.name) pPts.push(...rc.map(p => p.cagr));
  }
  const cardsEl = document.getElementById('rolling-cards');
  if (pPts.length) {
    const s = [...pPts].sort((a, b) => a - b);
    const card = (lab, v, sub) => `<div class="ext-card"><div class="lab">${lab}</div><div class="val">${v}</div><div class="sub">${sub}</div></div>`;
    const pos = (pPts.filter(x => x > 0).length / pPts.length * 100).toFixed(0);
    cardsEl.innerHTML =
      card('최저', fmtPct(s[0]), `${years}년 롤링 · ${pr.name}`) +
      card('하위 25%', fmtPct(percentile(s, 0.25)), `${pPts.length}개 창`) +
      card('중앙값', fmtPct(percentile(s, 0.5)), '') +
      card('상위 25%', fmtPct(percentile(s, 0.75)), '') +
      card('최고', fmtPct(s[s.length - 1]), '') +
      card('양(+) 창 비율', pos + '%', '손실 없이 끝난 비율');
  } else {
    cardsEl.innerHTML = `<p class="period-note">선택 구간이 ${years}년보다 짧아 롤링 분석 불가 — 더 긴 구간이나 짧은 창을 선택하세요.</p>`;
  }
  Plotly.react('chart-rolling', traces, baseLayout(`${years}년 롤링 CAGR (창 종료일 기준)`, '연율 CAGR %'), PLOTCFG);
}

/** 가장 깊은 낙폭 에피소드 Top-N (고점→저점→회복). mddEpisodeJS 다중화. */
function topDrawdowns(dates, nav, n) {
  const eps = []; let peak = nav[0], peakI = 0, inDD = false, trV = nav[0], trI = 0;
  for (let i = 1; i < nav.length; i++) {
    const v = nav[i];
    if (v >= peak) { if (inDD) { eps.push({ peakI, trI, recI: i, rec: true }); inDD = false; } peak = v; peakI = i; }
    else if (!inDD) { inDD = true; trV = v; trI = i; }
    else if (v < trV) { trV = v; trI = i; }
  }
  if (inDD) eps.push({ peakI, trI, recI: nav.length - 1, rec: false });
  const months = (a, b) => Math.round(yearsBetween(dates[a], dates[b]) * 12);
  return eps.map(e => ({
    depth: nav[e.trI] / nav[e.peakI] - 1, peak: dates[e.peakI].slice(0, 7), trough: dates[e.trI].slice(0, 7),
    recovery: e.rec ? dates[e.recI].slice(0, 7) : '', recovered: e.rec,
    underwater: months(e.peakI, e.rec ? e.recI : nav.length - 1),
  })).sort((a, b) => a.depth - b.depth).slice(0, n);
}
function renderTopDD(rows) {
  if (!rows.length) { setHidden('topdd-section', true); return; }
  setHidden('topdd-section', false);
  const wrap = document.getElementById('topdd-curvewrap'), selEl = document.getElementById('topdd-curve');
  if (rows.length > 1) {
    wrap.classList.remove('hidden');
    const sig = rows.map(r => r.name).join('|');
    if (selEl.dataset.sig !== sig) { selEl.innerHTML = rows.map(r => `<option>${r.name}</option>`).join(''); selEl.dataset.sig = sig; }
    if (state.topddCurve && rows.some(r => r.name === state.topddCurve)) selEl.value = state.topddCurve;
  } else { wrap.classList.add('hidden'); }
  const chosen = (rows.length > 1 && state.topddCurve && rows.some(r => r.name === state.topddCurve))
    ? rows.find(r => r.name === state.topddCurve) : primaryRow(rows);
  document.getElementById('topdd-for').textContent = `— ${chosen.name}`;
  const dd = topDrawdowns(chosen.dates, chosen.nav, 5);
  const head = '<thead><tr><th class="name">순위</th><th>고점</th><th>저점</th><th>낙폭</th><th>회복</th><th>수중(개월)</th></tr></thead>';
  const body = dd.map((e, i) => `<tr><td class="name" data-label="순위">${i + 1}</td>` +
    `<td data-label="고점">${e.peak}</td><td data-label="저점">${e.trough}</td>` +
    `<td class="neg" data-label="낙폭">${fmtPct(e.depth)}</td>` +
    `<td data-label="회복">${e.recovered ? e.recovery : '<span class="muted">미회복</span>'}</td>` +
    `<td data-label="수중(개월)">${e.underwater}</td></tr>`).join('');
  document.getElementById('topdd-table').innerHTML = head + '<tbody>' + (body || '<tr><td class="muted">낙폭 없음</td></tr>') + '</tbody>';
}

/** 월별 수익률 행렬(연×월) — 월말 리샘플 후 전월 대비. 첫 달 null. */
function monthlyReturnsMatrix(dates, nav) {
  const monthEnd = new Map();
  for (let i = 0; i < dates.length; i++) monthEnd.set(dates[i].slice(0, 7), nav[i]);
  const keys = Array.from(monthEnd.keys()).sort();
  const ret = new Map();
  for (let k = 1; k < keys.length; k++) ret.set(keys[k], monthEnd.get(keys[k]) / monthEnd.get(keys[k - 1]) - 1);
  const years = Array.from(new Set(keys.map(k => k.slice(0, 4)))).sort();
  const z = years.map(y => Array.from({ length: 12 }, (_, m) => {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    return ret.has(key) ? ret.get(key) : null;
  }));
  return { years, z };
}
function renderMonthlyHeatmap(rows) {
  if (!rows.length) { setHidden('monthly-hm-section', true); return; }
  const pr = primaryRow(rows);
  const { years, z } = monthlyReturnsMatrix(pr.dates, pr.nav);
  if (!years.length || z.flat().filter(v => v != null).length < 2) { setHidden('monthly-hm-section', true); return; }
  setHidden('monthly-hm-section', false);
  document.getElementById('monthly-hm-for').textContent = `— ${pr.name}`;
  const months = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
  const amax = Math.max(0.01, ...z.flat().filter(v => v != null).map(Math.abs));
  const text = z.map(r => r.map(v => v == null ? '' : (v > 0 ? '+' : '') + (v * 100).toFixed(1)));
  const muted = cssVar('--chart-muted');
  const trace = { type: 'heatmap', z: z.map(r => r.map(v => v == null ? null : v * 100)), x: months, y: years,
    text, texttemplate: '%{text}', textfont: { size: 12, color: '#0f172a' },
    zmid: 0, zmin: -amax * 100, zmax: amax * 100,
    colorscale: [[0, '#dc2626'], [0.5, '#f1f5f9'], [1, '#16a34a']], xgap: 2, ygap: 2,
    colorbar: { tickfont: { color: muted }, outlinewidth: 0, len: 0.92, thickness: 12, ticksuffix: '%' },
    hovertemplate: '%{y} %{x}<br>%{z:.1f}%<extra></extra>' };
  const layout = baseLayout('', '');
  layout.margin = { l: 48, r: 10, t: 24, b: 16 };
  layout.xaxis = { tickfont: { color: muted, size: 11 }, side: 'top', automargin: true };
  layout.yaxis = { tickfont: { color: muted, size: 11 }, automargin: true, autorange: 'reversed' };
  delete layout.legend; layout.hovermode = 'closest';
  // 연도(행) 수에 비례해 높이를 키워 셀이 짧아지지 않게(글씨 가독성). 기간 길수록(20년+) 효과 큼.
  const H = Math.max(360, years.length * 26 + 90);
  layout.height = H;
  document.getElementById('chart-monthly-hm').style.height = H + 'px';
  Plotly.react('chart-monthly-hm', [trace], layout, PLOTCFG);
}

// 지표별 ON/OFF/차이 표(밴드 A/B·MA A/B 공용). better<0 = 작을수록 좋음(연변동성).
const _AB_DEFS = [
  ['CAGR', 'CAGR', 'pct', 1], ['MDD', 'MDD', 'pct', 1], ['연변동성', 'ann_vol', 'pct', -1],
  ['Sharpe', 'sharpe', 'ratio', 1], ['Sortino', 'sortino', 'ratio', 1],
  ['Calmar', 'calmar', 'ratio', 1], ['월승률', 'win_rate', 'pct', 1],
];
function _renderAbTable(tableId, ab, onLabel, offLabel) {
  const f = (k, v) => k === 'pct' ? fmtPct(v) : fmtRatio(v);
  const rowsH = _AB_DEFS.map(([lab, key, kind, better]) => {
    const on = ab.on[key], off = ab.off[key];
    const diff = (on - off) * better;   // >0 → ON 이 더 나음
    const cls = Math.abs(on - off) < 1e-9 ? '' : (diff > 0 ? 'pos' : 'neg');
    const diffTxt = kind === 'pct' ? fmtPct(on - off) : fmtRatio(on - off);
    return `<tr><td class="name">${lab}</td><td data-label="${onLabel}">${f(kind, on)}</td><td data-label="${offLabel}">${f(kind, off)}</td>` +
           `<td class="${cls}" data-label="차이">${diffTxt}</td></tr>`;
  }).join('');
  document.getElementById(tableId).innerHTML =
    `<thead><tr><th class="name">지표</th><th>${onLabel}</th><th>${offLabel}</th><th>차이</th></tr></thead>` +
    '<tbody>' + rowsH + '</tbody>';
}

function renderBandAB() {
  const ab = state.data.band_ab;
  if (!ab || !ab.on || !ab.off) { setHidden('bandab-section', true); return; }
  setHidden('bandab-section', false);
  _renderAbTable('bandab-table', ab, '밴드 ON', '밴드 OFF');
}

function renderMaAB() {
  const ab = state.data.ma_ab;
  if (!ab || !ab.on || !ab.off) { setHidden('maab-section', true); return; }
  setHidden('maab-section', false);
  _renderAbTable('maab-table', ab, '필터 ON', '필터 OFF');
  const mf = state.data.ma_filter, note = document.getElementById('maab-note');
  if (note) {
    if (mf && mf.assets) {
      const parts = Object.entries(mf.assets).map(([id, a]) => {
        const pct = a.pct_in_market != null ? `${(a.pct_in_market * 100).toFixed(0)}% 보유` : '';
        const src = a.source === 'daily' ? `일봉 ${a.daily_since || ''}~` : (a.source === 'exempt' ? '필터 면제' : '월봉 근사');
        return `${CAT_LABEL[id] || id} ${pct} (${src})`;
      });
      note.textContent = `${mf.window || 200}일선 신호 — ` + parts.join(' · ');
    } else note.textContent = '';
  }
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
    state.allocCtx = null; _showAllocRebal(false);   // 정적 리밸런싱 셀렉터 기본 숨김(정적이면 아래서 재노출)
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
    _maybeCryptoMaSensitivity(d);   // 코인 데이터셋이면 이평선 필터 민감도 섹션 표시(아니면 숨김)
    // 정적 프리셋: 리밸런싱 주기·밴드 셀렉터 노출(즉석 재계산). target_weights 있는 정적(allocation)만.
    if (d.kind === 'allocation' && d.target_weights && Object.keys(d.target_weights).length) {
      state.allocCtx = { file, weights: d.target_weights, defaultRebal: d.rebalance || 'quarterly',
        defaultBand: d.band_ratio != null ? d.band_ratio : 0.2, title: d.title || '정적 배분', desc: d.description || '',
        base: state.nav.group || '정적 배분' };   // 프리셋 라벨(주기 접미사 없음) — 재계산 시 이름 재구성용
      const sel = document.getElementById('alloc-rebal'), bnd = document.getElementById('alloc-band'),
            bon = document.getElementById('alloc-band-on');
      const hasBand = state.allocCtx.defaultBand > 0;
      if (sel) sel.value = state.allocCtx.defaultRebal;
      if (bon) bon.checked = hasBand;
      if (bnd) { bnd.value = (hasBand ? state.allocCtx.defaultBand * 100 : 20).toFixed(0); bnd.disabled = !hasBand; }
      const ma = document.getElementById('alloc-ma');
      if (ma) ma.checked = false;     // 기본 OFF(사전계산 뷰엔 MA200 곡선·ma_ab가 이미 포함)
      _showAllocRebal(true);
      // 이평선 필터 민감도(과최적화 점검): 이 배분의 여러 이평선 창 낙폭·Sharpe. panel 로드 후 렌더.
      _ensurePanel().then(() => renderMaSensitivity('ma-sens-host', d.target_weights, state.nav.currency || 'krw')).catch(() => {});
    }
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
    if (t.kind === 'guide') _renderGuideAllocChart();
    else if (t.kind === 'paradise') paradiseRefresh();
    else if (t.kind === 'sentiment') renderSentiment(t.data);
    else if (t.kind === 'trend') renderTrend(t.data);
    else if (t.kind === 'molit_explore') renderMolitExplore(t.data);   // 테마 토글 시 차트 재채색
    else if (t.kind === 'molit_apt') { renderAptAll(); _renderAptSelect(_aptBundle()); }
  } else if (state.data) {
    if (state.data.kind === 'analytics') renderAnalytics(state.data);
    else { render(); if (state.sweep) renderSweep(); if (state.blendFrontier) _drawBlendFrontier(); }   // 스윕·블렌드 프론티어도 새 테마로 재색
  }
  // 이평선 민감도 차트(정적·추천)도 새 테마로 재색(캐시된 _sweep 재사용).
  ['ma-sens-host', 'reco-ma-host', 'crypto-ma-host'].forEach(h => {
    const el = document.getElementById(h);
    if (el && el._sweep) _drawMaSweep(document.getElementById(h + '-chart'), el._sweep, el._active);
  });
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
  // 전략 일괄 토글(버튼은 정적 → 1회 바인딩, 클릭 시점에 현재 체크박스 조회)
  const setAllStrategies = on => {
    document.querySelectorAll('#strategy-list input').forEach(c => { c.checked = on; });
    render();
  };
  const offBtn = document.getElementById('strat-all-off');
  const onBtn = document.getElementById('strat-all-on');
  if (offBtn) offBtn.addEventListener('click', () => setAllStrategies(false));
  if (onBtn) onBtn.addEventListener('click', () => setAllStrategies(true));
  document.getElementById('start').addEventListener('change', () => { clearPresetActive(); onPeriodChange(); });
  document.getElementById('end').addEventListener('change', () => { clearPresetActive(); onPeriodChange(); });
  document.querySelectorAll('#presets button').forEach(b => {
    b.addEventListener('click', () => { setActivePreset(Number(b.dataset.years)); onPeriodChange(); });
  });
  // 정적 자산배분 리밸런싱 주기·밴드 → 즉석 재계산
  const arb = document.getElementById('alloc-rebal'), abd = document.getElementById('alloc-band'),
        abon = document.getElementById('alloc-band-on'), ama = document.getElementById('alloc-ma');
  if (arb) arb.addEventListener('change', onAllocRebalChange);
  if (abd) abd.addEventListener('change', onAllocRebalChange);
  if (abon) abon.addEventListener('change', onAllocRebalChange);
  if (ama) ama.addEventListener('change', onAllocRebalChange);
  // 분석 강화: 롤링 창 길이 · 낙폭표 곡선 선택
  const rwin = document.getElementById('rolling-window'), tddc = document.getElementById('topdd-curve');
  if (rwin) rwin.addEventListener('change', () => { state.rolling = { years: Number(rwin.value) || 0 }; render(); });
  if (tddc) tddc.addEventListener('change', () => { state.topddCurve = tddc.value; render(); });
  // 리밸런싱 민감도 스윕: 실행 버튼 + 지표 토글
  const srun = document.getElementById('sweep-run');
  if (srun) srun.addEventListener('click', runRebalSweep);
  document.querySelectorAll('#sweep-metric button').forEach(b =>
    b.addEventListener('click', () => { state.sweepMetric = b.dataset.metric; renderSweep(); }));
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
const CAT_ORDER = { reco: -2, guide: -1, dynamic: 0, static: 1, analytics: 4, compare: 5, blend: 6, momentum: 2, crypto: 3,
  realestate: 11, paradise: 7, sentiment: 8, trend: 9, reliability: 10 };
const CAT_LABEL_NAV = { reco: '추천 전략', guide: '초보자 가이드', dynamic: '동적 자산배분', static: '정적 자산배분', momentum: '모멘텀',
  crypto: '코인', analytics: '정량분석', compare: '전략 비교', blend: '전략 블렌딩', realestate: '부동산',
  paradise: '낙원계산기', sentiment: '시장 심리', trend: '추세 경보', reliability: '데이터 정확도' };
// 4대분류: 자산배분(8자산) / 주식(한국 모멘텀·미국 TQQQ·지수 모멘텀) / 코인(BTC/ETH/XRP) /
//          도구·지표(계산기·심리·경보·데이터정확도). 코인은 전통자산과 위험특성이 달라 독립 영역.
const SUPER_OF = { reco: 'reco', guide: 'guide', dynamic: 'alloc', static: 'alloc', analytics: 'alloc', compare: 'alloc', blend: 'alloc',
  momentum: 'strat', crypto: 'coin', realestate: 're',
  paradise: 'tools', sentiment: 'tools', trend: 'tools', reliability: 'tools' };
const SUPER_ORDER = { reco: -2, guide: -1, alloc: 0, strat: 1, coin: 2, re: 3, tools: 4 };
const SUPER_LABEL = { reco: '⭐ 추천', guide: '📖 가이드', alloc: '자산배분', strat: '주식', coin: '코인', re: '부동산', tools: '도구·지표' };
// 부동산 분류 칩 = 지역(전국·지수 먼저, 그다음 도시). 카테고리 re_index/re_<도시>를 네비 맵에 등록.
// 도시 추가 시 이 리스트만 갱신(build_dashboard.RE_CATS 와 동일 순서 유지).
const RE_CATS = [['re_index', '전국·지수'], ['re_서울', '서울'], ['re_경기', '경기'], ['re_인천', '인천'],
  ['re_부산', '부산'], ['re_대구', '대구'], ['re_광주', '광주'], ['re_대전', '대전'], ['re_울산', '울산'], ['re_세종', '세종']];
RE_CATS.forEach(([k, lab], i) => {
  SUPER_OF[k] = 're'; CAT_LABEL_NAV[k] = lab; CAT_ORDER[k] = 11 + i * 0.1;
  if (k !== 're_index') CAT_BLURB[k] = '국토부 실거래(MOLIT) 기반 — 시군구 거래량·전세가율·월세·전월세전환율 추이 + 개별 단지 조회·백테스트.';
});

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
  document.body.classList.toggle('blend-mode', entry.mode === 'blend');   // 블렌딩 뷰 전용 컨트롤 표시
  // 도구·지표: 낙원계산기(클라이언트)·시장심리/추세경보/데이터정확도(JSON 로드) — mode 분기.
  if (entry.mode === 'reco') return enterReco();                          // ⭐ 추천 전략(큐레이션 + 딥링크)
  if (entry.mode === 'guide') return enterGuide();                        // 📖 초보자 가이드(정적 콘텐츠)
  if (entry.mode === 'blend') return enterBlend();
  if (entry.mode === 'paradise') return enterParadise();
  if (entry.mode === 'sentiment' || entry.mode === 'trend' || entry.mode === 'reliability')
    return loadTool(entry, entry.mode);
  if (entry.mode === 'molit_explore') return loadTool(entry, 'molit_explore');  // 시군구 조회(거래량·전세가율·실거래표)
  if (entry.mode === 'molit_apt') return loadTool(entry, 'molit_apt');          // 단지 조회(개별 아파트 추이·백테스트)
  if (entry.mode === 'leverage') return loadTool(entry, 'leverage');            // 최적 레버리지(일별 상수레버리지 스윕)
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
  ['reco', 'guide', 'paradise', 'sentiment', 'trend', 'reliability', 'molit_explore', 'molit_apt', 'leverage'].forEach(t => {
    const el = document.getElementById(t + '-section');
    if (el) el.classList.toggle('hidden', !(on && t === tool));
  });
}

// 📖 초보자 가이드 — 순수 정적 콘텐츠 뷰(데이터 파일 없음). 낙원계산기/블렌딩과 동일하게 mode 분기로 진입.
function enterGuide() {
  setAnalyticsMode(false); setToolsMode(true, 'guide');
  state.playground = false; state.data = null; state.allocCtx = null; _showAllocRebal(false);
  state.tool = { kind: 'guide' };   // 테마 토글 시 applyTheme 이 가이드 차트를 재채색하도록
  document.getElementById('meta').textContent = '초보자를 위한 설명 — 용어 · 자산배분 · 전략 · 도구 · 사용법';
  setStatus('');
  _renderGuideAllocChart();
}

// ---------------------------------------------------------------------------
// ⭐ 추천 전략 (reco) — client-only 큐레이션 탭. 대표 개별 전략 + 큐레이션 조합을 카드로 소개하고
// 각 카드에서 전체 뷰로 딥링크. 금융자산/부동산 두 섹션 분리(RE 는 원화·월간·기준 상이라 랭킹 미혼합).
// 카드 지표는 전략 dashboard JSON 의 metrics_raw 를 런타임 fetch(캐시)해 표시. 스파크라인은 CSS-var SVG.
// ---------------------------------------------------------------------------
// 개별 픽 = manifest id + 한 줄 근거. 통화 접미사·존재 여부는 렌더 시 manifest 로 확정(누락은 스킵).
// 선정 = 원화(KRW) 기준 위험대비수익(Sharpe) 상위 + 성격 다양성(정적/방어/공격/고CAGR). 대상이 한국
// 투자자라 원화 기준으로 뽑음 — 환헤지 효과로 순위가 USD와 다름(위기 때 원화 약세가 달러자산 낙폭 방어).
// 코인·레버리지(TQQQ 등)는 MDD/투기성 이유로 진입탭 제외. 전체 순위는 아래 '전체 전략 랭킹' 참고.
const RECO_FIN_PICKS = [   // 동적·모멘텀 계열(정적은 아래 MA200 섹션으로 분리)
  { id: 'multi_dynamic_baa_g_krw', why: '카나리아 신호로 방어하는 공격형 듀얼모멘텀 — 원화 CAGR 14%대·낙폭 방어' },
  { id: 'multi_dynamic_vaa_g4_krw', why: '카나리아로 공격/방어를 빠르게 전환하는 보호형 모멘텀' },
  { id: 'multi_dynamic_kr_us_gold_core6_krw', why: '한미 주식 6개월 모멘텀 + 금 위성 — 원화 CAGR 15%대 고수익형(낙폭도 원화라 −20%대)' },
  { id: 'multi_dynamic_gem_krw', why: '가장 유명한 입문 듀얼모멘텀(상대+절대) — 하락장 현금 회피' },
  { id: 'multi_dynamic_daa_g12_krw', why: '방어형 자산배분(DAA-G12) — 낙폭 −15%대로 꾸준한 안정형' },
];
// 정적 배분 + 200일선(MA200) 추세 필터 변형 — 각 정적 데이터셋 안의 별도 시리즈(series 지정). 필터가 낙폭을 크게 줄임.
const RECO_MA200_PICKS = [
  { id: 'multi_allocation_rebal_krw', series: '글로벌 분산 (귀금속 강화) · 분기 · 밴드 20% · MA200',
    label: '글로벌 분산(귀금속) + 200일선', why: '원화 위험대비수익 1위 — 200일선 필터로 낙폭 −22%→−12%' },
  { id: 'multi_allocation_us6040_krw', series: 'US 60/40 · 분기 · 밴드 20% · MA200',
    label: 'US 60/40 + 200일선', why: '고전 60/40 — 필터로 낙폭 −65%→−22% 급감(하락장 회피)' },
  { id: 'multi_allocation_allweather_full_krw', series: '올웨더 (Dalio, 충실판) · 분기 · 밴드 20% · MA200',
    label: '올웨더(Dalio) + 200일선', why: 'Dalio 올웨더 — 필터로 낙폭 −14%대 방어하며 꾸준' },
  { id: 'multi_allocation_balanced_krw', series: '균형 · 분기 · 밴드 20% · MA200',
    label: '균형 배분 + 200일선', why: '균형 분산 — 필터로 낙폭 −20%→−13%, 안정적' },
];
const RECO_RE_PICKS = [
  { id: 're_rentbuy', why: '전세 살까 vs 집 살까 — 국내 핵심 질문의 백테스트' },
  { id: 're_gap', why: '전세 무이자 레버리지(갭투자)를 무레버 매수와 비교 — 문서상 유일하게 살아남은 엣지' },
  { id: 're_gaptiming', why: '갭 × 실거래지수 추세 타이밍' },
];

function enterReco() {
  setAnalyticsMode(false); setToolsMode(true, 'reco');
  state.playground = false; state.data = null; state.allocCtx = null; _showAllocRebal(false);
  state.tool = { kind: 'reco' };   // 순수 DOM/CSS-var SVG 라 테마 토글 시 재렌더 불필요(CSS 가 자동 반영)
  document.getElementById('meta').textContent = '추천 전략 — 어디서 시작할지 고르는 큐레이션 (과거 백테스트 · 투자 자문 아님)';
  setStatus('');
  renderRecoTab();
}
// 데이터셋의 대표(전략) 시리즈명 — 벤치마크로 보이는 이름은 뒤로, 그 외 첫 항목.
function _recoPrimaryName(d) {
  const names = Object.keys(d.metrics_raw || {});
  if (!names.length) return (d.series && d.series[0] && d.series[0].name) || null;
  const isBench = n => /KOSPI|코스피|S&P|벤치|benchmark|buy\s*&?\s*hold|매수후보유|바이앤홀드/i.test(n);
  return names.find(n => !isBench(n)) || names[0];
}
function _recoMetrics(d, seriesName) {              // {name, cagr, mdd, sharpe, period} (raw) 또는 null. seriesName 지정 시 그 시리즈 사용.
  const name = (seriesName && (d.metrics_raw || {})[seriesName]) ? seriesName : _recoPrimaryName(d);
  if (!name) return null;
  const m = (d.metrics_raw || {})[name] || {};
  const td = (d.table_display || {})[name] || {};
  const sMatch = (d.series || []).find(s => s.name === name);
  const per = td['기간'] || (sMatch && sMatch.period) || (d.series && d.series[0] && d.series[0].period) || '';
  return { name, cagr: m.CAGR, mdd: m.mdd, sharpe: m.sharpe, period: per };
}
function _sparkline(nav) {                          // 경량 인라인 SVG(스트로크=CSS var → 테마 자동)
  if (!Array.isArray(nav)) return '';
  const v = nav.filter(x => x != null); if (v.length < 2) return '';
  const step = Math.max(1, Math.floor(v.length / 60)), pts = [];
  for (let i = 0; i < v.length; i += step) pts.push(v[i]);
  if (pts[pts.length - 1] !== v[v.length - 1]) pts.push(v[v.length - 1]);
  const lo = Math.min(...pts), hi = Math.max(...pts), rng = hi - lo || 1, W = 160, H = 34;
  const path = pts.map((y, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - (y - lo) / rng * H).toFixed(1)}`).join(' ');
  return `<svg class="reco-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${path}" /></svg>`;
}
async function _recoFetch(id) {                     // manifest id → {entry, data}; 캐시. 누락은 null.
  const entry = state.manifest.find(m => m.id === id);
  if (!entry || !entry.file) return null;
  state.recoCache = state.recoCache || {};
  if (!(id in state.recoCache)) {
    try { state.recoCache[id] = await (await fetch('data/' + entry.file, { cache: 'no-cache' })).json(); }
    catch (e) { state.recoCache[id] = null; }
  }
  return { entry, data: state.recoCache[id] };
}
function _recoYears(per) {                          // "YYYY-MM-DD~YYYY-MM-DD" → "19년"(대략). 일(-DD)은 선택.
  const m = /(\d{4})-(\d{2})(?:-\d{2})?\D+(\d{4})-(\d{2})/.exec(per || '');
  if (!m) return '';
  const y = (+m[3] - +m[1]) + (+m[4] - +m[2]) / 12;
  return y > 0 ? Math.round(y) + '년' : '';
}
function _recoCardHtml(entry, met, spark, why, labelOverride) {
  const pct = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
  const rat = x => (x == null || !isFinite(x)) ? '—' : Number(x).toFixed(2);
  const title = labelOverride || entry.label.replace(/\s*\((USD|KRW)\)\s*$/, '');
  const cur = entry.currency ? ` · ${entry.currency.toUpperCase()}` : '';
  const yrs = _recoYears(met && met.period);
  // 기간을 눈에 띄는 배지로(전략마다 검증 기간이 달라 지표 비교 시 주의 — 사용자 요청).
  const period = `<div class="reco-period">📅 <b>${yrs || '기간 미상'}</b>${met && met.period ? ` · ${met.period}` : ''}${cur}</div>`;
  return `<div class="reco-card"><div class="reco-head">` +
    `<span class="reco-title">${title}</span>` +
    `<button type="button" class="reco-apply" data-reco-goto="${entry.id}">자세히 보기 →</button></div>` +
    `<div class="reco-why">${why}</div>${spark || ''}` +
    `<div class="reco-metrics"><span><b>CAGR</b> ${pct(met && met.cagr)}</span>` +
    `<span><b>MDD</b> ${pct(met && met.mdd)}</span><span><b>Sharpe</b> ${rat(met && met.sharpe)}</span></div>` +
    period + `</div>`;
}
async function _recoRenderInto(elId, picks) {
  const el = document.getElementById(elId); if (!el) return;
  const results = await Promise.all(picks.map(p => _recoFetch(p.id).then(r => ({ r, p }))));
  const html = results.map(({ r, p }) => {
    if (!r || !r.data) return '';                   // 데이터셋 누락 시 우아하게 스킵
    const met = _recoMetrics(r.data, p.series);      // p.series 지정 시 그 변형(예: MA200) 지표 표시
    const s = (r.data.series || []).find(x => met && x.name === met.name) || (r.data.series || [])[0];
    return _recoCardHtml(r.entry, met, s && _sparkline(s.nav), p.why, p.label);
  }).filter(Boolean).join('');
  el.innerHTML = html || '<p class="period-note">표시할 추천 데이터가 없습니다(빌드 전이거나 데이터셋 누락).</p>';
}
function renderRecoBlendCards() {                   // 큐레이션 조합(블렌딩 탭의 RECO_BLENDS 재사용)
  const el = document.getElementById('reco-fin-blends'); if (!el) return;
  const card = r => `<div class="reco-card"><div class="reco-head">` +
    `<span class="reco-title">${r.title}</span>` +
    `<button type="button" class="reco-apply" data-reco-blend="${r.key}">블렌딩에서 열기 →</button></div>` +
    `<div class="reco-why">${r.desc}</div>` +
    `<div class="reco-w">${r.legs.map(l => `${RECO_LABEL[l.base] || l.base} ${l.w}%`).join(' · ')}</div>` +
    `<div class="reco-period">${r.statKrw} · 원화 기준 참고치</div></div>`;
  el.innerHTML = RECO_BLENDS.map(card).join('');
}
function renderRecoTab() {
  if (!state._recoWired) {                           // 카드 클릭 위임(딥링크 · 조합 열기)
    const sec = document.getElementById('reco-section');
    if (sec) sec.addEventListener('click', e => {
      const g = e.target.closest('button[data-reco-goto]'); if (g) return gotoDataset(g.dataset.recoGoto);
      const b = e.target.closest('button[data-reco-blend]'); if (b) return gotoBlendPreset(b.dataset.recoBlend);
    });
    state._recoWired = true;
  }
  _recoRenderInto('reco-fin-individual', RECO_FIN_PICKS);
  _recoRenderInto('reco-fin-ma', RECO_MA200_PICKS);
  _recoRenderInto('reco-re', RECO_RE_PICKS);
  renderRecoBlendCards();
  renderRecoMaSensitivity();
  renderLeaderboard();
}
// ⭐추천 > 정적+MA 섹션의 이평선 민감도(과최적화 점검) — 프리셋 드롭다운 + 창 스윕 차트.
function renderRecoMaSensitivity() {
  const sel = document.getElementById('reco-ma-preset'); if (!sel) return;
  _ensurePanel().then(panel => {
    const pick = () => (panel.presets && (panel.presets[sel.value] || panel.presets[Object.keys(panel.presets)[0]]));
    if (!state._recoMaWired) {
      sel.addEventListener('change', () => { const p = pick(); if (p) renderMaSensitivity('reco-ma-host', p.weights, 'krw'); });
      state._recoMaWired = true;
    }
    const p = pick(); if (p) renderMaSensitivity('reco-ma-host', p.weights, 'krw');
  }).catch(() => {});
}
// 딥링크: manifest id → 기존 4단 네비 체인 구동(대분류/카테고리/그룹/통화 UI 동기화 + loadDataset).
function gotoDataset(id) {
  const e = state.manifest.find(m => m.id === id); if (!e) return;
  setSuperCategory(SUPER_OF[e.category] || 'etc');
  setCategory(e.category); setGroup(e.group);
  if (e.currency) setCurrency(e.currency);          // 빈 통화(도구)면 setGroup 이 이미 로드
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// 큐레이션 조합 → 블렌딩 탭 진입(setCategory('blend') 가 enterBlend 경유) 후 프리셋 적용.
function gotoBlendPreset(key) {
  setSuperCategory('alloc'); setCategory('blend');
  applyRecoPreset(key);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ⭐ 추천 > 전체 전략 랭킹(리더보드) — data/leaderboard.json(전 금융전략 지표) 정렬표.
// 통화 토글(원화↔달러, 순위 재계산)·열 클릭 정렬(기본 Sharpe↓)·분류 필터·행 클릭 딥링크(gotoDataset).
const LB_COLS = [
  { k: 'name', t: '전략', kind: 'text' }, { k: 'cat', t: '분류', kind: 'cat' },
  { k: 'cagr', t: 'CAGR', kind: 'pct' }, { k: 'mdd', t: 'MDD', kind: 'pct' },
  { k: 'vol', t: '변동성', kind: 'pct' }, { k: 'sharpe', t: 'Sharpe', kind: 'ratio' },
  { k: 'sortino', t: 'Sortino', kind: 'ratio' }, { k: 'calmar', t: 'Calmar', kind: 'ratio' },
  { k: 'total', t: '총수익', kind: 'pct' }, { k: 'period', t: '기간', kind: 'per' },
];
const LB_CAT = { dynamic: '동적', static: '정적', momentum: '모멘텀', crypto: '코인' };
async function _lbLoad() {
  if (state.recoLb) return state.recoLb;
  try { state.recoLb = ((await (await fetch('data/leaderboard.json', { cache: 'no-cache' })).json()).rows) || []; }
  catch (e) { state.recoLb = []; }
  return state.recoLb;
}
async function renderLeaderboard() {
  const host = document.getElementById('reco-lb'); if (!host) return;
  await _lbLoad();
  state.recoLbCcy = state.recoLbCcy || 'krw';               // 기본 원화(한국 투자자 실경험 통화)
  state.recoLbSort = state.recoLbSort || { k: 'sharpe', dir: -1 };   // 기본 Sharpe 내림차순
  state.recoLbCat = state.recoLbCat || 'all';
  if (!state._lbWired) {
    host.addEventListener('click', e => {
      const cc = e.target.closest('#reco-lb-ccy button');
      if (cc) { state.recoLbCcy = cc.dataset.ccy; return _lbDraw(); }
      const th = e.target.closest('th[data-k]');
      if (th) {                                             // 같은 열 재클릭=방향 토글, 새 열=텍스트 오름·숫자 내림
        const s = state.recoLbSort, k = th.dataset.k;
        s.dir = (s.k === k) ? -s.dir : ((k === 'name' || k === 'period') ? 1 : -1); s.k = k;
        return _lbDraw();
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) return gotoDataset(tr.dataset.id);
    });
    const catSel = document.getElementById('reco-lb-cat');
    if (catSel) catSel.addEventListener('change', () => { state.recoLbCat = catSel.value; _lbDraw(); });
    state._lbWired = true;
  }
  _lbDraw();
}
function _lbDraw() {
  const rows = state.recoLb || [], s = state.recoLbSort, cur = state.recoLbCcy, cat = state.recoLbCat;
  const pct = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
  const rat = x => (x == null || !isFinite(x)) ? '—' : Number(x).toFixed(2);
  document.querySelectorAll('#reco-lb-ccy button').forEach(b => b.classList.toggle('active', b.dataset.ccy === cur));
  const inf = s.dir > 0 ? Infinity : -Infinity;             // 결측은 항상 맨 아래로
  const num = v => (v == null || !isFinite(v)) ? inf : v;
  const list = rows.filter(r => r.cur === cur && (cat === 'all' || r.cat === cat)).slice().sort((a, b) => {
    if (s.k === 'name' || s.k === 'period') return s.dir * String(a[s.k] || '').localeCompare(String(b[s.k] || ''));
    return s.dir * (num(a[s.k]) - num(b[s.k]));
  });
  const head = '<tr>' + LB_COLS.map(c => {
    const numc = !['name', 'cat', 'period'].includes(c.k);
    // 활성 열은 ▲/▼, 그 외 정렬 가능한 열은 흐린 ↕ 를 항상 표시 → "클릭해 정렬" 신호를 명시.
    const arr = (c.k === s.k) ? `<span class="sort-active">${s.dir < 0 ? '▼' : '▲'}</span>` : '<span class="sort-ind">↕</span>';
    return `<th data-k="${c.k}"${numc ? ' class="num"' : ''}>${c.t} ${arr}</th>`;
  }).join('') + '</tr>';
  const body = list.map(r => '<tr data-id="' + r.id + '" title="클릭 → 전체 백테스트">' + LB_COLS.map(c => {
    if (c.k === 'name') return `<td class="lb-name">${r.name}</td>`;
    if (c.k === 'cat') return `<td>${LB_CAT[r.cat] || r.cat}</td>`;
    if (c.k === 'period') return `<td class="num">${_recoYears(r.period) || '—'}</td>`;
    return `<td class="num">${c.kind === 'ratio' ? rat(r[c.k]) : pct(r[c.k])}</td>`;
  }).join('') + '</tr>').join('');
  const tbl = document.getElementById('reco-lb-table');
  if (tbl) tbl.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  const cnt = document.getElementById('reco-lb-count');
  if (cnt) cnt.textContent = `${list.length}개 · ${cur === 'krw' ? '원화' : '달러'} 기준`;
}

// ③ '왜 자산배분' 그래프 — 실제 백테스트: 정적 '균형' 배분(파랑) vs S&P 500(빨강), USD 1997~.
// 배포된 균형 데이터셋(multi_allocation_balanced_usd.json)을 fetch 해 곡선 2개를 재정규화(시작=1)·로그로 그린다
// (주간 cron 갱신 → 항상 최신). 데이터를 못 받으면 개념 예시(가상 데이터)로 폴백. 결과는 state.guideAlloc 에 캐시.
function _renderGuideAllocChart() {
  const el = document.getElementById('guide-alloc-chart');
  if (!el || typeof Plotly === 'undefined') return;
  if (state.guideAlloc === 'synth') return _plotGuideAllocSynthetic(el);
  if (state.guideAlloc) return _plotGuideAllocReal(el, state.guideAlloc);
  fetch('data/multi_allocation_balanced_usd.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(d => {
      const ser = d.series || [];
      const bal = ser.find(s => s.name && s.name.startsWith('균형') && !s.name.includes('OFF') && !s.name.includes('MA200'));
      const spx = ser.find(s => s.name === 'S&P 500');
      if (!bal || !spx || !Array.isArray(bal.nav) || !Array.isArray(spx.nav)) throw 0;
      state.guideAlloc = { balDates: bal.dates, balNav: bal.nav, spxDates: spx.dates, spxNav: spx.nav };
      _plotGuideAllocReal(el, state.guideAlloc);
    })
    .catch(() => { state.guideAlloc = 'synth'; _plotGuideAllocSynthetic(el); });
}
// 시작=1 재정규화된 nav 배열 → 연변동성·MDD·CAGR·최종배수.
function _guideStats(nav) {
  const v = nav.filter(x => x != null);
  const rets = []; for (let i = 1; i < v.length; i++) rets.push(Math.log(v[i] / v[i - 1]));
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length) * Math.sqrt(12);
  let pk = -Infinity, mdd = 0; for (const x of v) { if (x > pk) pk = x; mdd = Math.min(mdd, x / pk - 1); }
  const yrs = (v.length - 1) / 12, fin = v[v.length - 1];
  return { vol, mdd, cagr: Math.pow(fin, 1 / yrs) - 1, fin };
}
function _plotGuideAllocReal(el, g) {
  const rebase = (nav) => { const b = nav.find(x => x != null); return nav.map(x => x == null ? null : x / b); };
  const balN = rebase(g.balNav), spxN = rebase(g.spxNav);
  const sB = _guideStats(balN), sS = _guideStats(spxN);
  const traces = [
    { type: 'scatter', mode: 'lines', name: 'S&P 500 (미국 주식 한 곳)', x: g.spxDates, y: spxN,
      line: { width: 1.5, color: '#ef4444' }, hovertemplate: '%{y:.2f}배<extra>S&P 500</extra>' },
    { type: 'scatter', mode: 'lines', name: '정적 자산배분 · 균형 (분산)', x: g.balDates, y: balN,
      line: { width: 2.0, color: '#2563eb' }, hovertemplate: '%{y:.2f}배<extra>균형 배분</extra>' },
  ];
  const layout = baseLayout('실제 비교 — 정적 ‘균형’ 배분 vs S&P 500 (USD, 1997~)', '누적 성장 (배, 시작=1·로그)');
  layout.yaxis.type = 'log';
  Plotly.newPlot(el, traces, layout, PLOTCFG);
  const cap = document.getElementById('guide-alloc-stats');
  if (cap) cap.textContent =
    `연 변동성: S&P 500 ≈ ${(sS.vol * 100).toFixed(0)}% vs 균형 ≈ ${(sB.vol * 100).toFixed(0)}% · `
    + `최대낙폭: ${(sS.mdd * 100).toFixed(0)}% vs ${(sB.mdd * 100).toFixed(0)}% · `
    + `최종 ${sS.fin.toFixed(1)}배 vs ${sB.fin.toFixed(1)}배 (CAGR ${(sS.cagr * 100).toFixed(1)}% vs ${(sB.cagr * 100).toFixed(1)}%) · 실제 백테스트(USD).`;
}
// 폴백 — 데이터를 못 받을 때만 쓰는 개념 예시(가상 데이터, 결정적 시드). 단일 자산 vs 분산.
function _plotGuideAllocSynthetic(el) {
  const N = 240, START_Y = 2005; let s = 606 >>> 0;
  const rnd = () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296;
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const inC1 = i => i >= 36 && i < 46, inC2 = i => i >= 120 && i < 126;
  const gS = [];
  for (let i = 0; i < N; i++) { let g = 0.0108 + 0.046 * gauss(); if (inC1(i)) g -= 0.075; if (inC2(i)) g -= 0.050; gS.push(g); }
  const gDb = [];
  for (let i = 0; i < N; i++) { let g = 0.0090 + 0.018 * gauss(); if (inC1(i)) g -= 0.020; if (inC2(i)) g -= 0.012; gDb.push(g); }
  const sumS = gS.reduce((a, b) => a + b, 0), sumDb = gDb.reduce((a, b) => a + b, 0), delta = (sumS - sumDb) / N;
  const gD = gDb.map(g => g + delta);
  const xs = [], navS = [], navD = []; let cs = 0, cd = 0;
  for (let i = 0; i < N; i++) {
    cs += gS[i]; cd += gD[i]; navS.push(Math.exp(cs)); navD.push(Math.exp(cd));
    const y = START_Y + Math.floor(i / 12), m = (i % 12) + 1;
    xs.push(`${y}-${String(m).padStart(2, '0')}-01`);
  }
  const sB = _guideStats(navD), sS = _guideStats(navS);
  const traces = [
    { type: 'scatter', mode: 'lines', name: '주식 100% (분산 안 함)', x: xs, y: navS,
      line: { width: 1.7, color: '#ef4444' }, hovertemplate: '%{y:.2f}배<extra>주식 100%</extra>' },
    { type: 'scatter', mode: 'lines', name: '분산 포트폴리오', x: xs, y: navD,
      line: { width: 2.0, color: '#2563eb' }, hovertemplate: '%{y:.2f}배<extra>분산</extra>' },
  ];
  Plotly.newPlot(el, traces, baseLayout('개념 예시 — 같은 수익, 다른 출렁임 (가상 데이터)', '누적 성장 (배)'), PLOTCFG);
  const cap = document.getElementById('guide-alloc-stats');
  if (cap) cap.textContent =
    `연 변동성: 주식 100% ≈ ${(sS.vol * 100).toFixed(0)}% vs 분산 ≈ ${(sB.vol * 100).toFixed(0)}% · `
    + `최대낙폭: ${(sS.mdd * 100).toFixed(0)}% vs ${(sB.mdd * 100).toFixed(0)}% · 최종 수익 동일(개념 예시·가상 데이터).`;
}
function _apct(x, dp = 1) { return (x === null || x === undefined || isNaN(x)) ? '–' : (x * 100).toFixed(dp) + '%'; }
function _anum(x, dp = 2) { return (x === null || x === undefined || isNaN(x)) ? '–' : (+x).toFixed(dp); }

// ---------------------------------------------------------------------------
// 도구·지표: 낙원계산기 / 시장 심리 / 추세 경보
// ---------------------------------------------------------------------------
function _krwCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e8) return s + (a / 1e8).toFixed(1) + '억';   // 항상 1자리(천만원 단위)까지 — 예: 15.3억
  if (a >= 1e4) return s + Math.round(a / 1e4).toLocaleString('ko-KR') + '만';
  return Math.round(n).toLocaleString('ko-KR') + '원';
}
function _moneyCompact(n, ccy) {            // 통화별 금액 축약(KRW=_krwCompact, USD=$K/M/B)
  if (n === null || n === undefined || isNaN(n)) return '–';
  if (ccy !== 'usd') return _krwCompact(n);
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K';
  return s + '$' + Math.round(a).toLocaleString('en-US');
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
    _attachComma('para-asset', paradiseRefresh);
    _attachComma('para-save', paradiseRefresh);
    ['para-years', 'para-nom', 'para-infl'].forEach(id =>
      document.getElementById(id).addEventListener('input', paradiseRefresh));
    document.getElementById('para-timing').addEventListener('change', paradiseRefresh);
    // 몬테카를로 모드 토글 + MC 입력
    document.querySelectorAll('#para-mode button').forEach(b =>
      b.addEventListener('click', () => setParadiseMode(b.dataset.mode)));
    _attachComma('mc-withdraw', paradiseRefresh);
    ['mc-paths', 'mc-sigma', 'mc-wyears'].forEach(id => document.getElementById(id).addEventListener('input', paradiseRefresh));
    document.getElementById('mc-src').addEventListener('change', () => {
      document.getElementById('mc-strat-wrap').classList.toggle('hidden', document.getElementById('mc-src').value !== 'boot');
      paradiseRefresh();
    });
    document.getElementById('mc-strat').addEventListener('change', paradiseRefresh);
    document.getElementById('mc-strat').innerHTML = state.manifest    // 단일곡선 데이터셋만
      .filter(m => m.file && !m.mode).map(m => `<option value="${m.file}">${m.label}</option>`).join('');
    state._paraWired = true;
  }
  paradiseRefresh();
}
function paradiseRefresh() { if (state.paraMode === 'mc') renderParadiseMC(); else renderParadise(); }
function setParadiseMode(m) {
  state.paraMode = m;
  setHidden('para-det', m !== 'det'); setHidden('para-mc', m !== 'mc');
  document.querySelectorAll('#para-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  document.getElementById('mc-strat-wrap').classList.toggle('hidden', document.getElementById('mc-src').value !== 'boot');
  paradiseRefresh();
}
function renderParadise() {
  const start = _pgv('para-asset', 0), save = _pgv('para-save', 18000000);
  const years = Math.max(1, Math.round(_pgv('para-years', 20)));
  const hint = document.getElementById('para-save-hint');
  if (hint) hint.textContent = `월 ${_krwCompact(save / 12)} × 12 · 매년 물가만큼 증가 가정`;
  const r = 1 + _pgv('para-nom', 10) / 100, g = 1 + _pgv('para-infl', 2.5) / 100;
  const realRate = g > 0 ? r / g - 1 : r - g;
  const due = document.getElementById('para-timing').value === 'begin' ? r : 1;  // 연초=annuity-due ⇒ ×(1+r)
  const xs = [], assetSeq = [], saveSeq = [];
  for (let n = 1; n <= years; n++) {
    xs.push(n);
    assetSeq.push(start * Math.pow(r, n));
    saveSeq.push(due * (Math.abs(r - g) < 1e-9 ? save * n * Math.pow(r, n - 1)
      : save * (Math.pow(r, n) - Math.pow(g, n)) / (r - g)));
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
  layout.xaxis = { title: { text: '연차', font: { color: muted } }, automargin: true, gridcolor: cssVar('--chart-grid'), tickfont: { color: muted } };
  Plotly.react('para-chart', [
    { type: 'bar', name: '자산 성장', x: xs, y: assetSeq, marker: { color: '#2563eb' } },
    { type: 'bar', name: '저축 누적', x: xs, y: saveSeq, marker: { color: '#10b981' } },
  ], layout, PLOTCFG);
}

// 몬테카를로 은퇴/인출 시뮬 — 시드 PRNG(analytics-live 와 동일 계열), 결정론 단일값 옆에 분포·생존율.
function _mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function _rngNormal(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function _monthlyReturnsFromSeries(dates, nav) {   // 월말 리샘플 후 전월 대비(일별 데이터 대응). Tier D 와 공용.
  const me = new Map();
  for (let i = 0; i < dates.length; i++) me.set(dates[i].slice(0, 7), nav[i]);
  const keys = [...me.keys()].sort(); const r = [];
  for (let k = 1; k < keys.length; k++) r.push(me.get(keys[k]) / me.get(keys[k - 1]) - 1);
  return r;
}
async function _mcBootReturns(file) {
  state.mcBoot = state.mcBoot || {};
  if (state.mcBoot[file]) return state.mcBoot[file];
  try {
    const d = await (await fetch('data/' + file, { cache: 'no-cache' })).json();
    const s = (d.series || [])[0]; if (!s) return null;
    const ret = _monthlyReturnsFromSeries(s.dates, s.nav); state.mcBoot[file] = ret; return ret;
  } catch (e) { return null; }
}
function mcRetirement(o) {
  // 2단계: ① 축적(accM개월, 매월 연간저축/12 투입 + 무작위 수익) → ② 인출(wdM개월, 무작위 수익 후 연인출액/12 차감).
  const accM = Math.max(0, Math.round(o.accumYears)) * 12, wdM = Math.max(0, Math.round(o.withdrawYears)) * 12;
  const N = Math.max(1, accM + wdM), K = Math.min(5000, Math.max(200, Math.round(o.paths)));
  const rng = _mulberry32(12345);
  const muM = Math.pow(1 + o.mu, 1 / 12) - 1, sigM = o.sigma / Math.sqrt(12), inflM = Math.pow(1 + o.inflation, 1 / 12) - 1;
  const s0 = (o.save || 0) / 12, w0 = o.annualWithdraw / 12;   // 저축·인출 모두 오늘 가치 → 인플레만큼 증가
  const begin = o.timing === 'begin';
  const boot = o.source === 'boot' && o.hist && o.hist.length;
  const byMonth = Array.from({ length: N + 1 }, () => []);
  let survived = 0;
  for (let p = 0; p < K; p++) {
    let bal = o.start, alive = true;
    byMonth[0].push(bal);
    for (let t = 1; t <= N; t++) {
      const r = boot ? o.hist[Math.floor(rng() * o.hist.length)] : muM + sigM * _rngNormal(rng);
      const infl = Math.pow(1 + inflM, t - 1);
      if (t <= accM) {                                   // 축적: 저축 투입 + 성장 (연초=투입 후 성장)
        const c = s0 * infl;
        bal = begin ? (bal + c) * (1 + r) : bal * (1 + r) + c;
      } else {                                           // 인출: 성장 − 인출
        bal = bal * (1 + r) - w0 * infl;
        if (bal <= 0) { bal = 0; alive = false; }
      }
      byMonth[t].push(bal);
    }
    if (alive) survived++;
  }
  const pct = (arr, q) => percentile([...arr].sort((a, b) => a - b), q);
  const p10 = [], p50 = [], p90 = [];
  for (let t = 0; t <= N; t++) { p10.push(pct(byMonth[t], 0.1)); p50.push(pct(byMonth[t], 0.5)); p90.push(pct(byMonth[t], 0.9)); }
  return { successRate: wdM > 0 ? survived / K : 1, p10, p50, p90, months: N, accMonths: accM, withdrawMonths: wdM, bootUsed: boot };
}
async function renderParadiseMC() {
  const start = _pgv('para-asset', 0), save = _pgv('para-save', 18000000);
  const accumYears = Math.max(0, Math.round(_pgv('para-years', 20))), withdrawYears = Math.max(0, Math.round(_pgv('mc-wyears', 30)));
  const mu = _pgv('para-nom', 10) / 100, sigma = _pgv('mc-sigma', 15) / 100, infl = _pgv('para-infl', 2.5) / 100;
  const withdraw = _pgv('mc-withdraw', 24000000), paths = _pgv('mc-paths', 2000);
  const timing = document.getElementById('para-timing').value;
  const source = document.getElementById('mc-src').value;
  let hist = null;
  if (source === 'boot') { const f = document.getElementById('mc-strat').value; if (f) hist = await _mcBootReturns(f); }
  const res = mcRetirement({ start, accumYears, withdrawYears, save, mu, sigma, inflation: infl, annualWithdraw: withdraw, paths, source, hist, timing });
  const npaths = Math.min(5000, Math.max(200, Math.round(paths))), dist = res.bootUsed ? '부트스트랩' : '정규';
  const card = (lab, v, sub) => `<div class="ext-card"><div class="lab">${lab}</div><div class="val">${v}</div><div class="sub">${sub || ''}</div></div>`;
  document.getElementById('mc-cards').innerHTML =
    card('자금 생존율', (res.successRate * 100).toFixed(0) + '%',
      `인출 ${withdrawYears}년 · ${npaths}경로 · ${dist}`) +
    card('은퇴 시점 자산 (p50)', _krwCompact(res.p50[res.accMonths]), `축적 ${accumYears}년 · 명목`) +
    card('종료 잔액 (p50)', _krwCompact(res.p50[res.months]), '명목') +
    card('종료 하위 10% (p10)', _krwCompact(res.p10[res.months]), '비관 시나리오');
  const xs = res.p50.map((_, t) => t / 12), muted = cssVar('--chart-muted');
  const traces = [
    { type: 'scatter', mode: 'lines', x: xs, y: res.p10, line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    { type: 'scatter', mode: 'lines', name: 'p10~p90', x: xs, y: res.p90, fill: 'tonexty', fillcolor: 'rgba(37,99,235,0.16)', line: { width: 0 }, hovertemplate: '%{y:,.0f}원<extra>p90</extra>' },
    { type: 'scatter', mode: 'lines', name: '중앙값(p50)', x: xs, y: res.p50, line: { width: 2, color: cssVar('--accent') }, hovertemplate: '%{y:,.0f}원<extra>p50</extra>' },
  ];
  const layout = baseLayout('자금 경로 분포 (백분위 밴드)', '잔액 (원)');
  layout.xaxis = { title: { text: '연차', font: { color: muted } }, automargin: true, gridcolor: cssVar('--chart-grid'), tickfont: { color: muted } };
  if (res.accMonths > 0 && res.withdrawMonths > 0) {   // 축적·인출 경계에 '은퇴' 점선
    const rx = res.accMonths / 12;
    layout.shapes = [{ type: 'line', x0: rx, x1: rx, yref: 'paper', y0: 0, y1: 1, line: { color: muted, width: 1, dash: 'dash' } }];
    layout.annotations = [{ x: rx, yref: 'paper', y: 1, yanchor: 'bottom', text: '은퇴', showarrow: false, font: { color: muted, size: 11 } }];
  }
  Plotly.react('mc-fan', traces, layout, PLOTCFG);
}

async function loadTool(entry, kind) {
  setToolsMode(true, kind);
  state.playground = false; state.analyticsActive = false; state._analyticsCur = null; state.data = null;
  state.allocCtx = null; _showAllocRebal(false);
  setStatus('불러오는 중…');
  try {
    const d = await fetch('data/' + entry.file, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    state.tool = { kind, data: d };
    setStatus('');
    document.getElementById('meta').textContent = `${entry.group} · 생성일 ${d.generated_at || '-'}`;
    if (kind === 'sentiment') renderSentiment(d);
    else if (kind === 'reliability') renderReliability(d);
    else if (kind === 'molit_explore') renderMolitExplore(d);
    else if (kind === 'molit_apt') enterMolitApt(d);
    else if (kind === 'leverage') enterLeverage(d);
    else renderTrend(d);
  } catch (e) { setStatus(entry.group + ' 로딩 실패: ' + e.message, true); }
}

// ---------------------------------------------------------------------------
// 최적 레버리지 (leverage) — S&P500·나스닥100 일별 상수레버리지 스윕 + 슬라이더 + 관리변동성.
// leverage.json(일별 under_ret·rf 임베드) → web/leverage.js(LEVERAGE) 가 브라우저에서 즉석 재계산.
// Tony Cooper(2010) "Alpha Generation and Risk Smoothing Using Managed Volatility" 재현.
// ---------------------------------------------------------------------------
const LEV_COL = { cur: '#2563eb', base: '#9ca3af', opt: '#16a34a', cooper: '#ca8a04', risk: '#dc2626', vol: '#ea580c' };

function enterLeverage(d) {
  state.playground = false; state.analyticsActive = false; state._analyticsCur = null; state.data = null;
  setToolsMode(true, 'leverage');
  state.lev = { d, under: d.default_underlying, period: d.default_period, scn: d.default_scenario, L: null, start: null, end: null };
  document.getElementById('meta').textContent = `${d.title || '최적 레버리지'} · 생성일 ${d.generated_at || '-'}`;
  document.getElementById('lev-intro').innerHTML =
    `일별 리밸런싱 상수 레버리지(L배)를 0~5×로 스윕해 <strong>연복리수익(CAGR)을 최대화하는 최적 L</strong>을 찾습니다. ` +
    `${(d.cooper_2010 && d.cooper_2010.note) || ''} 지수·기간·시나리오·레버리지를 바꾸면 브라우저에서 즉석 재계산됩니다.`;
  // 토글 버튼 구성
  document.getElementById('lev-under').innerHTML = d.underlyings
    .map((u, i) => `<button type="button" data-under="${u.key}"${u.key === state.lev.under ? ' class="active"' : ''}>${u.label}</button>`).join('');
  document.getElementById('lev-scn').innerHTML = Object.entries(d.scenarios)
    .map(([k, v]) => `<button type="button" data-scn="${k}"${k === state.lev.scn ? ' class="active"' : ''}>${v}</button>`).join('');
  _levBuildPeriods();
  _levApplyPeriodKey(state.lev.period);                    // 기본 프리셋 → start/end + 날짜입력 동기화
  if (!state._levWired) {
    document.getElementById('lev-under').addEventListener('click', e => _levToggle(e, 'under', () => {
      _levBuildPeriods();
      if (state.lev.period) _levApplyPeriodKey(state.lev.period);   // 프리셋이면 새 지수 기준 범위 재적용
      else _levClampRange();                                        // 커스텀이면 새 스팬으로 클램프
      _levFull();
    }));
    document.getElementById('lev-scn').addEventListener('click', e => _levToggle(e, 'scn', _levFull));
    document.getElementById('lev-period').addEventListener('click', e => {
      const b = e.target.closest('button[data-period]'); if (!b) return;
      _levApplyPeriodKey(b.dataset.period); _levFull();
    });
    const onLevDate = () => {                                // 사용자 지정 시작·종료일
      const u = _levU();
      const sv = document.getElementById('lev-start').value;
      const ev = document.getElementById('lev-end').value;
      if (!sv || !ev) return;                                // 한쪽이 미완성이면 무시
      // ※ 입력값을 되쓰지 않는다 — Chrome 은 월/일이 채워진 채 연도를 한 자리 칠 때마다(1→0001) change 를
      //   발생시키는데, 여기서 클램프+되쓰기를 하면 세그먼트가 리셋돼 연도를 완성할 수 없다(다른 탭은 value 를
      //   되쓰지 않아 정상). 범위는 계산용으로만 클램프하고, 표시 보정은 blur 에서만.
      let s = sv < u.span_start ? u.span_start : sv;
      let en = ev > u.span_end ? u.span_end : ev;
      if (s > en) { const t = s; s = en; en = t; }
      state.lev.start = s; state.lev.end = en; state.lev.period = null;  // 프리셋 해제(커스텀)
      _levHighlightPeriod(); _levFull();                     // 하이라이트만(입력 미터치)
    };
    const onLevBlur = () => { _levSyncPeriodUI(); };          // 포커스 떠난 뒤에만 클램프된 값으로 표시 보정
    ['lev-start', 'lev-end'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('change', onLevDate);              // 'input'(세그먼트마다)은 깜빡임 유발 → change 만
      el.addEventListener('blur', onLevBlur);
    });
    const sl = document.getElementById('lev-slider');
    sl.addEventListener('input', () => { state.lev.L = parseFloat(sl.value); _levLight(); });
    document.querySelectorAll('.lev-quick [data-lev]').forEach(b =>
      b.addEventListener('click', () => { state.lev.L = parseFloat(b.dataset.lev); _levSyncSlider(); _levLight(); }));
    document.getElementById('lev-set-opt').addEventListener('click', () => {
      const o = state.lev.sweepOpt && state.lev.sweepOpt.cagr_max;
      if (o) { state.lev.L = o.L; _levSyncSlider(); _levLight(); }
    });
    state._levWired = true;
  }
  _levFull();
}

function _levToggle(e, field, after) {
  const b = e.target.closest('button[data-' + field + ']'); if (!b) return;
  const v = b.dataset[field];
  state.lev[field] = v;
  b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  after && after();
}
function _levU() { return state.lev.d.underlyings.find(u => u.key === state.lev.under) || state.lev.d.underlyings[0]; }
function _levBuildPeriods() {
  const u = _levU();
  // period=null 은 '사용자 지정'(커스텀) 의도이므로 유지. 유효하지 않은 키만 첫 프리셋으로.
  if (state.lev.period != null && !u.periods.some(p => p.key === state.lev.period)) state.lev.period = u.periods[0].key;
  document.getElementById('lev-period').innerHTML = u.periods
    .map(p => `<button type="button" data-period="${p.key}"${p.key === state.lev.period ? ' class="active"' : ''}>${p.label}</button>`).join('');
  // 주의: date 입력에 min/max 를 걸면 Chrome 등에서 연도 키보드 입력이 깨진다(부분 입력 0002·0020 이
  // 범위 밖 → 연도가 0000 으로 리셋). 범위는 onLevDate 의 JS 클램프로만 강제하고 속성은 비운다.
  const sEl = document.getElementById('lev-start'), eEl = document.getElementById('lev-end');
  [sEl, eEl].forEach(el => { if (el) { el.removeAttribute('min'); el.removeAttribute('max'); } });
}
function _levApplyPeriodKey(key) {                   // 프리셋 키 → start/end + UI 동기화
  const u = _levU();
  const p = u.periods.find(x => x.key === key) || u.periods[0];
  state.lev.period = p.key; state.lev.start = p.start; state.lev.end = p.end;
  _levSyncPeriodUI();
}
function _levHighlightPeriod() {                      // 프리셋 버튼 하이라이트만(입력 미터치 — 타이핑 중 안전)
  document.querySelectorAll('#lev-period button').forEach(b =>
    b.classList.toggle('active', state.lev.period != null && b.dataset.period === state.lev.period));
}
function _levSyncPeriodUI() {                         // 하이라이트 + 날짜입력 값 동기화(프리셋·클램프·blur 전용)
  _levHighlightPeriod();
  const sEl = document.getElementById('lev-start'), eEl = document.getElementById('lev-end');
  // 값이 실제로 다를 때만 재기록. ※ 타이핑 중(onLevDate)엔 호출 금지 — 연도 세그먼트 리셋 유발.
  if (sEl && sEl.value !== state.lev.start) sEl.value = state.lev.start;
  if (eEl && eEl.value !== state.lev.end) eEl.value = state.lev.end;
}
function _levClampRange() {                           // 커스텀 범위를 현재 지수 스팬으로 클램프
  const u = _levU();
  let s = state.lev.start, en = state.lev.end;
  if (!s || s < u.span_start) s = u.span_start;
  if (!en || en > u.span_end) en = u.span_end;
  state.lev.start = s; state.lev.end = en; _levSyncPeriodUI();
}
function _levSyncSlider() {
  const sl = document.getElementById('lev-slider');
  sl.value = state.lev.L;
}
function _levFriction() {
  const u = _levU();
  return state.lev.scn === 'etf' ? { expense: u.friction.expense, spread: u.friction.spread } : { expense: 0, spread: 0 };
}
function _levSeg(range) {                                       // 기간 슬라이스된 일별 배열
  const u = _levU();                                           // range={start,end}(요약표용) 없으면 현재 state 범위
  const start = (range && range.start) || state.lev.start || u.span_start;
  const end = (range && range.end) || state.lev.end || u.span_end;
  const [lo, hi] = LEVERAGE.sliceRange(u.dates, start, end);
  return { u: u.under_ret.slice(lo, hi + 1), rf: u.rf.slice(lo, hi + 1),
           dates: u.dates.slice(lo, hi + 1), meta: { start: u.dates[lo], end: u.dates[hi] } };
}

// 무거운 재계산(지수·기간·시나리오 변경): 스윕·최적·요약·관리변동성 + 슬라이더 기본값.
function _levFull() {
  const d = state.lev.d, seg = _levSeg();
  const fr = _levFriction();
  state.lev.seg = seg; state.lev.fr = fr;
  const sw = LEVERAGE.sweep(seg.u, seg.rf, seg.dates, d.l_grid, fr);
  const opt = LEVERAGE.optimal(sw);
  state.lev.sweep = sw; state.lev.sweepOpt = opt;
  if (state.lev.L == null) state.lev.L = (opt.cagr_max ? opt.cagr_max.L : 2.0);
  _levSyncSlider();
  document.getElementById('lev-period-range').textContent =
    `${seg.meta.start} ~ ${seg.meta.end} (${seg.dates.length.toLocaleString()}거래일)`;
  _levRenderRisk(sw);
  _levRenderManaged(seg, fr);
  _levRenderSummary();
  _levLight();                                                 // 곡선·자산곡선·카드(L 의존)
}

// 가벼운 재계산(슬라이더): L 의존 — CAGR곡선 마커·자산곡선·카드만.
function _levLight() {
  const sl = document.getElementById('lev-slider');
  document.getElementById('lev-slider-readout').textContent = (+state.lev.L).toFixed(1) + '×';
  _levRenderCurve(state.lev.sweep, state.lev.sweepOpt);
  _levRenderEquity(state.lev.seg, state.lev.fr);
  _levRenderCards(state.lev.sweep, state.lev.sweepOpt);
  _levRenderDefense(state.lev.seg, state.lev.fr);
}

// MDD 방어 전략 비교 — 현재 L·기간·시나리오로 추세필터·관리변동성·절대모멘텀 오버레이를 즉석 계산.
function _levRenderDefense(seg, fr) {
  const L = state.lev.L, lx = (+L).toFixed(1);
  const mvOpts = { lMax: 3.0, expense: fr.expense, spread: fr.spread };
  const defs = [];
  const add = (name, ret, color, dash, w) => defs.push({
    name, color, dash: dash || 'solid', w: w || 1.5,
    m: LEVERAGE.metrics(ret, seg.dates), nav: LEVERAGE.navFromReturns(ret),
  });
  add(`${lx}× 보유`, LEVERAGE.leverReturns(seg.u, seg.rf, L, fr), LEV_COL.cur, 'solid', 1.9);
  add(`${lx}× + 200일선`, LEVERAGE.maFilterReturns(seg.u, seg.rf, L, 200, fr), '#16a34a', 'solid');
  add(`${lx}× + 60일선`, LEVERAGE.maFilterReturns(seg.u, seg.rf, L, 60, fr), '#0891b2', 'dot');
  add(`${lx}× + 절대모멘텀(12M)`, LEVERAGE.absMomReturns(seg.u, seg.rf, L, 252, fr), '#a16207', 'dot');
  add('관리변동성(목표20%)', LEVERAGE.managedVol(seg.u, seg.rf, 0.20, mvOpts).ret, '#9333ea', 'dash');
  add('200일선+관리변동성', LEVERAGE.maManagedReturns(seg.u, seg.rf, 0.20, 200, fr), LEV_COL.risk, 'solid', 1.8);
  add('1× 보유(참고)', seg.u, LEV_COL.base, 'solid');
  const idx = LEVERAGE.downsampleIdx(seg.dates.length, 1200), xs = idx.map(i => seg.dates[i]);
  const traces = defs.map(d => ({
    type: 'scatter', mode: 'lines', name: d.name, x: xs, y: idx.map(i => d.nav[i]),
    line: { width: d.w, color: d.color, dash: d.dash }, hovertemplate: '%{y:.2f}<extra>' + d.name + '</extra>',
  }));
  const layout = baseLayout('MDD 방어 전략 비교 (시작=1.0, 로그)', '누적 성장 (배, log)');
  layout.yaxis.type = 'log';
  Plotly.react('lev-defense', traces, layout, PLOTCFG);
  const calmar = m => (m.mdd != null && m.mdd < 0 && isFinite(m.cagr)) ? m.cagr / Math.abs(m.mdd) : null;
  const row = d => `<tr><td class="name">${d.name}</td><td>${_apct(d.m.cagr)}</td>` +
    `<td>${_apct(d.m.mdd, 0)}</td><td>${_anum(d.m.sharpe)}</td><td>${_anum(calmar(d.m))}</td></tr>`;
  document.getElementById('lev-defense-table').innerHTML =
    '<thead><tr><th class="name">전략</th><th>CAGR</th><th>MDD</th><th>Sharpe</th><th>Calmar</th></tr></thead>' +
    '<tbody>' + defs.map(row).join('') + '</tbody>';
}

function _levAtL(sw, L) {                                       // 격자(0.1)에서 L에 해당하는 인덱스 지표
  let bi = 0, bd = Infinity;
  for (let i = 0; i < sw.L.length; i++) { const dd = Math.abs(sw.L[i] - L); if (dd < bd) { bd = dd; bi = i; } }
  return { L: sw.L[bi], cagr: sw.cagr[bi], vol: sw.vol[bi], mdd: sw.mdd[bi], sharpe: sw.sharpe[bi] };
}

function _levRenderCurve(sw, opt) {
  const d = state.lev.d, L = state.lev.L;
  const cooperRef = (d.cooper_2010 && d.cooper_2010[state.lev.under]) || null;
  const traces = [{
    type: 'scatter', mode: 'lines', name: 'CAGR(L)', x: sw.L, y: sw.cagr.map(v => v == null ? null : v * 100),
    line: { width: 2, color: LEV_COL.cur }, hovertemplate: 'L %{x:.1f}× → CAGR %{y:.1f}%<extra></extra>',
  }];
  if (opt.cagr_max) traces.push({
    type: 'scatter', mode: 'markers+text', name: 'CAGR 최적',
    x: [opt.cagr_max.L], y: [opt.cagr_max.cagr * 100], text: [`최적 ${opt.cagr_max.L.toFixed(1)}×`],
    textposition: 'top center', textfont: { color: LEV_COL.opt, size: 11 },
    marker: { symbol: 'triangle-up', size: 13, color: LEV_COL.opt }, hoverinfo: 'skip',
  });
  const layout = baseLayout('CAGR vs 레버리지', '연복리수익 CAGR (%)');
  layout.xaxis.type = 'linear'; layout.xaxis.title = { text: '레버리지 L (×)', font: { color: cssVar('--chart-muted') } };
  layout.hovermode = 'closest';
  layout.shapes = [{ type: 'line', x0: L, x1: L, yref: 'paper', y0: 0, y1: 1,
    line: { color: LEV_COL.cur, width: 1, dash: 'dot' } }];
  layout.annotations = [{ x: L, yref: 'paper', y: 1, text: `현재 ${(+L).toFixed(1)}×`, showarrow: false,
    font: { color: LEV_COL.cur, size: 10 }, yanchor: 'bottom' }];
  if (cooperRef) {
    traces.push({ type: 'scatter', mode: 'markers', name: 'Cooper(2010) 참고',
      x: [cooperRef], y: [_levAtL(sw, cooperRef).cagr * 100],
      marker: { symbol: 'diamond', size: 11, color: LEV_COL.cooper }, hovertemplate: `Cooper 참고 ${cooperRef}×<extra></extra>` });
  }
  Plotly.react('lev-curve', traces, layout, PLOTCFG);
}

function _levRenderRisk(sw) {
  const traces = [
    { type: 'scatter', mode: 'lines', name: 'MDD', x: sw.L, y: sw.mdd.map(v => v == null ? null : Math.abs(v) * 100),
      line: { width: 2, color: LEV_COL.risk }, hovertemplate: 'L %{x:.1f}× → MDD −%{y:.0f}%<extra></extra>' },
    { type: 'scatter', mode: 'lines', name: '연변동성', x: sw.L, y: sw.vol.map(v => v == null ? null : v * 100),
      line: { width: 1.6, color: LEV_COL.vol, dash: 'dot' }, yaxis: 'y2', hovertemplate: 'L %{x:.1f}× → 변동성 %{y:.0f}%<extra></extra>' },
  ];
  const layout = baseLayout('위험 vs 레버리지', '최대낙폭 MDD (%)');
  layout.margin = { ...layout.margin, r: 52 };          // 우측 yaxis2(연변동성) 눈금·제목 공간
  layout.xaxis.type = 'linear'; layout.xaxis.title = { text: '레버리지 L (×)', font: { color: cssVar('--chart-muted') } };
  layout.hovermode = 'x unified';
  layout.yaxis2 = { title: { text: '연변동성 (%)', font: { color: cssVar('--chart-muted') } },
    overlaying: 'y', side: 'right', gridcolor: 'rgba(0,0,0,0)', tickfont: { color: cssVar('--chart-muted') } };
  Plotly.react('lev-risk', traces, layout, PLOTCFG);
}

function _levRenderEquity(seg, fr) {
  const L = state.lev.L, opt = state.lev.sweepOpt;
  const optL = opt.cagr_max ? opt.cagr_max.L : 2.0;
  const defs = [
    { L: 1.0, name: '1× (무레버리지)', color: LEV_COL.base, dash: 'solid', w: 1.4 },
    { L: L, name: `${(+L).toFixed(1)}× (현재)`, color: LEV_COL.cur, dash: 'solid', w: 1.9 },
    { L: optL, name: `${optL.toFixed(1)}× (CAGR 최적)`, color: LEV_COL.opt, dash: 'dot', w: 1.6 },
  ];
  const idx = LEVERAGE.downsampleIdx(seg.dates.length, 1400);
  const xs = idx.map(i => seg.dates[i]);
  const traces = defs.map(def => {
    const nav = LEVERAGE.navFromReturns(LEVERAGE.leverReturns(seg.u, seg.rf, def.L, fr));
    return { type: 'scatter', mode: 'lines', name: def.name, x: xs, y: idx.map(i => nav[i]),
      line: { width: def.w, color: def.color, dash: def.dash }, hovertemplate: '%{y:.2f}<extra>' + def.name + '</extra>' };
  });
  const layout = baseLayout('자산곡선 (시작=1.0, 로그)', '누적 성장 (배, log)');
  layout.yaxis.type = 'log';
  Plotly.react('lev-equity', traces, layout, PLOTCFG);
}

function _levRenderCards(sw, opt) {
  const cur = _levAtL(sw, state.lev.L), base = _levAtL(sw, 1.0);
  const o = opt.cagr_max || cur;
  const card = (lab, v, sub, cls) => `<div class="ext-card"><div class="lab">${lab}</div>` +
    `<div class="val"${cls ? ` style="color:${cls}"` : ''}>${v}</div><div class="sub">${sub || ''}</div></div>`;
  document.getElementById('lev-cards').innerHTML =
    card(`현재 ${(+state.lev.L).toFixed(1)}× · CAGR`, _apct(cur.cagr), `MDD ${_apct(cur.mdd, 0)} · 변동성 ${_apct(cur.vol, 0)}`, LEV_COL.cur) +
    card('현재 · Sharpe', _anum(cur.sharpe), '위험대비수익') +
    card('1× 대비', (cur.cagr != null && base.cagr != null ? ((cur.cagr - base.cagr) >= 0 ? '+' : '') + ((cur.cagr - base.cagr) * 100).toFixed(1) + '%p' : '–'), `1× CAGR ${_apct(base.cagr)}`) +
    card('CAGR 최적 L', o.L != null ? o.L.toFixed(1) + '×' : '–', `CAGR ${_apct(o.cagr)} · MDD ${_apct(o.mdd, 0)}`, LEV_COL.opt) +
    card('Sharpe 최적 L', opt.sharpe_max ? opt.sharpe_max.L.toFixed(1) + '×' : '–', opt.sharpe_max ? `Sharpe ${_anum(opt.sharpe_max.sharpe)}` : '');
}

function _levRenderManaged(seg, fr) {
  const u = _levU();
  // 고정 최적 L vs 목표변동성(15·20%) 동적 레버리지 — 선택 기간 기준 즉석 재계산.
  const optL = state.lev.sweepOpt.cagr_max ? state.lev.sweepOpt.cagr_max.L : 2.0;
  const idx = LEVERAGE.downsampleIdx(seg.dates.length, 1200);
  const xs = idx.map(i => seg.dates[i]);
  const series = [];
  const fixedRet = LEVERAGE.leverReturns(seg.u, seg.rf, optL, fr);
  const fixedNav = LEVERAGE.navFromReturns(fixedRet);
  const fixedM = LEVERAGE.metrics(fixedRet, seg.dates);
  series.push({ name: `고정 ${optL.toFixed(1)}× (최적)`, color: LEV_COL.opt, dash: 'solid', nav: fixedNav, m: fixedM, sub: '' });
  const TVS = [{ tv: 0.15, color: LEV_COL.cur }, { tv: 0.20, color: LEV_COL.cooper }];
  for (const t of TVS) {
    const mv = LEVERAGE.managedVol(seg.u, seg.rf, t.tv, { lMax: 3.0, expense: fr.expense, spread: fr.spread });
    const nav = LEVERAGE.navFromReturns(mv.ret);
    series.push({ name: `관리변동성 목표 ${(t.tv * 100).toFixed(0)}%`, color: t.color, dash: 'dot',
      nav, m: LEVERAGE.metrics(mv.ret, seg.dates), sub: `평균 ${mv.avgL.toFixed(1)}×` });
  }
  const traces = series.map(s => ({ type: 'scatter', mode: 'lines', name: s.name, x: xs, y: idx.map(i => s.nav[i]),
    line: { width: 1.7, color: s.color, dash: s.dash }, hovertemplate: '%{y:.2f}<extra>' + s.name + '</extra>' }));
  const layout = baseLayout('관리 변동성 vs 고정 레버리지 (시작=1.0, 로그)', '누적 성장 (배, log)');
  layout.yaxis.type = 'log';
  Plotly.react('lev-managed', traces, layout, PLOTCFG);
  const card = (lab, m, sub, col) => `<div class="ext-card"><div class="lab">${lab}</div>` +
    `<div class="val"${col ? ` style="color:${col}"` : ''}>${_apct(m.cagr)}</div>` +
    `<div class="sub">MDD ${_apct(m.mdd, 0)} · Sharpe ${_anum(m.sharpe)}${sub ? ' · ' + sub : ''}</div></div>`;
  document.getElementById('lev-managed-cards').innerHTML = series.map(s => card(s.name, s.m, s.sub, s.color)).join('');
}

function _levRenderSummary() {
  const d = state.lev.d, u = _levU(), fr = _levFriction();
  const cooperRef = (d.cooper_2010 && d.cooper_2010[state.lev.under]) || null;
  const rows = u.periods.map(p => {
    const seg = _levSeg(p);
    const sw = LEVERAGE.sweep(seg.u, seg.rf, seg.dates, d.l_grid, fr);
    const opt = LEVERAGE.optimal(sw);
    const c = opt.cagr_max || {};
    return `<tr><td class="name">${p.label}</td><td>${p.start}~${p.end}</td>` +
      `<td><strong>${c.L != null ? c.L.toFixed(1) + '×' : '–'}</strong></td>` +
      `<td>${_apct(c.cagr)}</td><td>${_apct(c.mdd, 0)}</td>` +
      `<td>${opt.sharpe_max ? opt.sharpe_max.L.toFixed(1) + '×' : '–'}</td></tr>`;
  }).join('');
  const head = '<thead><tr><th class="name">기간</th><th>구간</th><th>CAGR 최적 L</th><th>CAGR</th><th>MDD</th><th>Sharpe 최적 L</th></tr></thead>';
  const cooperRow = cooperRef ? `<tr style="opacity:.8"><td class="name">Cooper(2010) 참고</td><td>≤2009 근사</td><td><strong>${cooperRef.toFixed(1)}×</strong></td><td>–</td><td>–</td><td>–</td></tr>` : '';
  document.getElementById('lev-summary').innerHTML = head + '<tbody>' + rows + cooperRow + '</tbody>';
  document.getElementById('lev-findings').innerHTML = '📌 ' + (d.findings || '');
  const v = u.validation || {};
  document.getElementById('lev-validation').innerHTML = v.available
    ? `🔬 합성 3× vs 실제 ${v.fund}: 일간수익 상관 ${_anum(v['일간수익_상관'])}, 누적수익비 ${_anum(v['누적수익비(합성/실제)'])}, 연 추적오차 ${_apct(v['연추적오차'], 1)} — 합성 레버리지가 실제 LETF를 잘 재현(신뢰성 확인).`
    : '';
}

// ---------------------------------------------------------------------------
// 시군구 조회 (molit_explore) — 거래량·전세가율 월간 추이(절대값) + 최근 실거래 상세표.
// 곡선 백테스트가 아니라 raw 레벨/표라 전용 렌더(도구 모드처럼 백테스트 섹션 숨김).
// ---------------------------------------------------------------------------
function _meLayout(title, ysuffix) {
  return {
    title: { text: title, font: { size: 13, color: cssVar('--fg') } },
    margin: { l: 52, r: 14, t: 36, b: 38 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    xaxis: { type: 'date', gridcolor: cssVar('--chart-grid'), linecolor: cssVar('--chart-grid'),
             tickfont: { color: cssVar('--chart-muted') } },
    yaxis: { gridcolor: cssVar('--chart-grid'), ticksuffix: ysuffix || '',
             tickfont: { color: cssVar('--chart-muted') } },
    legend: { font: { size: 10, color: cssVar('--chart-muted') }, orientation: 'h' },
    showlegend: true, hovermode: 'x unified',
  };
}

function renderMolitExplore(d) {
  const dates = d.dates || [], regions = d.regions || [];
  const cfg = { displaylogo: false, responsive: true };
  const line = (key, suffix) => regions.map((r, i) => ({
    type: 'scatter', mode: 'lines', name: r, x: dates, y: (d[key][r] || []),
    line: { width: 1.3, color: PALETTE[i % PALETTE.length] },
    hovertemplate: `${r} %{x|%Y-%m}: %{y}${suffix}<extra></extra>`,
  }));
  Plotly.react('me-volume', line('volume', '건'), _meLayout('월별 매매 거래량 (건)', ''), cfg);
  Plotly.react('me-jeonse', line('jeonse_ratio', '%'), _meLayout('전세가율 추이 (전세 ㎡보증금 / 매매 ㎡가, %)', '%'), cfg);
  const hasW = d.wolse_count && regions.some(r => (d.wolse_count[r] || []).some(v => v > 0));
  setHidden('me-wolse', !hasW); setHidden('me-convr', !hasW);
  if (hasW) {
    Plotly.react('me-wolse', line('wolse_count', '건'), _meLayout('월별 월세 거래량 (건)', ''), cfg);
    Plotly.react('me-convr', line('conversion', '%'),     // 전월세전환율(연%·㎡정규화)
      _meLayout('전월세 전환율 추이 (월세×12 / 전세−월세 보증금차, %)', '%'), cfg);
  }

  const aptEntry = state.manifest.find(mf => mf.mode === 'molit_apt' && mf.category === 're_' + d.city);
  const rows = (d.recent || []).map(t =>
    `<tr><td>${t.region}</td><td class="name">${aptEntry
      ? `<a href="#" class="me-apt-link" data-region="${t.region}" data-apt="${t.apt}"` +
        ` data-umd="${t.umd || ''}" data-area="${t.area}">${t.apt}</a>`
      : t.apt}</td><td>${t.umd || '-'}</td>` +
    `<td>${t.area}㎡</td><td>${t.floor == null ? '-' : t.floor + '층'}</td>` +
    `<td>${t.build == null ? '-' : t.build}</td><td>${(t.price / 10000).toFixed(1)}억</td></tr>`).join('');
  const head = '<tr><th>구</th><th class="name">단지</th><th>법정동</th><th>전용</th><th>층</th><th>건축년</th><th>거래가</th></tr>';
  document.getElementById('me-recent').innerHTML =
    `<table class="metrics"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  document.getElementById('me-recent').onclick = (e) => {     // 단지 클릭 → 단지 조회 뷰로 점프
    const a = e.target.closest('a.me-apt-link');
    if (!a) return;
    e.preventDefault();
    _jumpToApt(d.city, a.dataset.region, a.dataset.apt, a.dataset.umd, parseFloat(a.dataset.area));
  };
  document.getElementById('me-recent-cap').textContent =
    `최근 실거래 — ${d.recent_ym || '-'} 거래금액 상위 ${(d.recent || []).length}건 (국토교통부 실거래가)`;
  document.getElementById('me-desc').textContent =
    `${d.city} 시군구별 월간 매매 거래량·전세가율·월세 거래량·전월세전환율 추이(실거래 집계) + 최근 실거래 상세. ` +
    '전월세전환율(연%) = 월세×12 / (전세−월세 보증금차), ㎡ 정규화로 면적 통제. ' +
    '⚠ 시군구 월별값은 거래 단지 구성에 따라 출렁임(구성편향)·소지역/최근월 희박 주의.' +
    (aptEntry ? ' 단지명을 클릭하면 단지 조회(추이·백테스트)로 이동합니다.' : '');
}

// ---------------------------------------------------------------------------
// 단지 조회 (molit_apt) — 개별 아파트 월 중위가 추이·전세가율 + 매수후보유 백테스트.
// 인덱스 payload(도시) → 구 선택 시 data/apt/{sgg}.json 레이지 로드(캐시), 단지 선택 시
// 거래상세 data/apt/{sgg}_tx.json 로드. NAV 수학은 web/re_apt.js(RE_APT — Python 패리티 검증).
// ---------------------------------------------------------------------------
function _aptKeyJs(s) {                                  // src/data/re/apt.py name_key 미러
  return String(s).normalize('NFC').replace(/\s+/g, '').toLowerCase();
}
function _aptMiIso(mi) {                                 // 월 인덱스 → ISO(월초; 차트 월 표시용)
  const d = state.apt.index;
  const t = +d.months0.slice(0, 4) * 12 + (+d.months0.slice(5, 7) - 1) + mi;
  return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0') + '-01';
}
function _aptBundle() { const s = state.apt; return s.sel.sgg ? s.bundles[s.sel.sgg] : null; }
function _aptComplex() {
  const b = _aptBundle(), s = state.apt.sel;
  return (b && s.ci >= 0) ? b.complexes[s.ci] : null;
}
function _aptBand() {
  const c = _aptComplex(), s = state.apt.sel;
  return c ? c.bands.find(x => x.b === s.band) : null;
}
async function _aptFetchJson(file, cacheName, sgg) {
  const cache = state.apt[cacheName];
  if (cache[sgg]) return cache[sgg];
  const fl = state.apt._inflight, key = cacheName + ':' + sgg;   // 동시 중복 다운로드 방지
  if (!fl[key]) {
    fl[key] = fetch('data/' + file, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { cache[sgg] = d; return d; })
      .finally(() => { delete fl[key]; });
  }
  return fl[key];
}

function enterMolitApt(d) {
  state.apt.index = d;
  document.getElementById('ma-desc').textContent =
    `${d.city} 개별 단지 실거래 — 구 → 단지 → 전용면적 순으로 고르면 월 중위가 추이·전세가율과 ` +
    '매수후보유 백테스트(브라우저 계산)를 보여줍니다. ⚠ 단지 월 중위가는 층·동·상태 미통제 ' +
    '(동일주택 반복거래 지수가 아님) — 구성편향 주의.';
  document.getElementById('ma-bt-cost').textContent =
    `(취득 ${(d.costs.entry * 100).toFixed(1)}% + 보유세 연 ${(d.costs.holding_annual * 100).toFixed(2)}% 차감 — 브라우저 계산)`;
  document.getElementById('ma-gu').innerHTML =
    d.regions.map(r => `<option value="${r.sgg}">${r.name} (${r.complexes}단지)</option>`).join('');
  if (!state.apt._wired) { _wireApt(); state.apt._wired = true; }
  const pre = state.apt.preselect;
  state.apt.preselect = null;
  let sgg = d.regions.length ? d.regions[0].sgg : '';
  if (pre) { const r = d.regions.find(x => x.name === pre.region); if (r) sgg = r.sgg; }
  else if (state.apt.sel.sgg && d.regions.some(r => r.sgg === state.apt.sel.sgg)) sgg = state.apt.sel.sgg;  // 재진입 유지
  document.getElementById('ma-gu').value = sgg;
  _aptSelectGu(sgg, pre);
}

function _wireApt() {
  document.getElementById('ma-gu').addEventListener('change', e => _aptSelectGu(e.target.value, null));
  const input = document.getElementById('ma-apt');
  input.addEventListener('change', _aptResolveInput);            // IME 안전 — 확정은 change 에서만
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;              // 한글 조합 중 Enter 무시
    if (e.key === 'Enter') { e.preventDefault(); _aptResolveInput(); }
  });
  document.getElementById('ma-bt-start').addEventListener('change', e => {
    state.apt.sel.startMi = e.target.value === '' ? null : parseInt(e.target.value, 10);
    _renderAptBacktest();
  });
}

async function _aptSelectGu(sgg, pre) {
  const d = state.apt.index;
  if (!d) return;
  const region = d.regions.find(r => r.sgg === sgg);
  if (!region) return;
  state.apt.sel = { sgg, ci: -1, band: null, startMi: null };
  setStatus('단지 번들 불러오는 중…');
  let b;
  try { b = await _aptFetchJson(region.file, 'bundles', sgg); }
  catch (e) {                                                    // 스테일 응답이 활성 뷰를 덮지 않게
    if (state.apt.sel.sgg === sgg) setStatus(`${region.name} 단지 번들 로딩 실패: ${e.message}`, true);
    return;
  }
  if (state.apt.sel.sgg !== sgg) return;                         // 로딩 중 구 변경 — 무시
  setStatus('');
  document.getElementById('ma-apt-list').innerHTML =             // 거래수순(번들 정렬) + 동명 구분
    b.complexes.map(c => `<option value="${c.apt} (${c.umd})"></option>`).join('');
  document.getElementById('ma-apt').value = '';
  const top = document.getElementById('ma-top');
  top.innerHTML = b.complexes.slice(0, 10)
    .map((c, i) => `<button type="button" data-ci="${i}">${c.apt}</button>`).join('');
  top.querySelectorAll('button').forEach(btn =>
    btn.addEventListener('click', () => { state.apt.sel.band = null; _aptSelectComplex(+btn.dataset.ci); }));
  _renderAptSelect(b);                                           // 구 내 단지 선택 전략(연구용)
  let ci = -1;
  if (pre) {                                                     // explore 표 클릭 프리셀렉트
    const k = _aptKeyJs(pre.apt);
    ci = b.complexes.findIndex(c => _aptKeyJs(c.apt) === k && (!pre.umd || c.umd === pre.umd));
    if (ci < 0) ci = b.complexes.findIndex(c => _aptKeyJs(c.apt) === k);
    if (ci >= 0 && pre.area != null && !isNaN(pre.area)) {
      // explore 표 면적은 1자리 반올림(84.97→85.0)이라 floor 가 경계에서 빗나감 —
      // 대표 전용면적이 가장 가까운 밴드로 매칭(±1㎡ 이내일 때만).
      let best = null, dmin = Infinity;
      for (const x of b.complexes[ci].bands) {
        const dd = Math.abs(x.area - pre.area);
        if (dd < dmin) { dmin = dd; best = x.b; }
      }
      if (best != null && dmin <= 1) state.apt.sel.band = best;
    }
  }
  if (ci >= 0) _aptSelectComplex(ci);
  else _aptClearView();
}

function _aptSelectComplex(ci) {
  const b = _aptBundle();
  if (!b || !b.complexes[ci]) return;
  const c = b.complexes[ci];
  state.apt.sel.ci = ci;
  if (!c.bands.some(x => x.b === state.apt.sel.band)) {          // 기본 = 매매 최다 밴드
    let best = c.bands[0], bestN = -1;
    for (const bd of c.bands) {
      const n = bd.sale.n.reduce((a, x) => a + x, 0);
      if (n > bestN) { bestN = n; best = bd; }
    }
    state.apt.sel.band = best.b;
  }
  state.apt.sel.startMi = null;
  document.getElementById('ma-apt').value = `${c.apt} (${c.umd})`;
  _renderAptBands();
  renderAptAll();
  _aptEnsureTx();                                                // 거래상세 비동기 — 도착 시 갱신
}

function _aptResolveInput() {
  const b = _aptBundle();
  if (!b) return;
  const v = document.getElementById('ma-apt').value.trim();
  if (!v) return;
  const exact = b.complexes.findIndex(c => `${c.apt} (${c.umd})` === v);
  if (exact >= 0) { state.apt.sel.band = null; return _aptSelectComplex(exact); }
  const k = _aptKeyJs(v.replace(/\s*\(.*\)\s*$/, ''));           // "(법정동)" 접미 제거 후 prefix 매칭
  const hits = b.complexes.reduce((acc, c, i) => (_aptKeyJs(c.apt).startsWith(k) && acc.push(i), acc), []);
  if (hits.length === 1) { state.apt.sel.band = null; _aptSelectComplex(hits[0]); }
}

async function _aptEnsureTx() {
  const d = state.apt.index, sgg = state.apt.sel.sgg;
  const region = d && d.regions.find(r => r.sgg === sgg);
  if (!region || state.apt.txCache[sgg]) return;
  delete state.apt.txFail[sgg];                                  // 재선택 시 재시도 허용
  try { await _aptFetchJson(region.tx_file, 'txCache', sgg); }
  catch (e) { state.apt.txFail[sgg] = true; }                    // 거래상세 없음 — 시계열만 표시
  if (state.apt.sel.sgg === sgg) renderAptAll();                 // 도착/실패 후 산점도·표·캡션 갱신
}

function _aptClearView() {
  state.apt.sel.ci = -1; state.apt.sel.band = null; state.apt.sel.startMi = null;
  document.getElementById('ma-bands').innerHTML = '';
  document.getElementById('ma-meta').textContent = '단지명을 검색하거나 위 상위 단지 버튼을 누르세요.';
  ['ma-price', 'ma-jr', 'ma-wolse', 'ma-bt'].forEach(id => { const el = document.getElementById(id); if (el) Plotly.purge(el); });
  document.getElementById('ma-jr').style.display = 'none';
  document.getElementById('ma-wolse').style.display = 'none';
  document.getElementById('ma-bt-cards').innerHTML = '';
  document.getElementById('ma-bt-note').textContent = '';
  document.getElementById('ma-bt-start').innerHTML = '';
  document.getElementById('ma-tx').innerHTML = '';
  document.getElementById('ma-tx-cap').textContent = '';
}

function _renderAptBands() {
  const c = _aptComplex(), el = document.getElementById('ma-bands');
  if (!c) { el.innerHTML = ''; return; }
  el.innerHTML = c.bands.map(bd => {
    const n = bd.sale.n.reduce((a, x) => a + x, 0);
    return `<button type="button" data-b="${bd.b}" class="${bd.b === state.apt.sel.band ? 'active' : ''}">` +
      `${bd.area}㎡ (${n}건)</button>`;
  }).join('');
  el.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    state.apt.sel.band = parseInt(btn.dataset.b, 10);
    state.apt.sel.startMi = null;
    _renderAptBands();
    renderAptAll();
  }));
}

function renderAptAll() {
  const d = state.apt.index, b = _aptBundle(), c = _aptComplex(), bd = _aptBand();
  if (!d || !b || !c || !bd) return;
  document.getElementById('ma-meta').textContent =
    `${b.name} ${c.umd} · ${c.apt} · 전용 ${bd.area}㎡ · 건축 ${c.build == null ? '-' : c.build}년 · ` +
    `누적 매매 ${c.sale_n.toLocaleString()}건 / 전세 ${c.jeonse_n.toLocaleString()}건` +
    (c.wolse_n ? ` / 월세 ${c.wolse_n.toLocaleString()}건` : '');
  _renderAptPrice();
  _renderAptJr();
  _renderAptWolse();
  _renderAptStartOptions();
  _renderAptBacktest();
  _renderAptTx();
}

function _renderAptPrice() {
  const b = _aptBundle(), bd = _aptBand();
  if (!bd) return;
  const traces = [{
    type: 'scatter', mode: 'lines+markers', name: '단지 중위 ㎡가',
    x: bd.sale.mi.map(_aptMiIso), y: bd.sale.px.map(p => +(p / bd.area).toFixed(1)),
    customdata: bd.sale.n, line: { width: 2, color: cssVar('--accent') }, marker: { size: 5 },
    hovertemplate: '%{x|%Y-%m} %{y}만원/㎡ (%{customdata}건)<extra>단지</extra>',
  }];
  const tx = state.apt.txCache[state.apt.sel.sgg];
  if (tx) {                                                      // 개별 실거래 산점(매매)
    const xs = [], ys = [], cd = [];
    for (let i = 0; i < tx.tx.ci.length; i++) {
      if (tx.tx.ci[i] !== state.apt.sel.ci || tx.tx.side[i] !== 0) continue;
      if (Math.floor(tx.tx.area[i] / 10) !== bd.b || tx.tx.price[i] == null) continue;
      xs.push(_aptMiIso(tx.tx.mi[i]).slice(0, 8) + String(tx.tx.day[i] || 15).padStart(2, '0'));
      ys.push(+(tx.tx.price[i] / (tx.tx.area[i] / 10)).toFixed(1));
      cd.push([tx.tx.floor[i] == null ? '-' : tx.tx.floor[i] + '층', (tx.tx.price[i] / 10000).toFixed(1)]);
    }
    if (xs.length) traces.push({
      type: 'scatter', mode: 'markers', name: `실거래 (최근 ${tx.window_years}년)`,
      x: xs, y: ys, customdata: cd, marker: { size: 5, opacity: 0.45, color: PALETTE[3] },
      hovertemplate: '%{x|%Y-%m-%d} · %{customdata[0]} · %{customdata[1]}억<extra></extra>',
    });
  }
  traces.push({
    type: 'scatter', mode: 'lines', name: `${b.name} 중위`, connectgaps: false,
    x: b.gu.sale_ppa.map((_, i) => _aptMiIso(i)), y: b.gu.sale_ppa,
    line: { width: 1.2, dash: 'dot', color: cssVar('--chart-muted') },
    hovertemplate: '%{x|%Y-%m} %{y}만원/㎡<extra>' + b.name + '</extra>',
  });
  Plotly.react('ma-price', traces,
    _meLayout('매매 중위 ㎡가 (만원/㎡) — 마커=실거래 발생월', ''), { displaylogo: false, responsive: true });
}

function _renderAptJr() {
  const d = state.apt.index, b = _aptBundle(), bd = _aptBand();
  const el = document.getElementById('ma-jr');
  const hasJ = bd && bd.jeonse.mi.length > 0;
  el.style.display = hasJ ? '' : 'none';
  if (!hasJ) return;
  // 단지 전세가율 = 전세 중위보증금 / 매매 평활레벨(같은 달, 희박월은 직전가) ×100
  const dense = RE_APT.denseSeries(bd.sale, d.n_months, { smooth: d.smooth });
  const xs = [], ys = [];
  for (let k = 0; k < bd.jeonse.mi.length; k++) {
    const lvl = dense[bd.jeonse.mi[k]];
    if (lvl == null) continue;
    xs.push(_aptMiIso(bd.jeonse.mi[k]));
    ys.push(+((bd.jeonse.depo[k] / lvl) * 100).toFixed(1));
  }
  const traces = [
    { type: 'scatter', mode: 'lines+markers', name: '단지 전세가율', x: xs, y: ys,
      line: { width: 2, color: cssVar('--accent') }, marker: { size: 5 },
      hovertemplate: '%{x|%Y-%m} %{y}%<extra>단지</extra>' },
    { type: 'scatter', mode: 'lines', name: `${b.name} 중위`, connectgaps: false,
      x: b.gu.jeonse_ratio.map((_, i) => _aptMiIso(i)), y: b.gu.jeonse_ratio,
      line: { width: 1.2, dash: 'dot', color: cssVar('--chart-muted') },
      hovertemplate: '%{x|%Y-%m} %{y}%<extra>' + b.name + '</extra>' }];
  Plotly.react('ma-jr', traces,
    _meLayout('전세가율 (전세 중위보증금 / 매매 평활가, %)', '%'), { displaylogo: false, responsive: true });
}

// 단지 월세 추이 + 전월세전환율 — 중위 월세(만원, 좌축) + 전환율(%, 우축, 같은 밴드라 면적 통제).
// 전환율 = 월세×12 / (전세 중위보증금 − 월세 중위보증금) × 100, 두 보증금이 같은 달에 있을 때.
function _renderAptWolse() {
  const bd = _aptBand(), el = document.getElementById('ma-wolse');
  const hasW = bd && bd.wolse && bd.wolse.mi.length > 0;
  el.style.display = hasW ? '' : 'none';
  if (!hasW) return;
  const rx = bd.wolse.mi.map(_aptMiIso), rent = bd.wolse.rent;
  const jdepo = {};                                  // 전세 중위보증금: mi → depo (전환율 분모용)
  for (let k = 0; k < bd.jeonse.mi.length; k++) jdepo[bd.jeonse.mi[k]] = bd.jeonse.depo[k];
  const cx = [], cy = [];
  for (let k = 0; k < bd.wolse.mi.length; k++) {
    const jd = jdepo[bd.wolse.mi[k]], wd = bd.wolse.depo[k];
    if (jd == null || jd - wd <= 0) continue;        // 전세보증금 데이터 없거나 분모 ≤0 → 건너뜀
    cx.push(_aptMiIso(bd.wolse.mi[k]));
    cy.push(+(bd.wolse.rent[k] * 12 / (jd - wd) * 100).toFixed(2));
  }
  const traces = [
    { type: 'scatter', mode: 'lines+markers', name: '중위 월세(만원)', x: rx, y: rent,
      line: { width: 2, color: cssVar('--accent') }, marker: { size: 5 },
      hovertemplate: '%{x|%Y-%m} 월 %{y}만원<extra>월세</extra>' },
    { type: 'scatter', mode: 'lines+markers', name: '전월세전환율(%)', x: cx, y: cy, yaxis: 'y2',
      line: { width: 1.6, color: PALETTE[3], dash: 'dot' }, marker: { size: 4 },
      hovertemplate: '%{x|%Y-%m} %{y}%<extra>전환율</extra>' }];
  const layout = _meLayout('월세·전월세전환율 (좌: 중위 월세 만원 · 우: 전환율 %)', '');
  layout.yaxis2 = { overlaying: 'y', side: 'right', ticksuffix: '%', showgrid: false,
                    tickfont: { color: cssVar('--chart-muted') } };
  Plotly.react('ma-wolse', traces, layout, { displaylogo: false, responsive: true });
}

function _renderAptStartOptions() {
  const bd = _aptBand(), sel = document.getElementById('ma-bt-start');
  if (!bd) { sel.innerHTML = ''; return; }
  sel.innerHTML = bd.sale.mi.map(mi => `<option value="${mi}">${_aptMiIso(mi).slice(0, 7)}</option>`).join('');
  if (state.apt.sel.startMi == null || !bd.sale.mi.includes(state.apt.sel.startMi))
    state.apt.sel.startMi = bd.sale.mi[0];
  sel.value = String(state.apt.sel.startMi);
}

function _renderAptBacktest() {
  const d = state.apt.index, b = _aptBundle(), bd = _aptBand();
  if (!d || !b || !bd) return;
  const note = document.getElementById('ma-bt-note');
  const cards = document.getElementById('ma-bt-cards');
  const startMi = state.apt.sel.startMi;
  const g = RE_APT.guards(bd, d.bt_guards, bd.bt ? startMi : null);
  if (!bd.bt || !g.ok) {                                         // 희박 가드 — 추이만 제공
    cards.innerHTML = '';
    Plotly.purge(document.getElementById('ma-bt'));
    note.textContent = `⚠ 데이터 부족으로 백테스트 생략 — ${g.reason || '거래 희박'}. 위 추이 차트만 참고하세요.`;
    return;
  }
  note.textContent = `⚠ 단지 월 중위가는 거래 희박월 직전가 유지(ffill)·${d.smooth}개월 평활 — ` +
    '실제 체결 변동보다 부드럽게 보이고, 동일주택 반복거래가 아니라 구성편향이 남습니다. ' +
    '세 곡선 모두 같은 비용을 차감해 비교합니다(양도세 미반영).';
  const costs = { entry: d.costs.entry, holdingAnnual: d.costs.holding_annual, exitCost: 0 };
  const dense = RE_APT.denseSeries(bd.sale, d.n_months, { smooth: d.smooth });
  const rng = RE_APT.validRange(dense);
  const s0 = Math.max(rng.first, startMi == null ? rng.first : startMi);
  if (rng.last - s0 < 12) {
    cards.innerHTML = '';
    Plotly.purge(document.getElementById('ma-bt'));
    note.textContent = '⚠ 선택한 매수 시점 이후 데이터가 12개월 미만 — 시점을 앞당겨 보세요.';
    return;
  }
  const dates = [];
  for (let i = s0; i <= rng.last; i++) dates.push(_aptMiIso(i));
  const series = [{ name: `단지 (전용 ${bd.area}㎡)`, color: cssVar('--accent'), w: 2,
                    nav: RE_APT.netNav(dense.slice(s0, rng.last + 1), costs) }];
  const guSparse = { mi: [], px: [] };                           // 시군구 중위 — 같은 평활·같은 비용
  b.gu.sale_ppa.forEach((v, i) => { if (v != null) { guSparse.mi.push(i); guSparse.px.push(v); } });
  const guDense = RE_APT.denseSeries(guSparse, d.n_months, { smooth: d.smooth });
  if (guDense[s0] != null && guDense[rng.last] != null)
    series.push({ name: `${b.name} 중위`, color: PALETTE[1], w: 1.3,
                  nav: RE_APT.netNav(guDense.slice(s0, rng.last + 1), costs) });
  if (b.index && b.index.values[s0] != null) {                   // 부동산원 실거래지수(도시)
    const iv = b.index.values.slice(s0, rng.last + 1);
    if (!iv.some(v => v == null))
      series.push({ name: b.index.name, color: PALETTE[2], w: 1.3, nav: RE_APT.netNav(iv, costs) });
  }
  // 갭투자 오버레이: 매수 시점 전세가율로 전세 무이자 레버리지(1/(1−전세가율)) 적용한 자기자본 NAV.
  // 이 프로젝트의 '살아남은 엣지' — 전세보증금 무이자 레버리지를 단지 단위로 적용.
  let gapRatio = null;
  if (bd.jeonse.mi.length) {
    const jDense = RE_APT.denseSeries({ mi: bd.jeonse.mi, px: bd.jeonse.depo }, d.n_months, { smooth: d.smooth });
    for (let k = s0; k <= rng.last; k++) {        // 매수시점 이후 전세가 처음 잡히는 달의 전세가율(진입 레버)
      if (jDense[k] != null && dense[k]) { gapRatio = jDense[k] / dense[k]; break; }
    }
  }
  if (gapRatio != null && gapRatio > 0.2 && gapRatio < 0.95) {
    series.push({ name: `갭 매수 (전세레버 ${(1 / (1 - gapRatio)).toFixed(1)}x)`, color: PALETTE[4], w: 1.6,
                  nav: RE_APT.gapEquityNav(dense.slice(s0, rng.last + 1), gapRatio, costs), gap: true });
    note.textContent += ` 갭 매수선은 매수월 전세가율 ${(gapRatio * 100).toFixed(0)}%(레버 ` +
      `${(1 / (1 - gapRatio)).toFixed(1)}x)로 집값 변동을 증폭 — ⚠ 자기자본 가치만 표시하며 역전세 시 보증금 반환 현금부담은 별도 리스크.`;
  }
  cards.innerHTML = series.map(s => {
    const mt = computeMetrics(dates, s.nav, 12);
    return `<div class="ext-card"><div class="lab">${s.name}</div>` +
      `<div class="val">${_apct(mt.CAGR)}</div>` +
      `<div class="sub">연복리 · MDD ${_apct(mt.mdd)} · 총 ${_apct(mt.total, 0)}</div></div>`;
  }).join('');
  const traces = series.map((s, i) => ({
    type: 'scatter', mode: 'lines', name: s.name, x: dates, y: s.nav,
    line: { width: s.w, color: s.color, dash: s.gap ? 'dash' : (i === 0 ? undefined : 'dot') },
    hovertemplate: '%{x|%Y-%m} %{y:.3f}<extra>' + s.name + '</extra>',
  }));
  Plotly.react('ma-bt', traces,
    _meLayout(`매수후보유 NAV (${dates[0].slice(0, 7)} 매수 = 1.0, 비용 차감)`, ''),
    { displaylogo: false, responsive: true });
}

function _renderAptTx() {
  const tx = state.apt.txCache[state.apt.sel.sgg];
  const bd = _aptBand(), c = _aptComplex();
  const cap = document.getElementById('ma-tx-cap'), wrap = document.getElementById('ma-tx');
  if (!bd || !c) { cap.textContent = ''; wrap.innerHTML = ''; return; }
  if (!tx) {
    cap.textContent = state.apt.txFail[state.apt.sel.sgg]
      ? '거래 상세를 불러오지 못했습니다 — 시계열·백테스트만 표시' : '거래 상세 불러오는 중…';
    wrap.innerHTML = '';
    return;
  }
  const idxs = [];
  let total = 0;
  for (let i = tx.tx.ci.length - 1; i >= 0; i--) {               // 파일은 오름차순 → 역순=최신순
    if (tx.tx.ci[i] !== state.apt.sel.ci || Math.floor(tx.tx.area[i] / 10) !== bd.b) continue;
    total++;
    if (idxs.length < 1000) idxs.push(i);
  }
  const SIDE = { 0: '매매', 1: '전세', 2: '월세' };
  const rentArr = tx.tx.rent || [];                              // 월세(만원) — side=2 에만 의미
  const body = idxs.map(i => {
    const a = tx.tx.area[i] / 10, p = tx.tx.price[i], side = tx.tx.side[i];
    const dayS = tx.tx.day[i] == null ? '' : '-' + String(tx.tx.day[i]).padStart(2, '0');
    // 가격: 매매=거래가(억), 전세=보증금(억), 월세=보증금(억)/월세(만원)
    const priceCell = p == null ? '-' : (side === 2
      ? `${(p / 10000).toFixed(1)}억 / 월 ${(rentArr[i] || 0).toLocaleString()}만`
      : `${(p / 10000).toFixed(1)}억`);
    return `<tr><td>${_aptMiIso(tx.tx.mi[i]).slice(0, 7)}${dayS}</td>` +
      `<td>${SIDE[side] || '전세'}</td><td>${a}㎡</td>` +
      `<td>${tx.tx.floor[i] == null ? '-' : tx.tx.floor[i] + '층'}</td>` +
      `<td>${priceCell}</td></tr>`;
  }).join('');
  wrap.innerHTML = '<table class="metrics"><thead><tr><th>거래일</th><th>구분</th><th>전용</th>' +
    `<th>층</th><th>가격(억)·월세</th></tr></thead><tbody>${body}</tbody></table>`;
  cap.textContent = `${c.apt} 전용 ${bd.area}㎡ 실거래 — 최근 ${tx.window_years}년 ${total.toLocaleString()}건` +
    (total > idxs.length ? ` 중 최신 ${idxs.length}건 표시` : '') + ' (국토교통부, 매매가·전세/월세 보증금·월세)';
}

// 구 내 단지 횡단면 선택 전략(연구용) — 번들의 사전계산 NAV(동일비중·모멘텀·밸류·콤보)를 그린다.
// 단지 선택과 무관(구 단위) — 구 번들 로드 시 1회 렌더. 거래 가능 전략이 아니라 신호 연구.
function _renderAptSelect(b) {
  const note = document.getElementById('ma-sel-note');
  const cards = document.getElementById('ma-sel-cards');
  const el = document.getElementById('ma-sel');
  const sel = b && b.select;
  if (!sel || !sel.curves || !sel.dates) {
    cards.innerHTML = ''; note.textContent = `${b ? b.name + ' — ' : ''}선택 전략 표본 부족(장기 거래 단지 8개 미만) — 생략.`;
    Plotly.purge(el); return;
  }
  note.textContent = `${b.name} 최근 ${Math.round(sel.dates.length / 12)}년 내내 거래된 단지 ${sel.universe}개를 ` +
    '매월 신호로 Top10 동일비중 보유(연 1회 리밸·부동산 라운드트립 비용 차감), 벤치=동일비중. ' +
    '⚠ 아파트는 비유동·통째 매수라 월별 리밸이 비현실적이고, 구간 내내 거래된 단지만 남겨 생존편향이 있는 ' +
    '**신호 예측력 연구**입니다(거래 가능 전략 아님). 선택 신호가 동일비중을 못 이기면 "분산 보유" 손이 낫다는 뜻.';
  const names = Object.keys(sel.curves);
  cards.innerHTML = names.map((nm, i) => {
    const mt = computeMetrics(sel.dates, sel.curves[nm], 12);
    return `<div class="ext-card"><div class="lab">${nm}</div><div class="val">${_apct(mt.CAGR)}</div>` +
      `<div class="sub">연복리 · MDD ${_apct(mt.mdd)} · 총 ${_apct(mt.total, 0)}</div></div>`;
  }).join('');
  const traces = names.map((nm, i) => ({
    type: 'scatter', mode: 'lines', name: nm, x: sel.dates, y: sel.curves[nm],
    line: { width: i === 0 ? 2.2 : 1.4, color: i === 0 ? cssVar('--accent') : PALETTE[i],
            dash: i === 0 ? undefined : 'dot' },
    hovertemplate: '%{x|%Y-%m} %{y:.3f}<extra>' + nm + '</extra>',
  }));
  Plotly.react(el, traces, _meLayout(`${b.name} 단지 선택 전략 NAV (시작=1.0, 비용 차감)`, ''),
    { displaylogo: false, responsive: true });
}

function _jumpToApt(city, regionShort, aptName, umd, area) {     // explore 표 → 단지 뷰 점프
  const entry = state.manifest.find(mf => mf.mode === 'molit_apt' && mf.category === 're_' + city);
  if (!entry) return;
  state.apt.preselect = { region: regionShort, apt: aptName, umd: umd || '', area: isNaN(area) ? null : area };
  if (state.nav.group === entry.group) loadTool(entry, 'molit_apt');
  else setGroup(entry.group);                                    // setGroup→setCurrency→loadTool 체인
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

// 시장심리 추세 차트 — 분류 임계와 동일한 컬러 존(_vixClass/_dxyClass/_gsrClass/_fgClass 대응)
const VIX_ZONES = [[0, 15, '#10b981'], [15, 20, '#84cc16'], [20, 30, '#ea580c'], [30, 40, '#dc2626'], [40, 200, '#991b1b']];
const DXY_ZONES = [[0, 95, '#10b981'], [95, 105, '#6b7280'], [105, 200, '#ea580c']];
const GSR_ZONES = [[0, 50, '#10b981'], [50, 80, '#6b7280'], [80, 400, '#ea580c']];
const CRYPTO_ZONES = [[0, 25, '#dc2626'], [25, 45, '#ea580c'], [45, 55, '#6b7280'], [55, 75, '#84cc16'], [75, 100, '#10b981']];

// .chart 컨테이너의 '내용영역' 높이(전체 − 패딩 − 보더). Plotly SVG 를 이 높이로 그려야 박스 안에
// 꼭 맞는다 — clientHeight(=내용+패딩)로 그리면 SVG 가 패딩만큼 박스 밑으로 넘쳐 바로 아래 캡션
// (#senti-note)을 덮는다(헤드리스 측정: clientHeight +7px 침범 vs 내용영역 −9px 여유). 높이를 안
// 주면 Plotly 가 컨테이너를 못 재 기본 450px 로 그릴 수도 있어, 어느 경우든 이 값으로 명시한다.
function _chartBodyHeight(elId) {
  const el = document.getElementById(elId);
  const cs = getComputedStyle(el);
  const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const body = el.clientHeight - padV;                 // 보일 때: 정확한 내용영역 높이
  if (body > 40) return body;
  // 조상 숨김 등으로 측정 0 → 지정 height(border-box) − 패딩 − 보더로 추정, 없으면 282(=300px 박스).
  const borderV = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const styleH = parseFloat(cs.height);
  return styleH > 40 ? (styleH - padV - borderV) : 282;
}

// 범용 추세 라인 차트(+ 선택적 임계 컬러 존). points: [{t,v}]. 숨김 div 0폭 회피 위해 보일 때 호출.
function _sentiChart(elId, title, points, zones, opts = {}) {
  const pts = (points || []).filter(p => p && p.v != null);
  if (!pts.length) { setHidden(elId, true); return; }
  setHidden(elId, false);   // 보여야 컨테이너 높이를 잴 수 있음(숨김 상태면 0 → _chartBodyHeight 폴백)
  const layout = baseLayout(title, opts.ytitle || '');
  layout.height = _chartBodyHeight(elId);   // 내용영역 높이로 그려 캡션 겹침 방지(+패딩 오버플로 제거)
  if (opts.yrange) layout.yaxis.range = opts.yrange;
  if (zones) layout.shapes = zones.map(([y0, y1, c]) =>
    ({ type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0, y1, fillcolor: c, opacity: 0.1, line: { width: 0 }, layer: 'below' }));
  Plotly.react(elId, [{ type: 'scatter', mode: 'lines', x: pts.map(p => p.t), y: pts.map(p => p.v),
    line: { color: cssVar('--chart-fg'), width: 2 }, hovertemplate: '%{y:,.2f}<extra>%{x}</extra>' }], layout, PLOTCFG);
}

// 금·은 가격 2축(스케일 차이 큼: 금 ~$수천/oz · 은 ~$수십/oz)
function _metalPriceChart(elId, gold, silver) {
  const g = (gold || []).filter(p => p && p.v != null), s = (silver || []).filter(p => p && p.v != null);
  if (!g.length && !s.length) { setHidden(elId, true); return; }
  setHidden(elId, false);   // 보여야 컨테이너 높이를 잴 수 있음 — _sentiChart 와 동일 이유
  const muted = cssVar('--chart-muted');
  const layout = baseLayout('금·은 가격 (5년)', '금 $/oz');
  layout.height = _chartBodyHeight(elId);   // 내용영역 높이로 그려 캡션 겹침 방지
  layout.yaxis2 = { title: { text: '은 $/oz', font: { color: muted } }, overlaying: 'y', side: 'right', showgrid: false, tickfont: { color: muted } };
  const tr = [];
  if (g.length) tr.push({ type: 'scatter', mode: 'lines', name: '금', x: g.map(p => p.t), y: g.map(p => p.v), line: { color: '#f59e0b', width: 2 }, hovertemplate: '금 $%{y:,.0f}<extra></extra>' });
  if (s.length) tr.push({ type: 'scatter', mode: 'lines', name: '은', x: s.map(p => p.t), y: s.map(p => p.v), yaxis: 'y2', line: { color: '#9ca3af', width: 2 }, hovertemplate: '은 $%{y:,.2f}<extra></extra>' });
  Plotly.react(elId, tr, layout, PLOTCFG);
}

function _cryptoFgChart(elId, cf) {
  if (!cf || !cf.history || !cf.history.length) { setHidden(elId, true); return; }
  const pts = [...cf.history].reverse().map(p => ({ t: new Date(p.timestamp * 1000).toISOString().slice(0, 10), v: p.value }));
  _sentiChart(elId, '크립토 공포·탐욕 30일', pts, CRYPTO_ZONES, { ytitle: '지수', yrange: [0, 100] });
}

// 카드 1장 HTML(색·라벨·설명·임계)
function _sentiCard(title, val, cls, hint, thresh) {
  const col = cls ? cls.c : 'var(--fg)';
  return `<div class="senti-card"><div class="senti-t">${title}</div>` +
    `<div class="senti-v" style="color:${col}">${val}</div>` +
    `<div class="senti-l" style="color:${col}">${cls ? cls.l : ''}</div>` +
    (cls && cls.d ? `<div class="senti-s">${cls.d}</div>` : (hint ? `<div class="senti-s">${hint}</div>` : '')) +
    (thresh ? `<div class="senti-th">${thresh}</div>` : '') + `</div>`;
}

function renderSentiment(d) {
  // 게이지·카드(순수 HTML)를 주제별 컨테이너에 분배 — 차트는 setSentimentView 에서 보일 때 렌더
  // 미국 증시: CNN 공포·탐욕 게이지 + VIX 카드
  let usFg = '';
  if (d.cnn_fg && d.cnn_fg.score != null) {
    const prev = [['전일', d.cnn_fg.previous_close], ['1주전', d.cnn_fg.previous_1_week], ['1달전', d.cnn_fg.previous_1_month]]
      .filter(([, v]) => v != null).map(([k, v]) => `<span><b>${_anum(v, 0)}</b> ${k}</span>`).join('');
    usFg = _fgGauge('CNN 공포·탐욕', d.cnn_fg.score, _fgClass(d.cnn_fg.score),
      `<div class="fg-prev">🇺🇸 미국 주식${d.cnn_fg.rating ? ' · ' + d.cnn_fg.rating : ''}${prev ? ' · ' + prev : ''}</div>`);
  }
  document.getElementById('senti-fg-us').innerHTML = usFg;
  document.getElementById('senti-cards-us').innerHTML =
    _sentiCard('VIX 변동성', _anum(d.vix), _vixClass(d.vix), 'S&P500 향후 30일 내재변동성', '평온&lt;15 · 정상15-20 · 불안20-30 · 공포30-40 · 패닉≥40');

  // 달러·환율: DXY 카드
  document.getElementById('senti-cards-fx').innerHTML =
    _sentiCard('달러 인덱스 (DXY)', _anum(d.dxy), _dxyClass(d.dxy), '6통화 대비 달러 강도', '약달러&lt;95 · 정상95-105 · 강달러≥105');

  // 귀금속: 금/은비 카드 + 금 김프 카드
  let metalCards = _sentiCard('금/은 비율', _anum(d.gold_silver_ratio), _gsrClass(d.gold_silver_ratio),
    `금 $${_anum(d.gold, 0)} · 은 $${_anum(d.silver)}`, 'Silver&lt;50 · 정상50-80 · Gold≥80(위험회피)');
  if (d.gold_kimchi) metalCards += _sentiCard('금 김프', _apct(d.gold_kimchi.premium_pct / 100), _kimchiClass(d.gold_kimchi.premium_pct),
    'KRX 금 vs 국제(USD 환산)', '양수=한국이 비쌈');
  document.getElementById('senti-cards-metal').innerHTML = metalCards;

  // 코인: 크립토 공포·탐욕 게이지 + 비트 김프 카드
  let coinFg = '';
  if (d.crypto_fg && d.crypto_fg.value != null) {
    coinFg = _fgGauge('크립토 공포·탐욕', d.crypto_fg.value, _fgClass(d.crypto_fg.value),
      `<div class="fg-prev">🪙 코인${d.crypto_fg.classification ? ' · ' + d.crypto_fg.classification : ''}</div>`);
  }
  document.getElementById('senti-fg-coin').innerHTML = coinFg;
  document.getElementById('senti-cards-coin').innerHTML = d.btc_kimchi
    ? _sentiCard('비트코인 김프', _apct(d.btc_kimchi.premium_pct / 100), _kimchiClass(d.btc_kimchi.premium_pct),
        `업비트 ${_krwCompact(d.btc_kimchi.upbit_krw)}`, '정상|값|&lt;10% · 과열15-20% · 극단≥20%') : '';

  const errs = Object.keys(d.errors || {});
  document.getElementById('senti-note').textContent = errs.length
    ? `미수신 지표: ${errs.join(', ')} (소스 일시 차단/지역제한 가능 — best-effort)` : '';

  if (!state._sentiWired) {                  // 내부 탭 1회 와이어링(낙원계산기 모드 토글과 동일 방식)
    document.querySelectorAll('#senti-subtabs button').forEach(b =>
      b.addEventListener('click', () => setSentimentView(b.dataset.view)));
    state._sentiWired = true;
  }
  setSentimentView(state.sentimentView || 'us');
}

function setSentimentView(view) {
  state.sentimentView = view;
  ['us', 'fx', 'metal', 'coin'].forEach(v => setHidden('senti-' + v, v !== view));
  document.querySelectorAll('#senti-subtabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const d = state.tool && state.tool.data; if (!d) return;
  const S = d.series || {};
  if (view === 'us') _sentiChart('chart-vix', 'VIX 변동성 (5년)', S.vix, VIX_ZONES, { ytitle: 'VIX' });
  else if (view === 'fx') _sentiChart('chart-dxy', '달러 인덱스 DXY (5년)', S.dxy, DXY_ZONES, { ytitle: 'DXY' });
  else if (view === 'metal') { _sentiChart('chart-gsr', '금/은 비율 (5년)', S.gold_silver_ratio, GSR_ZONES, { ytitle: '배' }); _metalPriceChart('chart-metal', S.gold, S.silver); }
  else if (view === 'coin') _cryptoFgChart('chart-crypto', d.crypto_fg);
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
  // 분석 자산: 같은 자산 유니버스(=같은 데이터셋 통화 토글)면 선택 유지, 다른 데이터셋(예: 부동산 포함)이면 전체로 리셋.
  const allKeys = (payload.assets || []).map(a => a.key);
  const sameUniverse = Array.isArray(state._analyticsKeys)
    && state._analyticsKeys.length === allKeys.length
    && state._analyticsKeys.every((k, i) => k === allKeys[i]);
  if (!sameUniverse || !(state.selectedAssets || []).length) state.selectedAssets = allKeys.slice();
  state._analyticsKeys = allKeys;
  renderAssetSelector();
  recomputeAnalytics();
}

// 정량분석 전통 포트폴리오 유니버스 프리셋(자산 부분집합). keys=null → 전체.
const ANALYTICS_UNIVERSES = [
  { label: '전체', keys: null, tip: '현재 데이터셋의 전 자산' },
  { label: '미국 60/40', keys: ['us_stock', 'us_bond'], tip: '미국 주식·장기국채(클래식 60/40)' },
  { label: '영구 포트폴리오', keys: ['us_stock', 'us_bond', 'gold'], tip: '해리 브라운 — 주식·장기채·금(+현금)' },
  { label: '올웨더 근사', keys: ['us_stock', 'us_bond', 'gold', 'silver'], tip: '레이 달리오 풍 — 주식·채권·금·은' },
  { label: '글로벌 주식', keys: ['us_stock', 'kr_stock', 'cn_stock', 'in_stock'], tip: '미·한·중·인 주식' },
  { label: '글로벌 주식+채권', keys: ['us_stock', 'kr_stock', 'cn_stock', 'in_stock', 'us_bond', 'kr_bond'], tip: '4국 주식 + 미·한 채권' },
  { label: '부동산 비교', keys: ['re_seoul', 're_kr', 'kr_stock', 'us_stock', 'gold', 'kr_bond'], tip: '부동산(서울·전국) vs 주식·금·채권 (부동산 포함 데이터셋에서)' },
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
      const pp = state.analyticsPayload; if (!pp) return;   // 현재 데이터셋 기준(스테일 클로저 방지)
      const cb = e.target.closest('input[data-asset]'); if (!cb) return;
      const s = new Set(state.selectedAssets); cb.checked ? s.add(cb.dataset.asset) : s.delete(cb.dataset.asset);
      state.selectedAssets = (pp.assets || []).map(a => a.key).filter(k => s.has(k));
      recomputeAnalytics(); renderAssetSelector();
    });
    if (uh) uh.addEventListener('click', e => {
      const pp = state.analyticsPayload; if (!pp) return;
      const b = e.target.closest('button[data-univ]'); if (!b) return;
      const all = (pp.assets || []).map(a => a.key), u = ANALYTICS_UNIVERSES[+b.dataset.univ];
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

function renderCorrelation(d, el = 'an-corr') {
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
  Plotly.react(el, [trace], layout, PLOTCFG);
}

function renderFrontier(d, opts = {}) {
  const el = opts.el || 'an-frontier';
  const mineName = opts.mineName || '내 포트폴리오';
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
  // 내 포트폴리오/블렌드 점(◇) — opts.mine 우선, 없으면 전략 탐색기 state.explorer.mine
  const mine = (opts.mine !== undefined) ? opts.mine : (state.explorer && state.explorer.mine);
  if (mine) traces.push({ type: 'scatter', mode: 'markers', name: mineName,
    x: [mine.vol * 100], y: [mine.ret * 100],
    marker: { size: 16, symbol: 'diamond-open', color: '#e11d48', line: { width: 2.5, color: '#e11d48' } },
    hovertemplate: mineName + '<br>CAGR %{y:.1f}% · 변동성 %{x:.1f}%<extra></extra>' });
  const layout = baseLayout('', '');
  layout.xaxis = { title: { text: '연환산 변동성 %', font: { color: muted } }, automargin: true, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted }, zeroline: false };
  layout.yaxis = { title: { text: '연환산 수익률 %', font: { color: muted } }, automargin: true, gridcolor: grid, zerolinecolor: grid, tickfont: { color: muted } };
  layout.hovermode = 'closest';
  layout.legend = { orientation: 'h', y: -0.16, font: { size: 10, color: fg } };
  Plotly.react(el, traces, layout, PLOTCFG);
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
  state.allocCtx = null; _showAllocRebal(false);
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
    // 벤치마크(KOSPI·S&P 등)는 데이터셋마다 자기 구간으로 재정규화돼 총수익이 다르다. 같은 이름이면
    // **비결측 NAV가 가장 긴(=가장 완전한 이력)** 버전을 곡선·표·지표 모두에서 채택 → 비교 구성이 같으면
    // 항상 같은(전체이력) 벤치마크가 결정적으로 표시되고 곡선=표가 일치. 전략(고유명)은 1개뿐이라 무영향.
    const chosen = new Map();   // name -> { len, series, td, mr }
    const navLen = s => (s.nav || []).reduce((a, v) => a + (v != null ? 1 : 0), 0);
    const order = [];
    for (const d of ds) for (const s of (d.series || [])) {
      if (!chosen.has(s.name)) order.push(s.name);
      const len = navLen(s), cur = chosen.get(s.name);
      if (!cur || len > cur.len) chosen.set(s.name, { len, series: s, td: (d.table_display || {})[s.name], mr: (d.metrics_raw || {})[s.name] });
    }
    for (const nm of order) {
      const c = chosen.get(nm);
      merged.series.push(c.series);
      if (c.td) merged.table_display[nm] = c.td;
      if (c.mr) merged.metrics_raw[nm] = c.mr;
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
  // 200일선 필터 체크박스: 신호 없는(구버전) 패널이면 숨김
  const pgMa = document.getElementById('pg-ma');
  if (pgMa) {
    const has = !!panel.ma_signal;
    if (!has) pgMa.checked = false;
    if (pgMa.parentElement) pgMa.parentElement.classList.toggle('hidden', !has);
  }
  // 핸들러 (1회 바인딩)
  if (!state._pgWired) {
    document.getElementById('pg-weights').addEventListener('input', runPlayground);
    document.getElementById('pg-rebalance').addEventListener('change', runPlayground);
    document.getElementById('pg-band').addEventListener('input', runPlayground);
    if (pgMa) pgMa.addEventListener('change', runPlayground);
    const pgLev = document.getElementById('pg-leverage');
    if (pgLev) pgLev.addEventListener('input', runPlayground);
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
// 월별 NAV에 상수 레버리지 적용(플레이그라운드 근사): r_L = L·r − (L−1)·rf/12. rf=연,소수(월말).
// 일별 정확 분석은 '정량분석 · 최적 레버리지' 탭. L≤1 또는 rf 없으면 원본 그대로.
function _leverNav(navArr, win, rfMonthly, L) {
  if (!(L > 1.0001) || !rfMonthly) return navArr;
  const out = new Array(navArr.length);
  out[0] = navArr[0] == null ? null : 1.0;
  let v = 1.0;
  for (let k = 1; k < navArr.length; k++) {
    if (navArr[k] == null || navArr[k - 1] == null || navArr[k - 1] === 0) { out[k] = null; continue; }
    const rm = navArr[k] / navArr[k - 1] - 1;
    const rf = (rfMonthly[win[k]] || 0) / 12;
    let rl = L * rm - (L - 1) * rf;
    if (rl < -0.99) rl = -0.99;
    v *= (1 + rl); out[k] = v;
  }
  return out;
}

// 공유: 비중·주기·밴드 → alloc.js 즉석 백테스트 → 통화곡선+벤치마크 → synth 데이터셋 → render.
// 플레이그라운드와 정적 프리셋 리밸런싱 셀렉터가 공유. opts={selfName,title,desc,leverage}.
function _allocRun(panel, w, rebalance, band, ccy, opts) {
  opts = opts || {};
  const ids = panel.assets.map(a => a.id);
  const baseOpts = { rebalance, bandRatio: band, costs: panel.costs };
  const res = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, w, baseOpts);
  if (!res) { setStatus('선택한 자산의 공통 데이터가 부족합니다(비중>0 자산을 확인하세요).', true); return false; }
  setStatus('');
  const lev = opts.leverage || 1;
  const fxWin = res.win.map(t => panel.fx[t]);
  const self = opts.selfName || '내 배분';
  const navKrw = _leverNav(res.navKrw, res.win, panel.rf_monthly, lev);
  const curves = [{ name: self, dates: res.dates, nav: ALLOC.navToCcy(navKrw, fxWin, ccy) }];
  if (opts.maSignal) {                                 // 200일선 필터 ON → 두 변형 모두 표시
    const resMa = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, w,
      Object.assign({ maSignal: opts.maSignal }, baseOpts));
    if (resMa) curves.push({ name: self + MA_SUFFIX, dates: resMa.dates,
                             nav: ALLOC.navToCcy(_leverNav(resMa.navKrw, resMa.win, panel.rf_monthly, lev), resMa.win.map(t => panel.fx[t]), ccy) });
  }
  for (const [name, b] of Object.entries(panel.benchmarks || {})) {
    curves.push({ name, dates: res.dates, nav: ALLOC.benchCurve(b.price, b.ccy, panel.fx, ccy, res.win) });
  }
  state.data = _synthDataset(curves, opts.title || '사용자 배분');
  state.data.target_weights = res.weights;            // 정규화 비중 → 구성 표
  state.data.rebalance = rebalance; state.data.band_ratio = band;   // 설명에 주기 표기
  state.data.ma_on = !!opts.maSignal;                 // 설명 배지
  if (opts.desc != null) state.data.description = opts.desc;
  state.colToMetric = buildColToMetric(state.data);
  buildStrategyList(state.data);
  render();
  return true;
}

function runPlayground() {
  const panel = state.panel; if (!panel) return;
  const w = {}; let sum = 0;
  _pgWeightInputs().forEach(i => { const v = (parseFloat(i.value) || 0) / 100; w[i.dataset.asset] = v; sum += v; });
  document.getElementById('pg-sum').textContent = `합계 ${(sum * 100).toFixed(1)}%`;
  document.getElementById('pg-sum').className = 'pg-sum' + (Math.abs(sum - 1) <= 0.001 ? ' ok' : ' warn');
  const rebalance = document.getElementById('pg-rebalance').value;
  const band = (parseFloat(document.getElementById('pg-band').value) || 0) / 100;
  const maEl = document.getElementById('pg-ma');
  const maOn = !!(maEl && maEl.checked && panel.ma_signal);
  const levEl = document.getElementById('pg-leverage');
  const lev = levEl ? (parseFloat(levEl.value) || 1) : 1;
  const ro = document.getElementById('pg-lev-readout'); if (ro) ro.textContent = lev.toFixed(1) + '×';
  const selfName = lev > 1.0001 ? `내 배분 (${lev.toFixed(1)}×)` : '내 배분';
  _allocRun(panel, w, rebalance, band, state.nav.currency || 'krw',
    { selfName, title: '사용자 배분', maSignal: maOn ? panel.ma_signal : null, leverage: lev });
}

// 정적 프리셋 리밸런싱 셀렉터 ─────────────────────────────────────────────
function _showAllocRebal(show) {
  const el = document.querySelector('.ctl-rebal');
  if (el) el.classList.toggle('hidden', !show);
  setHidden('sweep-section', !show);                  // 리밸 민감도 스윕도 정적 프리셋에서만
  if (!show) {                                        // 데이터셋 변경 시 이전 스윕 결과 초기화
    state.sweep = null;
    const t = document.getElementById('sweep-table'); if (t) t.innerHTML = '';
    const c = document.getElementById('chart-sweep'); if (c) c.innerHTML = '';
  }
}

// 리밸런싱 민감도 스윕 — 주기×밴드 격자를 alloc.js 로 재백테스트(전체 기간) ───────────
const SWEEP_METRIC = { CAGR: { key: 'CAGR', pct: true }, MDD: { key: 'mdd', pct: true }, Sharpe: { key: 'sharpe', pct: false } };
const SWEEP_REBALS = ['never', 'monthly', 'quarterly', 'semiannual', 'yearly'];
const SWEEP_BANDS = [0, 0.10, 0.20, 0.30];
async function runRebalSweep() {
  const ctx = state.allocCtx; if (!ctx) return;
  setStatus('스윕 계산 중…');
  const panel = await _ensurePanel();
  if (!panel) { setStatus('panel.json 로드 실패 — 스윕 불가', true); return; }
  const maEl = document.getElementById('alloc-ma');
  const maSignal = (maEl && maEl.checked && panel.ma_signal) ? panel.ma_signal : null;
  const ids = panel.assets.map(a => a.id), ccy = state.nav.currency || 'krw', ppy = panel.periods_per_year || 12;
  const grid = SWEEP_BANDS.map(band => SWEEP_REBALS.map(rebalance => {
    const res = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, ctx.weights,
      { rebalance, bandRatio: band, costs: panel.costs, maSignal });
    if (!res) return null;
    const nav = ALLOC.navToCcy(res.navKrw, res.win.map(t => panel.fx[t]), ccy);
    return computeMetrics(res.dates, nav, ppy);
  }));
  state.sweep = { grid, ma: !!maSignal };
  const note = document.getElementById('sweep-ma-note');
  if (note) note.textContent = maSignal ? '(200일선 필터 적용)' : '';
  setStatus('');
  renderSweep();
}
// MA 토글로 기존 스윕이 무의미해지면 결과 비움(재실행 유도).
function _staleSweepCheck(maOn) {
  if (state.sweep && state.sweep.ma !== maOn) {
    state.sweep = null;
    const t = document.getElementById('sweep-table'); if (t) t.innerHTML = '';
    const c = document.getElementById('chart-sweep'); if (c) c.innerHTML = '';
    const n = document.getElementById('sweep-ma-note'); if (n) n.textContent = '';
  }
}
function renderSweep() {
  if (!state.sweep) return;
  const m = SWEEP_METRIC[state.sweepMetric] || SWEEP_METRIC.CAGR;
  const grid = state.sweep.grid;
  const x = SWEEP_REBALS.map(r => REBAL_KOR[r] || r);
  const y = SWEEP_BANDS.map(b => b === 0 ? '밴드 OFF' : `±${(b * 100).toFixed(0)}%`);
  const val = c => (c && isFinite(c[m.key])) ? c[m.key] : null;
  const text = grid.map(row => row.map(c => { const v = val(c); return v == null ? '' : (m.pct ? (v * 100).toFixed(1) + '%' : v.toFixed(2)); }));
  const muted = cssVar('--chart-muted');
  const trace = { type: 'heatmap', z: grid.map(r => r.map(c => { const v = val(c); return v == null ? null : (m.pct ? v * 100 : v); })),
    x, y, text, texttemplate: '%{text}', textfont: { size: 11, color: '#0f172a' },
    colorscale: [[0, '#dc2626'], [0.5, '#fde68a'], [1, '#16a34a']], xgap: 2, ygap: 2,
    colorbar: { tickfont: { color: muted }, outlinewidth: 0, len: 0.92, thickness: 12 },
    hovertemplate: `%{y} · %{x}<br>${state.sweepMetric} %{text}<extra></extra>` };
  const layout = baseLayout('', '');
  layout.margin = { l: 74, r: 10, t: 8, b: 36 };
  layout.xaxis = { tickfont: { color: muted, size: 11 }, automargin: true };
  layout.yaxis = { tickfont: { color: muted, size: 11 }, automargin: true };
  delete layout.legend; layout.hovermode = 'closest';
  Plotly.react('chart-sweep', [trace], layout, PLOTCFG);
  document.querySelectorAll('#sweep-metric button').forEach(b => b.classList.toggle('active', b.dataset.metric === (state.sweepMetric || 'CAGR')));
  const head = '<thead><tr><th class="name">밴드 \\ 주기</th>' + x.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';
  const body = SWEEP_BANDS.map((b, bi) => `<tr><td class="name" data-label="밴드">${y[bi]}</td>` +
    SWEEP_REBALS.map((r, ri) => { const v = val(grid[bi][ri]); return `<td data-label="${x[ri]}">${v == null ? '—' : (m.pct ? fmtPct(v) : fmtRatio(v))}</td>`; }).join('') + '</tr>').join('');
  document.getElementById('sweep-table').innerHTML = head + '<tbody>' + body + '</tbody>';
}
// ── 이평선 필터 민감도 (과최적화 점검) — panel.ma_signals 다중 창 + ALLOC 라이브 스윕. 정적·추천 탭 공용.
// 특정 일수(200) 튜닝이 아니라 넓은 창(50~300)에서 낙폭이 줄어드는지 보여 강건성/과최적화를 점검한다.
function _maSweepCompute(panel, weights, ccy) {
  const ids = panel.assets.map(a => a.id);
  const base = { rebalance: 'quarterly', bandRatio: 0.2, costs: panel.costs };
  const metricsOf = maSignal => {
    const res = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, weights, Object.assign({ maSignal }, base));
    if (!res) return null;
    const nav = ALLOC.navToCcy(res.navKrw, res.win.map(t => panel.fx[t]), ccy), cn = [], cd = [];
    nav.forEach((v, i) => { if (v != null) { cn.push(v); cd.push(res.dates[i]); } });
    if (cn.length < 3) return null;
    const b0 = cn[0];
    return computeMetrics(cd, cn.map(v => v / b0), 12);
  };
  const baseline = metricsOf(null), sigs = panel.ma_signals || {};
  const rows = (panel.ma_windows || [50, 100, 150, 200, 250, 300]).map(w => {
    const m = sigs[String(w)] ? metricsOf(sigs[String(w)]) : null;
    return m ? { w, cagr: m.CAGR, mdd: m.mdd, sharpe: m.sharpe, calmar: m.calmar } : null;
  }).filter(Boolean);
  return { baseline, rows };
}
function _drawMaSweep(el, sweep, activeW) {
  if (!el || typeof Plotly === 'undefined' || !sweep || !sweep.rows.length) return;
  const xs = sweep.rows.map(r => r.w);
  const acc = cssVar('--accent'), muted = cssVar('--chart-muted'), neg = cssVar('--neg') || '#ef4444';
  const traces = [
    { type: 'bar', name: 'MDD', x: xs, y: sweep.rows.map(r => r.mdd * 100), yaxis: 'y',
      marker: { color: xs.map(w => (w === activeW ? acc : muted)) },
      hovertemplate: '창 %{x}일 · MDD %{y:.1f}%<extra></extra>' },
    { type: 'scatter', mode: 'lines+markers', name: 'Sharpe', x: xs, y: sweep.rows.map(r => r.sharpe),
      yaxis: 'y2', line: { color: acc, width: 2 }, marker: { size: 6 },
      hovertemplate: '창 %{x}일 · Sharpe %{y:.2f}<extra></extra>' },
  ];
  const layout = baseLayout('이평선 창별 낙폭(MDD)·Sharpe — 넓은 범위서 개선되면 강건', 'MDD (%)');
  layout.xaxis.type = 'linear';
  layout.xaxis.title = { text: '이동평균 창 (거래일)', font: { color: muted } };
  layout.yaxis2 = { overlaying: 'y', side: 'right', title: { text: 'Sharpe', font: { color: acc } },
    tickfont: { color: muted }, showgrid: false, zeroline: false };
  if (sweep.baseline && sweep.baseline.mdd != null) {
    const bm = sweep.baseline.mdd * 100;
    layout.shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: bm, y1: bm,
      line: { color: neg, dash: 'dot', width: 1.5 } }];
    layout.annotations = [{ xref: 'paper', x: 0.02, yref: 'y', y: bm, yanchor: 'bottom',
      text: `무필터 MDD ${bm.toFixed(0)}%`, showarrow: false, font: { color: neg, size: 11 } }];
  }
  Plotly.react(el, traces, layout, PLOTCFG);
}
function _maReadout(hostId, sweep, w) {
  const el = document.getElementById(hostId + '-readout'); if (!el) return;
  const r = sweep.rows.find(x => x.w === w), b = sweep.baseline;
  const p = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
  const rr = x => (x == null || !isFinite(x)) ? '—' : Number(x).toFixed(2);
  if (!r) { el.textContent = ''; return; }
  el.innerHTML = `선택 <strong>${w}일선</strong> — CAGR ${p(r.cagr)} · MDD ${p(r.mdd)} · Sharpe ${rr(r.sharpe)} · Calmar ${rr(r.calmar)}` +
    (b ? ` <span class="muted">vs 무필터 CAGR ${p(b.CAGR)} · MDD ${p(b.mdd)} · Sharpe ${rr(b.sharpe)}</span>` : '');
}
// 분석 코멘트(과최적화 판정) — 무필터 대비 개선 창 비율 + 최적 창(Sharpe/Calmar)·최소낙폭 창 요약.
function _maVerdict(sweep, unit) {
  if (!sweep || !sweep.rows.length) return '';
  unit = unit || '일';
  const rows = sweep.rows, b = sweep.baseline, n = rows.length;
  const p = x => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(1) + '%';
  const bMdd = b ? b.mdd : null;
  let improved = 0;
  if (bMdd != null) rows.forEach(r => { if (r.mdd - bMdd > 0.03) improved++; });   // 낙폭 ≥3%p 얕아진 창
  const bySharpe = [...rows].sort((a, c) => c.sharpe - a.sharpe)[0];
  const byCalmar = [...rows].sort((a, c) => (c.calmar || -9) - (a.calmar || -9))[0];
  const shallow = [...rows].sort((a, c) => c.mdd - a.mdd)[0];
  let head, cls;
  if (bMdd == null) { head = '기준(무필터) 없음 — 창 간 상대 비교만'; cls = ''; }
  else if (improved >= Math.ceil(n * 0.8)) { head = '✅ 강건 — 특정 일수 과최적화가 아님'; cls = 'ok'; }
  else if (improved >= Math.ceil(n * 0.5)) { head = '◐ 대체로 강건 — 일부 창에서만 개선'; cls = ''; }
  else if (improved >= 1) { head = '⚠ 과최적화 의심 — 소수 창에서만 개선'; cls = 'warn'; }
  else { head = '✗ 이평선 필터 효과 미미'; cls = 'warn'; }
  const parts = [];
  if (bMdd != null) parts.push(`${rows[0].w}~${rows[n - 1].w}${unit} 중 <strong>${improved}/${n}개</strong> 창에서 낙폭이 무필터(${p(bMdd)}) 대비 뚜렷이 얕아짐`);
  parts.push(`Sharpe 최고 <strong>${bySharpe.w}${unit}</strong>(${bySharpe.sharpe.toFixed(2)})`);
  if (byCalmar && byCalmar.calmar != null) parts.push(`Calmar 최고 ${byCalmar.w}${unit}(${byCalmar.calmar.toFixed(2)})`);
  parts.push(`낙폭 최소 ${shallow.w}${unit}(${p(shallow.mdd)})`);
  return `<div class="ma-verdict ${cls}"><strong>${head}.</strong> ${parts.join(' · ')}.</div>`;
}
// 공용 렌더: 창 선택기 → 선택값 읽기 → 분석 판정 → 차트. 텍스트를 차트 위에 둬 가려지지 않게 한다.
function _renderMaSweepBlock(hostId, sweep, opts) {
  opts = opts || {};
  const host = document.getElementById(hostId); if (!host) return;
  if (!sweep || !sweep.rows.length) { host.innerHTML = '<p class="period-note">민감도 데이터를 계산할 수 없습니다(패널·시리즈 확인).</p>'; return; }
  const wins = sweep.rows.map(r => r.w), unit = opts.unit || '일';
  const activeW = wins.includes(200) ? 200 : wins[Math.floor(wins.length / 2)];
  if (host._maReady !== true) {
    host.innerHTML =
      '<div class="bt-toggle ma-sel">' + wins.map(w => `<button type="button" data-maw="${w}">${w}${unit}</button>`).join('') + '</div>' +
      `<p class="period-note ma-readout" id="${hostId}-readout"></p>` +
      `<div id="${hostId}-verdict"></div>` +
      `<div class="chart" id="${hostId}-chart" style="height:300px;margin-top:0.4rem"></div>`;
    host.addEventListener('click', e => {
      const btn = e.target.closest('button[data-maw]'); if (!btn || !host._sweep) return;
      host._active = +btn.dataset.maw;
      host.querySelectorAll('button[data-maw]').forEach(x => x.classList.toggle('active', +x.dataset.maw === host._active));
      _drawMaSweep(document.getElementById(hostId + '-chart'), host._sweep, host._active);
      _maReadout(hostId, host._sweep, host._active);
    });
    host._maReady = true;
  }
  host._sweep = sweep; host._active = activeW; host._unit = unit;
  host.querySelectorAll('button[data-maw]').forEach(x => x.classList.toggle('active', +x.dataset.maw === activeW));
  const vEl = document.getElementById(hostId + '-verdict'); if (vEl) vEl.innerHTML = _maVerdict(sweep, unit);
  _drawMaSweep(document.getElementById(hostId + '-chart'), sweep, activeW);
  _maReadout(hostId, sweep, activeW);
}
// 정적 자산배분: panel + ALLOC 로 창별 라이브 스윕. state.panelCache 필요(_ensurePanel 선행).
function renderMaSensitivity(hostId, weights, ccy) {
  const panel = state.panelCache;
  if (!document.getElementById(hostId) || !panel || typeof ALLOC === 'undefined' || !weights) return;
  _renderMaSweepBlock(hostId, _maSweepCompute(panel, weights, ccy || 'krw'), { unit: '일' });
}
// 코인: 로드된 대시보드의 'N일선 · <통화>신호' 시리즈 지표에서 스윕 구성(엔진 재계산 불필요). 기준=매수후보유.
function _hasCryptoMa(d) {
  return !!(d && d.metrics_raw && Object.keys(d.metrics_raw).some(k => /^\d+일선 · (달러|원화)신호$/.test(k)));
}
function _cryptoMaSweep(d, ccy) {
  const mr = d.metrics_raw || {}, sig = (ccy === 'usd') ? '달러신호' : '원화신호';
  const rows = [20, 60, 120, 200].map(w => {
    const m = mr[`${w}일선 · ${sig}`];
    return m ? { w, cagr: m.CAGR, mdd: m.mdd, sharpe: m.sharpe, calmar: m.calmar } : null;
  }).filter(Boolean);
  const bh = mr['매수후보유'];
  return { baseline: bh ? { CAGR: bh.CAGR, mdd: bh.mdd, sharpe: bh.sharpe } : null, rows };
}
function _maybeCryptoMaSensitivity(d) {
  if (!_hasCryptoMa(d)) { setHidden('crypto-ma-section', true); return; }
  setHidden('crypto-ma-section', false);
  _renderMaSweepBlock('crypto-ma-host', _cryptoMaSweep(d, state.nav.currency || 'krw'), { unit: '일' });
}

async function _ensurePanel() {
  if (state.panelCache) return state.panelCache;
  try {
    const r = await fetch('data/panel.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.panelCache = await r.json();
    return state.panelCache;
  } catch (e) { return null; }
}
const _REBAL_KR = { never: '리밸 없음', monthly: '월', quarterly: '분기', semiannual: '반기', yearly: '연' };
function _allocName(base, rebalance, band) {     // allocation.py 와 동일 포맷: "프리셋 · 주기(· 밴드%)"
  return `${base} · ${_REBAL_KR[rebalance] || rebalance}` + (band > 0 ? ` · 밴드 ${Math.round(band * 100)}%` : '');
}
async function onAllocRebalChange() {
  const ctx = state.allocCtx; if (!ctx) return;
  const rebalance = document.getElementById('alloc-rebal').value;
  const bandOn = document.getElementById('alloc-band-on').checked;
  document.getElementById('alloc-band').disabled = !bandOn;   // 끄면 % 입력 비활성
  const band = bandOn ? (parseFloat(document.getElementById('alloc-band').value) || 0) / 100 : 0;
  const maEl = document.getElementById('alloc-ma');
  const maOn = !!(maEl && maEl.checked);
  if (rebalance === ctx.defaultRebal && Math.abs(band - ctx.defaultBand) < 1e-9 && !maOn) {
    return loadDataset(ctx.file);   // 기본값 + 필터 OFF → 사전계산 풀 뷰 복원(MA200 곡선·ma_ab 포함)
  }
  setStatus('재계산 중…');
  const panel = await _ensurePanel();
  if (!panel) { setStatus('panel.json 로드 실패 — 기본(분기) 결과만 가능', true); return; }
  if (maOn && !panel.ma_signal) {   // 구버전 panel.json 가드
    if (maEl) maEl.checked = false;
    setStatus('panel.json에 200일선 신호가 없어 필터를 사용할 수 없습니다(데이터 재배포 필요).', true);
    return;
  }
  const name = _allocName(ctx.base, rebalance, band);   // 선택 주기를 이름에 반영
  const title = name + (maOn ? MA_SUFFIX : '');
  _allocRun(panel, ctx.weights, rebalance, band, state.nav.currency || 'krw',
    { selfName: name, title, desc: ctx.desc, maSignal: maOn ? panel.ma_signal : null });
  _staleSweepCheck(maOn);
  _showAllocRebal(true);            // render 후에도 컨트롤 유지
}

// ---------------------------------------------------------------------------
// 전략 블렌딩 + 적립식 (클라이언트) — 여러 전략 NAV를 합성, 적립식 XIRR.
// ---------------------------------------------------------------------------
function xirr(flows) {                       // flows: [[iso, amount]] 투자<0 / 회수>0. metrics.xirr 미러.
  if (flows.length < 2) return NaN;
  const t0 = new Date(flows[0][0]);
  const ts = flows.map(f => (new Date(f[0]) - t0) / 86400000 / 365.25), amt = flows.map(f => f[1]);
  if (!amt.some(a => a > 0) || !amt.some(a => a < 0)) return NaN;
  const npv = r => amt.reduce((s, a, i) => s + a / Math.pow(1 + r, ts[i]), 0);
  let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) {                       // 브래킷 실패 → Newton
    let r = 0.1;
    for (let i = 0; i < 80; i++) {
      const f = npv(r), df = amt.reduce((s, a, k) => s - ts[k] * a / Math.pow(1 + r, ts[k] + 1), 0);
      if (Math.abs(df) < 1e-12) break;
      const nr = r - f / df;
      if (!isFinite(nr) || nr <= -0.9999) break;
      if (Math.abs(nr - r) < 1e-9) return nr;
      r = nr;
    }
    return (isFinite(r) && r > -0.9999) ? r : NaN;
  }
  for (let i = 0; i < 120; i++) {            // bisection
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}
function _periodMaskYM(ym, mode) {           // YYYY-MM 배열 → 리밸 발생 여부(첫 달 true)
  return ym.map((k, i) => {
    if (i === 0) return true;
    const m = +k.slice(5, 7);
    if (mode === 'monthly') return true;
    if (mode === 'quarterly') return [1, 4, 7, 10].includes(m);
    if (mode === 'semiannual') return [1, 7].includes(m);
    if (mode === 'yearly') return k.slice(0, 4) !== ym[i - 1].slice(0, 4);
    return false;
  });
}
function _alignSeries(comps) {               // 월말 정렬 · 공통 YYYY-MM 교집합 · 1.0 리베이스
  const maps = comps.map(c => { const me = new Map(); for (let i = 0; i < c.dates.length; i++) me.set(c.dates[i].slice(0, 7), c.nav[i]); return me; });
  let common = null;
  for (const m of maps) { const ks = new Set(m.keys()); common = common ? new Set([...common].filter(k => ks.has(k))) : ks; }
  const months = [...(common || [])].sort();
  if (months.length < 2) return null;
  const navByName = comps.map((c, ci) => { const base = maps[ci].get(months[0]); return months.map(mk => maps[ci].get(mk) / base); });
  return { months, navByName };
}
function blendNav(aligned, weights, rebalance) {
  const { months, navByName } = aligned, n = months.length;
  const wsum = weights.reduce((s, w) => s + w, 0) || 1, w = weights.map(x => x / wsum);
  const nav = new Array(n), dates = months.map(m => m + '-01');
  if (rebalance === 'none') {                // 일시불 가중합(드리프트)
    for (let t = 0; t < n; t++) nav[t] = w.reduce((s, wi, k) => s + wi * navByName[k][t], 0);
    return { dates, nav };
  }
  const mask = _periodMaskYM(months, rebalance);
  let shares = w.slice(); nav[0] = 1;
  for (let t = 1; t < n; t++) {
    const grown = shares.map((sh, k) => sh * (navByName[k][t] / navByName[k][t - 1]));
    const tot = grown.reduce((s, x) => s + x, 0);
    nav[t] = nav[t - 1] * tot;
    shares = mask[t] ? w.slice() : grown.map(x => x / tot);   // 리밸 월 목표 복귀, 아니면 표류
  }
  return { dates, nav };
}
function dcaResult(dates, nav, amount) {     // 매월 amount 매수 → 평가액·XIRR
  let units = 0; const invested = [], value = [], flows = [];
  for (let t = 0; t < nav.length; t++) {
    units += amount / nav[t];
    invested.push(amount * (t + 1)); value.push(units * nav[t]); flows.push([dates[t], -amount]);
  }
  flows.push([dates[nav.length - 1], units * nav[nav.length - 1]]);
  return { dates, invested, value, final: value[value.length - 1], totalInvested: invested[invested.length - 1], xirr: xirr(flows) };
}
function _blendOptions() {                    // 현재 통화의 단일곡선 전략 데이터셋
  return state.manifest.filter(m => m.file && !m.mode && m.currency === state.blendCcy);
}
function _blendRowHtml(opts, selFile, weight) {
  const o = opts.map(x => `<option value="${x.file}"${x.file === selFile ? ' selected' : ''}>${x.label}</option>`).join('');
  return `<div class="blend-row"><select class="blend-sel">${o}</select>` +
    `<input type="number" class="blend-w" min="0" max="100" step="5" value="${weight}" />%` +
    `<button type="button" class="rm" title="제거">×</button></div>`;
}
function _wireBlendRows() {
  document.querySelectorAll('#blend-pick .blend-row').forEach(row => {
    if (row._wired) return; row._wired = true;
    row.querySelector('.rm').addEventListener('click', () => { row.remove(); _updateBlendSum(); });
    row.querySelector('.blend-w').addEventListener('input', _updateBlendSum);
  });
}
function _updateBlendSum() {
  let sum = 0; document.querySelectorAll('#blend-pick .blend-w').forEach(i => sum += parseFloat(i.value) || 0);
  const el = document.getElementById('blend-sum');
  el.textContent = `합계 ${sum.toFixed(0)}%`;
  el.className = 'pg-sum' + (Math.abs(sum - 100) <= 0.1 ? ' ok' : ' warn');
}
function _populateBlendRows() {
  const opts = _blendOptions(), pick = document.getElementById('blend-pick');
  if (!opts.length) { pick.innerHTML = '<p class="period-note">이 통화의 전략 데이터셋이 없습니다.</p>'; return; }
  pick.innerHTML = _blendRowHtml(opts, opts[0].file, 50) + _blendRowHtml(opts, (opts[1] || opts[0]).file, 50);
  _wireBlendRows(); _updateBlendSum();
}
function _addBlendRow() {
  const opts = _blendOptions(); if (!opts.length) return;
  document.getElementById('blend-pick').insertAdjacentHTML('beforeend', _blendRowHtml(opts, opts[0].file, 0));
  _wireBlendRows(); _updateBlendSum();
}
// 추천 전략: 기존 전략들을 큐레이션한 블렌드 프리셋. base tag(통화접미사 제외) → ${base}_${ccy}.json 로 해석.
const RECO_LABEL = {
  multi_dynamic_baa_b: 'BAA 균형', multi_dynamic_daa_g12: 'DAA-G12',
  multi_dynamic_nrp: '리스크패리티', multi_dynamic_baa_g: 'BAA 공격', multi_dynamic_adm: 'ADM(가속듀얼)',
};
const RECO_BLENDS = [
  { key: 'safe', title: '🛡 안전형', rebal: 'quarterly', desc: '낮은 MDD 우선',
    statKrw: 'CAGR≈9.9% · MDD≈−13.4% · Sharpe 0.93',
    legs: [{ base: 'multi_dynamic_baa_b', w: 40 }, { base: 'multi_dynamic_daa_g12', w: 30 }, { base: 'multi_dynamic_nrp', w: 30 }] },
  { key: 'balanced', title: '⚖ 균형형 (~15%)', rebal: 'quarterly', desc: '적당한 수익·적당한 MDD',
    statKrw: 'CAGR≈15.2% · MDD≈−17.8% · Sharpe 1.10',
    legs: [{ base: 'multi_dynamic_baa_g', w: 60 }, { base: 'multi_dynamic_adm', w: 40 }] },
];
function renderRecoPresets() {                   // 추천 카드 렌더(통화 무관 정적 텍스트)
  const el = document.getElementById('blend-reco-presets'); if (!el) return;
  const card = r => `<div class="reco-card"><div class="reco-head">` +
    `<span class="reco-title">${r.title}</span>` +
    `<button type="button" class="reco-apply" data-reco-preset="${r.key}">적용</button></div>` +
    `<div class="reco-w">${r.legs.map(l => `${RECO_LABEL[l.base] || l.base} ${l.w}%`).join(' · ')}</div>` +
    `<div class="reco-stat">${r.desc} · ${r.statKrw}</div></div>`;
  el.innerHTML = RECO_BLENDS.map(card).join('');
}
function applyRecoPreset(key) {                   // 추천 조합을 블렌드 입력에 채우고 실행
  const r = RECO_BLENDS.find(x => x.key === key); if (!r) return;
  const opts = _blendOptions(), optFiles = new Set(opts.map(o => o.file));
  const legs = r.legs.map(l => ({ file: `${l.base}_${state.blendCcy}.json`, w: l.w })).filter(l => optFiles.has(l.file));
  if (!legs.length) { setStatus('추천 전략 데이터셋을 현재 통화에서 찾을 수 없습니다.', true); return; }
  document.getElementById('blend-pick').innerHTML = legs.map(l => _blendRowHtml(opts, l.file, l.w)).join('');
  document.getElementById('blend-rebal').value = r.rebal;
  _wireBlendRows(); _updateBlendSum(); runBlend();
}
function enterBlend() {
  setAnalyticsMode(false); setToolsMode(false);
  state.playground = false; state.allocCtx = null; _showAllocRebal(false);
  document.getElementById('meta').textContent = '전략 블렌딩 · 적립식 (클라이언트 합성)';
  setStatus('');
  if (!state._blendWired) {
    document.getElementById('blend-add').addEventListener('click', _addBlendRow);
    document.getElementById('blend-run').addEventListener('click', runBlend);
    document.getElementById('blend-rebal').addEventListener('change', runBlend);
    document.querySelectorAll('#blend-ccy button').forEach(b => b.addEventListener('click', () => {
      state.blendCcy = b.dataset.ccy;
      document.querySelectorAll('#blend-ccy button').forEach(x => x.classList.toggle('active', x === b));
      _populateBlendRows();
    }));
    document.querySelectorAll('#blend-mode-toggle button').forEach(b => b.addEventListener('click', () => {
      state.blendMode = b.dataset.bm;
      document.querySelectorAll('#blend-mode-toggle button').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('blend-amount-wrap').classList.toggle('hidden', state.blendMode !== 'dca');
      runBlend();
    }));
    _attachComma('blend-amount', runBlend);
    document.getElementById('blend-reco').addEventListener('click', e => {   // 추천 비중 적용(위임)
      const b = e.target.closest('button[data-reco]'); if (b) applyBlendWeights(b.dataset.reco);
    });
    document.getElementById('blend-reco-presets').addEventListener('click', e => {   // 추천 전략 적용(위임)
      const b = e.target.closest('button[data-reco-preset]'); if (b) applyRecoPreset(b.dataset.recoPreset);
    });
    state._blendWired = true;
  }
  renderRecoPresets();
  _populateBlendRows();
  runBlend();
}
// 블렌드 벤치마크 오버레이: 통화별 S&P 500·KOSPI(allocation_balanced 데이터셋의 벤치 시리즈)를
// 블렌드 월 그리드(YYYY-MM)에 재색인 + 시작=1 리베이스해 깨끗한 배열로 반환(결측 월은 제외 → computeMetrics 안전).
function _blendBenchmarkCurve(label, bench, blendDates) {
  const m = {};
  (bench.dates || []).forEach((dt, i) => { m[dt.slice(0, 7)] = bench.nav[i]; });
  const dates = [], raw = [];
  blendDates.forEach(dt => { const v = m[dt.slice(0, 7)]; if (v != null) { dates.push(dt); raw.push(v); } });
  if (raw.length < 2) return null;
  const base = raw[0];
  return { name: label, dates, nav: raw.map(v => v / base) };
}
async function _blendBenchmarks(ccy, blendDates) {
  state.benchCache = state.benchCache || {};
  const file = `multi_allocation_balanced_${ccy}.json`;   // 이 데이터셋은 통화별로 'S&P 500'·'KOSPI' 벤치 시리즈 보유
  if (!(file in state.benchCache)) {
    try { state.benchCache[file] = ((await (await fetch('data/' + file, { cache: 'no-cache' })).json()).series) || []; }
    catch (e) { state.benchCache[file] = []; }
  }
  const series = state.benchCache[file], out = [];
  [['S&P 500', 'S&P 500 (벤치마크)'], ['KOSPI', 'KOSPI (벤치마크)']].forEach(([src, label]) => {
    const s = series.find(x => x.name === src);
    if (s && s.dates && s.nav) { const c = _blendBenchmarkCurve(label, s, blendDates); if (c) out.push(c); }
  });
  return out;
}
async function runBlend() {
  const rows = [...document.querySelectorAll('#blend-pick .blend-row')].map(r => ({
    file: r.querySelector('.blend-sel').value, w: (parseFloat(r.querySelector('.blend-w').value) || 0) / 100,
  })).filter(r => r.file && r.w > 0);
  if (!rows.length) { setStatus('블렌드할 전략을 1개 이상 선택하세요.', true); return; }
  setStatus('블렌드 계산 중…');
  state.blendCache = state.blendCache || {};
  const comps = [];
  for (const r of rows) {
    if (!(r.file in state.blendCache)) {
      try { const d = await (await fetch('data/' + r.file, { cache: 'no-cache' })).json();
        const s = (d.series || [])[0]; state.blendCache[r.file] = s ? { name: d.title || s.name, dates: s.dates, nav: s.nav } : null;
      } catch (e) { state.blendCache[r.file] = null; }
    }
    const c = state.blendCache[r.file];
    if (c) comps.push({ ...c, w: r.w });
  }
  if (!comps.length) { setStatus('전략 데이터 로드 실패.', true); return; }
  const aligned = _alignSeries(comps);
  if (!aligned) { setStatus('전략들의 공통 구간이 2개월 미만입니다(통화·기간 확인).', true); return; }
  const rebalance = document.getElementById('blend-rebal').value;
  const blended = blendNav(aligned, comps.map(c => c.w), rebalance);
  setStatus('');
  const curves = [{ name: '블렌드', dates: blended.dates, nav: blended.nav }];
  comps.forEach((c, ci) => curves.push({ name: c.name, dates: blended.dates, nav: aligned.navByName[ci] }));
  (await _blendBenchmarks(state.blendCcy, blended.dates)).forEach(c => curves.push(c));   // S&P500·KOSPI 벤치마크 오버레이(그래프+표)
  state.data = _synthDataset(curves, '전략 블렌딩');
  const wsum = comps.reduce((s, c) => s + c.w, 0) || 1;
  state.data.target_weights = Object.fromEntries(comps.map(c => [c.name, c.w / wsum]));
  state.colToMetric = buildColToMetric(state.data);
  buildStrategyList(state.data);
  state.globalStart = blended.dates[0]; state.globalEnd = blended.dates[blended.dates.length - 1];
  const sEl = document.getElementById('start'), eEl = document.getElementById('end');
  sEl.min = eEl.min = state.globalStart; sEl.max = eEl.max = state.globalEnd;
  sEl.value = state.globalStart; eEl.value = state.globalEnd; setActivePreset(0);
  render();
  if (state.blendMode === 'dca') {
    const amt = _pgv('blend-amount', 1000000), dca = dcaResult(blended.dates, blended.nav, amt);
    setHidden('blend-dca', false);
    const card = (l, v, s) => `<div class="ext-card"><div class="lab">${l}</div><div class="val">${v}</div><div class="sub">${s || ''}</div></div>`;
    document.getElementById('blend-dca-cards').innerHTML =
      card('최종 평가액', _krwCompact(dca.final), `${dca.dates.length}개월 적립`) +
      card('총 납입액', _krwCompact(dca.totalInvested), '') +
      card('평가손익', _krwCompact(dca.final - dca.totalInvested), '') +
      card('XIRR (금액가중)', fmtPct(dca.xirr), '연율');
    const muted = cssVar('--chart-muted');
    Plotly.react('blend-invested', [
      { type: 'scatter', mode: 'lines', name: '평가액', x: dca.dates, y: dca.value, line: { width: 2, color: cssVar('--accent') }, hovertemplate: '%{y:,.0f}원<extra>평가액</extra>' },
      { type: 'scatter', mode: 'lines', name: '납입 누계', x: dca.dates, y: dca.invested, line: { width: 1.4, color: muted, dash: 'dot' }, hovertemplate: '%{y:,.0f}원<extra>납입</extra>' },
    ], baseLayout('적립식 — 납입 누계 vs 평가액', '금액 (원)'), PLOTCFG);
  } else setHidden('blend-dca', true);
  renderBlendFrontier(comps, aligned);
}

// ── 블렌딩 효율적 프론티어 · 상관 (정량분석 엔진 ANALYTICS 재사용) ──────────────
function renderBlendFrontier(comps, aligned) {
  const sec = document.getElementById('blend-frontier-section');
  const ok = typeof ANALYTICS !== 'undefined' && comps && comps.length >= 2
    && aligned && aligned.months.length >= 6;
  if (!ok) { state.blendFrontier = null; if (sec) sec.classList.add('hidden'); return; }
  // 선택 전략들의 월수익률 → 정량분석 payload 포맷
  const dates = aligned.months.slice(1);
  const returns = {};
  comps.forEach((c, i) => {
    const nav = aligned.navByName[i], r = [];
    for (let t = 1; t < nav.length; t++) r.push(nav[t] / nav[t - 1] - 1);
    returns[c.name] = r;
  });
  const assets = comps.map((c, i) => ({ key: c.name, label: c.name,
    color: (state.colorOf && state.colorOf[c.name]) || PALETTE[i % PALETTE.length] }));
  const payload = { dates, assets, returns, periods_per_year: 12, rf: 0.02, preset_defs: {} };
  const d = ANALYTICS.buildAnalytics(payload, null, null);          // 상관·프론티어(GMV·MaxSharpe)
  const exp = ANALYTICS.makeExplorer(payload, null, null);          // 추천 비중 + 임의 비중 평가
  const wsum = comps.reduce((s, c) => s + c.w, 0) || 1;
  const mine = exp.evalWeights(Object.fromEntries(comps.map(c => [c.name, c.w / wsum])));
  state.blendFrontier = { d, mine, exp };
  if (sec) sec.classList.remove('hidden');
  const per = document.getElementById('blend-fr-period');
  if (per) per.textContent = `— ${d.period} · ${d.n_months}개월 · 무위험 2%`;
  _drawBlendFrontier();
}
function _drawBlendFrontier() {                  // state.blendFrontier 캐시로 (재)렌더(테마 변경 대응)
  const bf = state.blendFrontier; if (!bf) return;
  renderBlendReco(bf.exp);
  renderCorrelation(bf.d, 'blend-corr');
  renderFrontier(bf.d, { el: 'blend-frontier', mine: bf.mine, mineName: '내 블렌드' });
}
function _blendWeightsStr(exp, rec) {
  return exp.keys.map(k => ({ k, w: rec.weights[k] || 0 })).filter(x => x.w > 0.005)
    .sort((a, b) => b.w - a.w).map(x => `${x.k} ${(x.w * 100).toFixed(0)}%`).join(' · ') || '—';
}
function renderBlendReco(exp) {
  const el = document.getElementById('blend-reco'); if (!el) return;
  const card = (key, title, rec) => `<div class="reco-card"><div class="reco-head">` +
    `<span class="reco-title">${title}</span>` +
    `<button type="button" class="reco-apply" data-reco="${key}">이 비중 적용</button></div>` +
    `<div class="reco-w">${_blendWeightsStr(exp, rec)}</div>` +
    `<div class="reco-stat">CAGR ${(rec.ret * 100).toFixed(1)}% · 변동성 ${(rec.vol * 100).toFixed(1)}% · ` +
    `Sharpe ${(+rec.sharpe).toFixed(2)}</div></div>`;
  el.innerHTML = card('tangency', '★ Max Sharpe (위험대비 최적)', exp.tangency)
    + card('gmv', '◆ 최소분산 (GMV)', exp.gmv);
}
function applyBlendWeights(which) {              // 추천 비중을 블렌드 행 입력에 채우고 재실행
  const bf = state.blendFrontier; if (!bf) return;
  const rec = which === 'gmv' ? bf.exp.gmv : bf.exp.tangency;
  const w = rec.weights || {};
  document.querySelectorAll('#blend-pick .blend-row').forEach(row => {
    const c = state.blendCache[row.querySelector('.blend-sel').value];
    const name = c ? c.name : null;
    row.querySelector('.blend-w').value = (name && w[name]) ? Math.round(w[name] * 100) : 0;
  });
  _updateBlendSum(); runBlend();
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
