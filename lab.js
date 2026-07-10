// 🧪 실험실 — 전략 로테이션(메타 모멘텀) 클라이언트 엔진.
// 각 전략의 월별 NAV 위에서 "최근 L개월 성과 상위 전략으로 매월 교체" 백테스트를 즉석 재계산.
// scripts/lab/build_rotation.py 가 내보낸 strategies[{name,cat,dates['YYYY-MM'],nav}] 를 입력받는다.
// (파이썬 프로토타입과 동일 로직 — 비교 기준은 '전부 균등보유 월리밸'.)
(function (root) {
  'use strict';

  function sampleStd(a) {                     // 표본 표준편차(ddof=1) — pandas .std() 정합
    const n = a.length;
    if (n < 2) return 0;
    const m = a.reduce((s, v) => s + v, 0) / n;
    const ss = a.reduce((s, v) => s + (v - m) * (v - m), 0);
    return Math.sqrt(ss / (n - 1));
  }
  function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

  function cagr(nav) {                         // nav: 시작·끝 포함 월말 배열
    const n = nav.length;
    if (n < 2 || nav[0] <= 0) return NaN;
    const yrs = (n - 1) / 12;
    return Math.pow(nav[n - 1] / nav[0], 1 / yrs) - 1;
  }
  function mdd(nav) {
    let peak = -Infinity, m = 0;
    for (const v of nav) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < m) m = dd; }
    return m;
  }
  function sharpe(rets) {                       // 무위험 0 가정, 월수익 → 연율
    const sd = sampleStd(rets);
    return sd > 0 ? mean(rets) / sd * Math.sqrt(12) : NaN;
  }
  function annVol(rets) { return sampleStd(rets) * Math.sqrt(12); }

  // 선택 유니버스의 공통 월 그리드(모든 전략이 값을 갖는 달) + 전략별 정렬 NAV.
  function commonGrid(strats) {
    if (!strats.length) return { grid: [], navByName: {} };
    let inter = null;
    const mapByName = {};
    for (const s of strats) {
      const m = {};
      s.dates.forEach((d, i) => { m[d] = s.nav[i]; });
      mapByName[s.name] = m;
      const keys = new Set(s.dates);
      inter = inter === null ? keys : new Set([...inter].filter(k => keys.has(k)));
    }
    const grid = [...inter].sort();
    const navByName = {};
    for (const s of strats) navByName[s.name] = grid.map(d => mapByName[s.name][d]);
    return { grid, navByName };
  }

  function monthlyRets(nav) {                   // nav[0..] → rets[0..] (rets[0]=NaN placeholder)
    const r = new Array(nav.length).fill(NaN);
    for (let i = 1; i < nav.length; i++) r[i] = nav[i] / nav[i - 1] - 1;
    return r;
  }

  // 핵심: 로테이션 백테스트. opts={lookback, topk, metric:'ret'|'sharpe', absFilter, cost}
  function rotate(names, navByName, grid, opts) {
    const L = opts.lookback, topk = opts.topk, cost = opts.cost || 0;
    const rets = {}; names.forEach(n => { rets[n] = monthlyRets(navByName[n]); });
    const portRet = [];                          // 실현 월수익(그리드 index L+1 부터)
    const portDate = [];
    let prev = null, nSwitch = 0;
    for (let i = L; i < grid.length - 1; i++) {
      // t=i 시점 신호로 다음 달(i+1) 보유 결정 (look-ahead 없음)
      const score = names.map(n => {
        const abs = navByName[n][i] / navByName[n][i - L] - 1;   // 절대·원수익 모멘텀
        let sc = abs;
        if (opts.metric === 'sharpe') {
          const win = rets[n].slice(i - L + 1, i + 1);
          const sd = sampleStd(win);
          sc = sd > 0 ? mean(win) / sd : -Infinity;
        }
        return { n, sc, abs };
      });
      score.sort((a, b) => b.sc - a.sc);
      let picks = score.slice(0, topk);
      if (opts.absFilter) picks = picks.filter(p => p.abs > 0);   // 절대모멘텀: 상승 중인 것만(없으면 현금)
      const pickNames = picks.map(p => p.n);
      const r = pickNames.length ? mean(pickNames.map(n => rets[n][i + 1])) : 0;   // 다음 달 균등보유
      const cur = pickNames.slice().sort().join('|');
      let rr = r;
      if (prev !== null && cur !== prev) { nSwitch++; rr -= cost; }   // 교체 달 스위치비용
      prev = cur;
      portRet.push(rr);
      portDate.push(grid[i + 1]);
    }
    const nav = [1];
    for (const r of portRet) nav.push(nav[nav.length - 1] * (1 + r));
    // nav 는 portDate 보다 1 길다(시작점) → 시작점 날짜는 첫 실현 직전 달
    const dates = [grid[L]].concat(portDate);
    const yrs = portRet.length / 12;
    return { dates, nav, cagr: cagr(nav), mdd: mdd(nav), sharpe: sharpe(portRet),
             annVol: annVol(portRet), turnover: yrs > 0 ? nSwitch / yrs : 0, nSwitch };
  }

  // 균등보유·사후최고는 로테이션과 '같은 기간(룩백 워밍업 이후 startIdx~끝)·같은 시작점(=1)'으로 계산해야 공정.
  function equalWeight(names, navByName, grid, startIdx) {   // 전부 균등보유(월리밸) 기준선
    const rets = {}; names.forEach(n => { rets[n] = monthlyRets(navByName[n]); });
    const portRet = [], dates = [grid[startIdx]];
    for (let i = startIdx + 1; i < grid.length; i++) {
      portRet.push(mean(names.map(n => rets[n][i])));
      dates.push(grid[i]);
    }
    const nav = [1]; for (const r of portRet) nav.push(nav[nav.length - 1] * (1 + r));
    return { dates, nav, cagr: cagr(nav), mdd: mdd(nav), sharpe: sharpe(portRet) };
  }

  function bestSingle(names, navByName, grid, startIdx) {    // 사후 최고 CAGR 단일 전략(참고·look-ahead)
    let best = null;
    for (const n of names) {
      const slice = navByName[n].slice(startIdx).map(v => v / navByName[n][startIdx]);   // 시작=1 리베이스
      const c = cagr(slice);
      if (best === null || c > best.cagr) best = { name: n, cagr: c, nav: slice, dates: grid.slice(startIdx) };
    }
    return best;
  }

  function run(strategies, opts) {
    const uni = opts.universe;
    const strats = strategies.filter(s => uni === 'both' ? true : s.cat === uni);
    if (strats.length < 2) return null;
    const { grid, navByName } = commonGrid(strats);
    if (grid.length < opts.lookback + 3) return null;
    const names = strats.map(s => s.name);
    const rot = rotate(names, navByName, grid, opts);
    const eq = equalWeight(names, navByName, grid, opts.lookback);        // 로테이션과 동일 기간
    const best = bestSingle(names, navByName, grid, opts.lookback);
    // 판정: 균등보유 Sharpe 대비 (0.05 이내면 동률)
    let verdict = 'tie';
    if (rot.sharpe < eq.sharpe - 0.05) verdict = 'lose';
    else if (rot.sharpe > eq.sharpe + 0.05) verdict = 'win';
    return { period: { start: grid[0], end: grid[grid.length - 1], months: grid.length, n: names.length },
             names, rotation: rot, eq, best, verdict };
  }

  root.ROTATION = { run, cagr, mdd, sharpe, commonGrid };
})(typeof window !== 'undefined' ? window : this);
