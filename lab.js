// 🧪 실험실 — 전략 실험 클라이언트 엔진(ROTATION). scripts/lab/build_rotation.py 의 NAV 매트릭스 위에서
// 3개 실험을 즉석 재계산: ① 전략 로테이션(메타 모멘텀) ② 리밸 주기 민감도 ③ 고정 블렌드 최적화.
// 입력 strategies[{name,cat,krw:{dates,nav},usd:{dates,nav}}] — 통화별 블록. 비교 기준은 '전부 균등보유'.
(function (root) {
  'use strict';

  function sampleStd(a) { const n = a.length; if (n < 2) return 0;
    const m = a.reduce((s, v) => s + v, 0) / n;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1)); }
  function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
  function cagr(nav) { const n = nav.length; if (n < 2 || nav[0] <= 0) return NaN;
    return Math.pow(nav[n - 1] / nav[0], 12 / (n - 1)) - 1; }
  function mdd(nav) { let pk = -Infinity, m = 0;
    for (const v of nav) { if (v > pk) pk = v; const dd = v / pk - 1; if (dd < m) m = dd; } return m; }
  function sharpe(rets) { const sd = sampleStd(rets); return sd > 0 ? mean(rets) / sd * Math.sqrt(12) : NaN; }
  function annVol(rets) { return sampleStd(rets) * Math.sqrt(12); }
  function monthlyRets(nav) { const r = new Array(nav.length).fill(NaN);
    for (let i = 1; i < nav.length; i++) r[i] = nav[i] / nav[i - 1] - 1; return r; }

  // 통화 블록 추출 + 유니버스 필터.
  function pick(s, cur) { const b = s[cur]; return b && b.dates ? { name: s.name, cat: s.cat, dates: b.dates, nav: b.nav } : null; }
  function selectUniverse(strategies, universe, cur) {
    return strategies.map(s => pick(s, cur)).filter(Boolean)
      .filter(s => universe === 'both' ? true : s.cat === universe);
  }
  // 선택 유니버스의 공통 월 그리드 + 전략별 정렬 NAV.
  function commonGrid(strats) {
    if (!strats.length) return { grid: [], navByName: {} };
    let inter = null; const mapByName = {};
    for (const s of strats) { const m = {}; s.dates.forEach((d, i) => { m[d] = s.nav[i]; }); mapByName[s.name] = m;
      const keys = new Set(s.dates); inter = inter === null ? keys : new Set([...inter].filter(k => keys.has(k))); }
    const grid = [...inter].sort();
    const navByName = {}; for (const s of strats) navByName[s.name] = grid.map(d => mapByName[s.name][d]);
    return { grid, navByName };
  }

  // ─── 실험① 전략 로테이션(메타 모멘텀) ──────────────────────────────────────
  function rotate(names, navByName, grid, opts) {
    const L = opts.lookback, topk = opts.topk, cost = opts.cost || 0;
    const rets = {}; names.forEach(n => { rets[n] = monthlyRets(navByName[n]); });
    const portRet = [], portDate = []; let prev = null, nSwitch = 0;
    for (let i = L; i < grid.length - 1; i++) {
      const score = names.map(n => {
        const abs = navByName[n][i] / navByName[n][i - L] - 1; let sc = abs;
        if (opts.metric === 'sharpe') { const win = rets[n].slice(i - L + 1, i + 1); const sd = sampleStd(win);
          sc = sd > 0 ? mean(win) / sd : -Infinity; }
        return { n, sc, abs };
      });
      score.sort((a, b) => b.sc - a.sc);
      let picks = score.slice(0, topk);
      if (opts.absFilter) picks = picks.filter(p => p.abs > 0);
      const pn = picks.map(p => p.n);
      let r = pn.length ? mean(pn.map(n => rets[n][i + 1])) : 0;
      const cur = pn.slice().sort().join('|');
      if (prev !== null && cur !== prev) { nSwitch++; r -= cost; }
      prev = cur; portRet.push(r); portDate.push(grid[i + 1]);
    }
    const nav = [1]; for (const r of portRet) nav.push(nav[nav.length - 1] * (1 + r));
    return { dates: [grid[L]].concat(portDate), nav, cagr: cagr(nav), mdd: mdd(nav), sharpe: sharpe(portRet),
             annVol: annVol(portRet), turnover: portRet.length ? nSwitch / (portRet.length / 12) : 0, nSwitch };
  }
  function equalWeightPeriod(names, navByName, grid, startIdx) {
    const rets = {}; names.forEach(n => { rets[n] = monthlyRets(navByName[n]); });
    const portRet = [], dates = [grid[startIdx]];
    for (let i = startIdx + 1; i < grid.length; i++) { portRet.push(mean(names.map(n => rets[n][i]))); dates.push(grid[i]); }
    const nav = [1]; for (const r of portRet) nav.push(nav[nav.length - 1] * (1 + r));
    return { dates, nav, cagr: cagr(nav), mdd: mdd(nav), sharpe: sharpe(portRet) };
  }
  function bestSingle(names, navByName, grid, startIdx) {
    let best = null;
    for (const n of names) { const slice = navByName[n].slice(startIdx).map(v => v / navByName[n][startIdx]);
      const c = cagr(slice); if (best === null || c > best.cagr) best = { name: n, cagr: c, nav: slice, dates: grid.slice(startIdx) }; }
    return best;
  }
  function run(strategies, opts) {
    const strats = selectUniverse(strategies, opts.universe, opts.currency || 'krw');
    if (strats.length < 2) return null;
    const { grid, navByName } = commonGrid(strats);
    if (grid.length < opts.lookback + 3) return null;
    const names = strats.map(s => s.name);
    const rot = rotate(names, navByName, grid, opts);
    const eq = equalWeightPeriod(names, navByName, grid, opts.lookback);
    const best = bestSingle(names, navByName, grid, opts.lookback);
    let verdict = 'tie';
    if (rot.sharpe < eq.sharpe - 0.05) verdict = 'lose'; else if (rot.sharpe > eq.sharpe + 0.05) verdict = 'win';
    return { period: { start: grid[0], end: grid[grid.length - 1], months: grid.length, n: names.length },
             names, rotation: rot, eq, best, verdict };
  }

  // ─── 실험② 리밸 주기 민감도 (고정 균등비중 블렌드) ─────────────────────────
  function fixedWeightNav(names, navByName, grid, weights, rebalMonths) {
    const rets = {}; names.forEach(n => { rets[n] = monthlyRets(navByName[n]); });
    const v = {}; names.forEach(n => { v[n] = weights[n]; });           // 시작 배분(합=1)
    const nav = [1]; let nSwitch = 0;
    for (let i = 1; i < grid.length; i++) {
      names.forEach(n => { v[n] *= (1 + rets[n][i]); });
      const tot = names.reduce((s, n) => s + v[n], 0);
      if (rebalMonths && rebalMonths !== Infinity && i % rebalMonths === 0) {   // 주기마다 목표비중 복귀
        names.forEach(n => { v[n] = weights[n] * tot; }); nSwitch++;
      }
      nav.push(tot);
    }
    const pr = []; for (let i = 1; i < nav.length; i++) pr.push(nav[i] / nav[i - 1] - 1);
    return { nav, dates: grid.slice(), cagr: cagr(nav), mdd: mdd(nav), sharpe: sharpe(pr), nSwitch };
  }
  function rebalSweep(strategies, opts) {
    const strats = selectUniverse(strategies, opts.universe, opts.currency || 'krw');
    if (strats.length < 2) return null;
    const { grid, navByName } = commonGrid(strats);
    if (grid.length < 13) return null;
    const names = strats.map(s => s.name);
    const w = {}; names.forEach(n => { w[n] = 1 / names.length; });
    const FREQS = [{ label: '매수후보유', m: Infinity }, { label: '연 1회', m: 12 }, { label: '반기', m: 6 },
                   { label: '분기', m: 3 }, { label: '월', m: 1 }];
    const yrs = (grid.length - 1) / 12;
    const rows = FREQS.map(f => { const r = fixedWeightNav(names, navByName, grid, w, f.m);
      return { label: f.label, m: f.m, cagr: r.cagr, mdd: r.mdd, sharpe: r.sharpe,
               rebalPerYr: f.m === Infinity ? 0 : r.nSwitch / yrs, nav: r.nav, dates: r.dates }; });
    const sh = rows.map(r => r.sharpe).filter(x => !isNaN(x));
    return { period: { start: grid[0], end: grid[grid.length - 1], n: names.length, months: grid.length },
             rows, sharpeSpread: sh.length ? Math.max(...sh) - Math.min(...sh) : 0 };
  }

  // ─── 실험③ 고정 블렌드 최적화 (MC 프론티어 + 균등 + 훈련/검정 과최적화 점검) ─
  function portStats(names, R, weights) {              // R[name]=월수익배열(동일 길이). 연율 ret/vol/Sharpe.
    const T = R[names[0]].length; const pr = new Array(T);
    for (let t = 0; t < T; t++) { let s = 0; for (const n of names) s += weights[n] * R[n][t]; pr[t] = s; }
    const mu = mean(pr) * 12, vol = sampleStd(pr) * Math.sqrt(12);
    return { ret: mu, vol, sharpe: vol > 0 ? mu / vol : NaN, rets: pr };
  }
  function mkRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function mcOptimize(names, R, samples, seed) {       // 무작위 가중 표본 → 최대Sharpe·최소분산·구름
    const rng = mkRng(seed); const cloud = []; let maxS = null, minV = null;
    for (let k = 0; k < samples; k++) {
      const raw = names.map(() => -Math.log(1 - rng())); const tot = raw.reduce((a, b) => a + b, 0);
      const w = {}; names.forEach((n, j) => { w[n] = raw[j] / tot; });
      const ps = portStats(names, R, w);
      cloud.push({ vol: ps.vol, ret: ps.ret, sharpe: ps.sharpe });
      if (maxS === null || ps.sharpe > maxS.sharpe) maxS = { ret: ps.ret, vol: ps.vol, sharpe: ps.sharpe, w };
      if (minV === null || ps.vol < minV.vol) minV = { ret: ps.ret, vol: ps.vol, sharpe: ps.sharpe, w };
    }
    return { cloud, maxS, minV };
  }
  function blendOptimize(strategies, opts) {
    const strats = selectUniverse(strategies, opts.universe, opts.currency || 'krw');
    if (strats.length < 2) return null;
    const { grid, navByName } = commonGrid(strats);
    if (grid.length < 25) return null;
    const names = strats.map(s => s.name);
    const R = {}; names.forEach(n => { R[n] = monthlyRets(navByName[n]).slice(1); });   // 길이 grid.length-1
    const eqW = {}; names.forEach(n => { eqW[n] = 1 / names.length; });
    const eq = portStats(names, R, eqW);
    const samples = opts.samples || 2500;
    const opt = mcOptimize(names, R, samples, 20260710);
    // 훈련/검정: 전반부에서 최대Sharpe 가중 → 후반부 성과. 균등가중과 후반부 비교(과최적화 점검).
    const T = R[names[0]].length, half = Math.floor(T / 2);
    const Rtr = {}, Rte = {}; names.forEach(n => { Rtr[n] = R[n].slice(0, half); Rte[n] = R[n].slice(half); });
    const trOpt = mcOptimize(names, Rtr, samples, 777).maxS;
    const optTest = portStats(names, Rte, trOpt.w), eqTest = portStats(names, Rte, eqW);
    let ttVerdict = 'tie';
    if (optTest.sharpe > eqTest.sharpe + 0.05) ttVerdict = 'win';
    else if (optTest.sharpe < eqTest.sharpe - 0.05) ttVerdict = 'lose';
    const topW = names.map(n => ({ name: n, w: opt.maxS.w[n] })).sort((a, b) => b.w - a.w).slice(0, 6);
    return { period: { start: grid[0], end: grid[grid.length - 1], n: names.length, months: grid.length },
             cloud: opt.cloud, eq, maxSharpe: opt.maxS, minVol: opt.minV, topW,
             trainTest: { opt: optTest, eq: eqTest, verdict: ttVerdict, split: grid[half] } };
  }

  root.ROTATION = { run, rebalSweep, blendOptimize, cagr, mdd, sharpe, selectUniverse };
})(typeof window !== 'undefined' ? window : this);
