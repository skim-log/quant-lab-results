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

  // ─── ETF 조합 일별 리스크 렌즈 — 임의 비중 → 일별 vs 월별 낙폭(플레이그라운드 조합용, 클라이언트 재구성) ─
  function _periodKey(ds, m) {
    const y = ds.slice(0, 4), mo = +ds.slice(5, 7);
    if (m === 1) return ds.slice(0, 7);
    if (m === 3) return y + 'Q' + Math.ceil(mo / 3);
    if (m === 6) return y + 'H' + Math.ceil(mo / 6);
    return y;
  }
  function _mddRange(dates, nav, a, b) {
    let pk = -Infinity, m = 0, any = false;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] >= a && dates[i] <= b) { any = true; const v = nav[i]; if (v > pk) pk = v; const dd = v / pk - 1; if (dd < m) m = dd; }
    }
    return any ? +(m * 100).toFixed(1) : null;
  }
  // daily = {dates:['YYYY-MM-DD'], fx:[krw/usd], etfs:{ticker:[px(USD)|null]}}. weights={ticker:frac}. opts={currency,rebalance}
  function etfDailyRisk(daily, weights, opts) {
    if (!daily || !daily.dates) return null;
    const cur = (opts && opts.currency) || 'krw';
    const names = Object.keys(weights).filter(n => weights[n] > 0 && daily.etfs[n]);
    if (!names.length) return null;
    const D = daily.dates, FX = daily.fx;
    const idx = [];
    for (let i = 0; i < D.length; i++) if (names.every(n => daily.etfs[n][i] != null)) idx.push(i);
    if (idx.length < 60) return null;
    let tot = 0; names.forEach(n => { tot += weights[n]; }); const w = {}; names.forEach(n => { w[n] = weights[n] / tot; });
    const px = {}; names.forEach(n => { px[n] = idx.map(i => cur === 'krw' ? daily.etfs[n][i] * FX[i] : daily.etfs[n][i]); });
    const dates = idx.map(i => D[i]);
    const rebalM = ({ never: Infinity, monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 })[(opts && opts.rebalance)];
    const rm = rebalM === undefined ? 3 : rebalM;
    const val = {}; names.forEach(n => { val[n] = w[n]; });
    const nav = [1]; let lastKey = _periodKey(dates[0], rm);
    for (let k = 1; k < dates.length; k++) {
      names.forEach(n => { val[n] *= px[n][k] / px[n][k - 1]; });
      let s = names.reduce((a, n) => a + val[n], 0);
      if (rm !== Infinity) { const key = _periodKey(dates[k], rm); if (key !== lastKey) { names.forEach(n => { val[n] = w[n] * s; }); lastKey = key; } }
      nav.push(names.reduce((a, n) => a + val[n], 0));
    }
    const ddDaily = []; { let pk = -Infinity; for (const v of nav) { if (v > pk) pk = v; ddDaily.push((v / pk - 1) * 100); } }
    const retD = []; for (let i = 1; i < nav.length; i++) retD.push(nav[i] / nav[i - 1] - 1);
    const mLast = new Map(); dates.forEach((d, i) => mLast.set(d.slice(0, 7), i));
    const mIdx = [...mLast.values()].sort((a, b) => a - b);
    const navM = mIdx.map(i => nav[i]), datesM = mIdx.map(i => dates[i]);
    const ddM = []; { let pk = -Infinity; for (const v of navM) { if (v > pk) pk = v; ddM.push((v / pk - 1) * 100); } }
    const retM = []; for (let i = 1; i < navM.length; i++) retM.push(navM[i] / navM[i - 1] - 1);
    const ds10 = [], v10 = []; for (let i = 0; i < ddDaily.length; i += 10) { ds10.push(dates[i]); v10.push(+ddDaily[i].toFixed(2)); }
    const sqrt = Math.sqrt, sdD = sampleStd(retD), sdM = sampleStd(retM);
    const win = (a, b) => ({ d: _mddRange(dates, nav, a, b), m: _mddRange(datesM, navM, a, b) });
    return {
      start: dates[0], end: dates[dates.length - 1],
      dd_daily: { dates: ds10, v: v10 },
      dd_monthly: { dates: datesM, v: ddM.map(x => +x.toFixed(2)) },
      mdd_daily: +(mdd(nav) * 100).toFixed(1), mdd_monthly: +(mdd(navM) * 100).toFixed(1),
      vol_daily: +(sdD * sqrt(252) * 100).toFixed(1), vol_monthly: +(sdM * sqrt(12) * 100).toFixed(1),
      sharpe_daily: +(sdD > 0 ? mean(retD) / sdD * sqrt(252) : NaN).toFixed(2),
      sharpe_monthly: +(sdM > 0 ? mean(retM) / sdM * sqrt(12) : NaN).toFixed(2),
      windows: { covid: win('2020-01-01', '2020-06-30'), gfc: win('2007-06-01', '2009-07-31'), y2022: win('2022-01-01', '2022-12-31') },
      n: names.length,
    };
  }

  root.ROTATION = { run, rebalSweep, blendOptimize, etfDailyRisk, cagr, mdd, sharpe, selectUniverse };
})(typeof window !== 'undefined' ? window : this);
