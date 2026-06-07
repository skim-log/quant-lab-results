/* web/analytics-live.js — 정량분석 클라이언트 재계산 엔진 (기간 조절형 효율적 프론티어).
 *
 * rebalancer optimization.ts(몬테카를로 프론티어) + analytics.ts(riskStats·상관·리스크패리티) 이식 +
 * scipy SLSQP 대체 **JS 정밀 마코위츠**(simplexProject + projected-gradient). 빌드타임 산출(metrics.py)과
 * 동일한 d-객체 구조를 만들어 app.js renderAnalytics 가 그대로 렌더한다. 8자산 월수익 행렬을 슬라이스해
 * 어떤 하위 구간이든 브라우저에서 즉시 재계산(서버·사전계산 불필요).
 */
'use strict';
(function (root) {
  // ── 기본 수치 유틸 ──────────────────────────────────────────────────────
  const meanArr = a => { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const matVec = (M, w) => M.map(row => dot(row, w));

  function portReturns(R, w) {              // R: K×T, w: K → 포트폴리오 월수익 T
    const T = R[0].length, K = R.length, out = new Array(T);
    for (let t = 0; t < T; t++) { let s = 0; for (let k = 0; k < K; k++) s += w[k] * R[k][t]; out[t] = s; }
    return out;
  }

  function covMatrix(R, mu) {                // 모분산(/T) 공분산 K×K
    const K = R.length, T = R[0].length;
    const S = Array.from({ length: K }, () => new Array(K).fill(0));
    for (let i = 0; i < K; i++) for (let j = i; j < K; j++) {
      let s = 0; for (let t = 0; t < T; t++) s += (R[i][t] - mu[i]) * (R[j][t] - mu[j]);
      const v = s / T; S[i][j] = v; S[j][i] = v;
    }
    return S;
  }

  // ── 위험·수익 (analytics.ts riskStats 이식) ──────────────────────────────
  function riskStats(rs, ppy, rf) {
    const n = rs.length;
    if (n < 2) return { ann_return: 0, ann_vol: 0, downside_vol: 0, sharpe: 0, sortino: 0, mdd: 0, total_return: 0, observations: n };
    let sum = 0; for (const r of rs) sum += r; const mean = sum / n;
    let vs = 0, dsq = 0; for (const r of rs) { const d = r - mean; vs += d * d; if (r < 0) dsq += r * r; }
    const annVol = Math.sqrt(vs / n) * Math.sqrt(ppy);
    const downVol = Math.sqrt(dsq / n) * Math.sqrt(ppy);
    let logSum = 0, bad = false; for (const r of rs) { const one = 1 + r; if (one <= 0) { bad = true; break; } logSum += Math.log(one); }
    const total = bad ? 0 : Math.exp(logSum) - 1;
    const annR = bad ? 0 : Math.exp(logSum * (ppy / n)) - 1;
    const sharpe = annVol > 1e-12 ? (annR - rf) / annVol : 0;
    const sortino = downVol > 1e-12 ? (annR - rf) / downVol : 0;
    let nav = 1, peak = 1, mdd = 0; for (const r of rs) { nav *= 1 + r; if (nav > peak) peak = nav; const dd = (peak - nav) / peak; if (dd > mdd) mdd = dd; }
    return { ann_return: annR, ann_vol: annVol, downside_vol: downVol, sharpe, sortino, mdd, total_return: total, observations: n };
  }

  function pearson(a, b) {
    const n = a.length; if (n < 2) return null;
    let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n; let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    if (da <= 0 || db <= 0) return null;
    return num / Math.sqrt(da * db);
  }
  function correlationMatrix(R, keys) {
    const matrix = R.map((ri, i) => R.map((rj, j) => i === j ? 1 : pearson(ri, rj)));
    return { assets: keys.slice(), matrix };
  }
  function riskParityWeights(vols) {
    const inv = {}; let s = 0;
    for (const k in vols) { inv[k] = vols[k] > 0 ? 1 / vols[k] : 0; s += inv[k]; }
    const out = {}; for (const k in vols) out[k] = { vol: vols[k], inverse_vol: inv[k], weight: s > 0 ? inv[k] / s : 0 };
    return out;
  }

  // ── 몬테카를로 프론티어 (optimization.ts 이식 + 희소 샘플링) ──────────────
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function extractFrontier(pts, bins) {
    bins = bins || 40; if (!pts.length) return [];
    let mn = Infinity, mx = -Infinity; for (const p of pts) { if (p[0] < mn) mn = p[0]; if (p[0] > mx) mx = p[0]; }
    if (mx <= mn) return [[mn, Math.max.apply(null, pts.map(p => p[1]))]];
    const bw = (mx - mn) / bins, best = new Array(bins).fill(null);
    for (const p of pts) { let b = Math.floor((p[0] - mn) / bw); if (b >= bins) b = bins - 1; if (b < 0) b = 0; if (!best[b] || p[1] > best[b][1]) best[b] = p; }
    const cand = best.filter(Boolean).sort((a, b) => a[0] - b[0]);
    const out = []; let mr = -Infinity; for (const p of cand) { if (p[1] >= mr) { out.push([p[0], p[1]]); mr = p[1]; } }
    return out;
  }

  function monteCarloFrontier(R, keys, labels, colors, ppy, rf, n, seed, presetDefs, storePoints) {
    const K = R.length, T = R[0].length;
    if (T < 2 || K === 0) return { n_sims: 0, points: [], curve: [], max_sharpe: null, min_var: null, single_asset: [], presets: [], _bestW: null };
    n = Math.max(100, Math.min(n, 50000)); const rng = mulberry32(seed);
    const fast = w => {                       // (vol, ret, sharpe) 빠른 통계
      const pr = portReturns(R, w); let sum = 0; for (let t = 0; t < T; t++) sum += pr[t]; const mean = sum / T;
      let vsum = 0; for (let t = 0; t < T; t++) { const d = pr[t] - mean; vsum += d * d; }
      const vol = Math.sqrt(vsum / T * ppy);
      let logSum = 0, bad = false; for (let t = 0; t < T; t++) { const one = 1 + pr[t]; if (one <= 0) { bad = true; break; } logSum += Math.log(one); }
      const ret = bad ? 0 : Math.exp(logSum * (ppy / T)) - 1;
      return { vol, ret, sharpe: vol > 0 ? (ret - rf) / vol : 0 };
    };
    const dirichlet = () => { const w = new Array(K); let s = 0; for (let k = 0; k < K; k++) { const v = -Math.log(1 - rng()); w[k] = v; s += v; } for (let k = 0; k < K; k++) w[k] /= s; return w; };
    const nFull = Math.max(1, Math.floor(n / 3));
    let best = -Infinity, bestW = null, minV = Infinity, minW = null; const allPts = [];
    for (let i = 0; i < n; i++) {
      let w = dirichlet();
      if (i >= nFull && K > 1) {              // 희소: 일부 자산 0% (코너 탐색)
        const kk = 1 + Math.floor(rng() * K);
        const order = [...Array(K).keys()].map(j => [j, rng()]).sort((a, b) => a[1] - b[1]).slice(0, kk).map(x => x[0]);
        const m = new Array(K).fill(0); for (const j of order) m[j] = w[j];
        const s = m.reduce((a, b) => a + b, 0); if (s > 0) w = m.map(x => x / s);
      }
      const st = fast(w); allPts.push([st.vol, st.ret]);
      if (st.sharpe > best) { best = st.sharpe; bestW = w.slice(); }
      if (st.vol < minV) { minV = st.vol; minW = w.slice(); }
    }
    const rec = w => { const s = riskStats(portReturns(R, w), ppy, rf); const wt = {}; for (let k = 0; k < K; k++) if (w[k] > 1e-6) wt[keys[k]] = w[k]; return { ret: s.ann_return, vol: s.ann_vol, sharpe: s.sharpe, weights: wt, stats: s }; };
    const single = keys.map((k, i) => { const e = new Array(K).fill(0); e[i] = 1; const st = fast(e); return { key: k, label: labels[k], color: colors[k], ret: st.ret, vol: st.vol, sharpe: st.sharpe }; });
    const presets = [];
    for (const name in (presetDefs || {})) {
      const wd = presetDefs[name].weights || {}; const w = keys.map(k => +(wd[k] || 0));
      const s = w.reduce((a, b) => a + b, 0); if (s <= 0) continue;
      const r = rec(w.map(x => x / s)); presets.push({ name, label: presetDefs[name].label || name, ret: r.ret, vol: r.vol, sharpe: r.sharpe, weights: r.weights });
    }
    let points = allPts; storePoints = storePoints || 2000;
    if (allPts.length > storePoints) { points = []; const step = allPts.length / storePoints; for (let i = 0; i < storePoints; i++) points.push(allPts[Math.floor(i * step)]); }
    return { n_sims: n, points, curve: extractFrontier(allPts), max_sharpe: rec(bestW), min_var: rec(minW), single_asset: single, presets, _bestW: bestW };
  }

  // ── 정밀 마코위츠 (long-only) — simplexProject + projected gradient ───────
  function simplexProject(v) {               // {w≥0, Σw=1} 유클리드 투영(Wang & Carreira-Perpiñán)
    const n = v.length, u = v.slice().sort((a, b) => b - a);
    let css = 0, theta = 0;
    for (let i = 0; i < n; i++) { css += u[i]; const t = (css - 1) / (i + 1); if (u[i] - t > 0) theta = t; }
    return v.map(x => Math.max(0, x - theta));
  }
  const specNorm = S => { let m = 0; for (const row of S) { let s = 0; for (const x of row) s += Math.abs(x); if (s > m) m = s; } return m; };

  function pgdGMV(S) {                        // min wᵀΣw s.t. Σw=1, w≥0
    const K = S.length, lr = 1 / (2 * specNorm(S) + 1e-9); let w = new Array(K).fill(1 / K);
    for (let it = 0; it < 800; it++) { const g = matVec(S, w); for (let k = 0; k < K; k++) w[k] -= lr * 2 * g[k]; w = simplexProject(w); }
    return w;
  }
  function projAffine(w, mu, target, sumMu, sumMu2) {   // {Σw=1, μ·w=target} 투영
    const K = w.length; let s1 = 0, sm = 0; for (let k = 0; k < K; k++) { s1 += w[k]; sm += mu[k] * w[k]; }
    const a11 = K, a12 = sumMu, a22 = sumMu2, det = a11 * a22 - a12 * a12; if (Math.abs(det) < 1e-12) return w;
    const r1 = s1 - 1, r2 = sm - target;
    const l1 = (a22 * r1 - a12 * r2) / det, l2 = (-a12 * r1 + a11 * r2) / det;
    return w.map((x, k) => x - (l1 + l2 * mu[k]));
  }
  function pgdTarget(S, mu, target, sumMu, sumMu2) {     // min 분산 s.t. 수익=target (POCS)
    const K = S.length, lr = 1 / (2 * specNorm(S) + 1e-9); let w = new Array(K).fill(1 / K);
    for (let it = 0; it < 300; it++) {
      const g = matVec(S, w); for (let k = 0; k < K; k++) w[k] -= lr * 2 * g[k];
      for (let p = 0; p < 25; p++) { w = projAffine(w, mu, target, sumMu, sumMu2); let neg = false; w = w.map(x => x < 0 ? (neg = true, 0) : x); if (!neg) break; }
      const s = w.reduce((a, b) => a + b, 0); if (s > 0) w = w.map(x => x / s);
    }
    return w;
  }
  function pgdMaxSharpe(S, mu, rf, starts, R, ppy) {  // max Sharpe, s.t. Σw=1, w≥0
    // 탐색 방향은 산술 평균-분산 기울기, 선택은 **표시와 동일한 연환산(기하) Sharpe**로 — MC최적·동일가중
    // 시작점을 후보로 포함하므로 결과는 그들 이상이 보장됨.
    const lr = 1 / (2 * specNorm(S) + 1e-9); let best = null, bestS = -Infinity;
    const annSharpe = w => {
      const pr = portReturns(R, w); const n = pr.length; let sum = 0; for (const x of pr) sum += x; const mean = sum / n;
      let vs = 0; for (const x of pr) { const d = x - mean; vs += d * d; } const vol = Math.sqrt(vs / n * ppy);
      let ls = 0, bad = false; for (const x of pr) { const o = 1 + x; if (o <= 0) { bad = true; break; } ls += Math.log(o); }
      const ret = bad ? 0 : Math.exp(ls * (ppy / n)) - 1; return vol > 1e-12 ? (ret - rf) / vol : -Infinity;
    };
    const consider = w => { const sh = annSharpe(w); if (sh > bestS) { bestS = sh; best = w.slice(); } };
    for (const w0 of starts) {
      let w = simplexProject(w0.slice());
      consider(w);                            // 시작점(동일가중·단일·GMV·MC최적)도 후보
      for (let it = 0; it < 600; it++) {
        const Sw = matVec(S, w), v2 = Math.max(dot(w, Sw), 1e-18), v = Math.sqrt(v2), r = dot(mu, w) - rf;
        const g = new Array(w.length); for (let k = 0; k < w.length; k++) g[k] = mu[k] / v - r * Sw[k] / (v * v2);
        for (let k = 0; k < w.length; k++) w[k] += lr * g[k]; w = simplexProject(w);
        consider(w);                          // best-seen 추적(오버슈트해도 최적점 보존)
      }
    }
    // 국소 확률 탐색 정련 — 표시 지표(연환산 기하 Sharpe)를 직접 그리디 최대화(PGD 방향-선택 불일치 보정).
    const K = mu.length; let a = 0x9e3779b9 >>> 0; const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
    let cur = best.slice(), curS = bestS;
    for (let it = 0; it < 2500; it++) {
      const step = 0.30 * (1 - it / 2500) + 0.004;
      const cand = cur.slice(); const i = Math.floor(rnd() * K), j = Math.floor(rnd() * K);
      const d = (rnd() * 2 - 1) * step; cand[i] += d; cand[j] -= d;     // 비중 이전(합 보존)
      const w = simplexProject(cand); const sh = annSharpe(w);
      if (sh > curS) { cur = w; curS = sh; if (sh > bestS) { bestS = sh; best = w.slice(); } }
    }
    return best;
  }

  function markowitzFrontier(R, keys, labels, colors, ppy, rf, mcPoints, mcBestW) {
    const K = R.length, T = R[0].length; if (T < 3 || K === 0) return null;
    const mu = R.map(meanArr), S = covMatrix(R, mu);
    const tr = S.reduce((a, row, i) => a + row[i], 0), ridge = (tr / K) * 1e-8; for (let i = 0; i < K; i++) S[i][i] += ridge;
    const sumMu = mu.reduce((a, b) => a + b, 0), sumMu2 = mu.reduce((a, b) => a + b * b, 0);
    const record = w => {
      if (!w) return null; const pr = portReturns(R, w), st = riskStats(pr, ppy, rf), wt = {};
      for (let k = 0; k < K; k++) if (w[k] > 1e-6) wt[keys[k]] = w[k];
      const nav = []; let acc = 1; for (const r of pr) { acc *= 1 + r; nav.push(Math.round(acc * 1e6) / 1e6); }
      return { ret: st.ann_return, vol: st.ann_vol, sharpe: st.sharpe, weights: wt, stats: st, nav };
    };
    const wGmv = pgdGMV(S), gRec = record(wGmv);
    const rLo = dot(mu, wGmv), rHi = Math.max.apply(null, mu), feas = [];
    if (rHi > rLo) for (let i = 0; i < 36; i++) { const t = rLo + (rHi - rLo) * i / 35; const w = pgdTarget(S, mu, t, sumMu, sumMu2); const s = riskStats(portReturns(R, w), ppy, rf); feas.push([s.ann_vol, s.ann_return]); }
    const starts = [new Array(K).fill(1 / K), wGmv.slice()];
    for (let k = 0; k < K; k++) { const e = new Array(K).fill(0); e[k] = 1; starts.push(e); }
    if (mcBestW) starts.push(mcBestW.slice());
    const tRec = record(pgdMaxSharpe(S, mu, rf, starts, R, ppy));
    const pts = []; for (const p of (mcPoints || [])) pts.push(p); for (const f of feas) pts.push(f);
    if (gRec) pts.push([gRec.vol, gRec.ret]); if (tRec) pts.push([tRec.vol, tRec.ret]);
    const curve = extractFrontier(pts);
    const vols = {}; for (let k = 0; k < K; k++) vols[keys[k]] = Math.sqrt(S[k][k] * ppy);
    const rp = riskParityWeights(vols), wRp = keys.map(k => rp[k].weight), sRp = wRp.reduce((a, b) => a + b, 0);
    const alts = [{ name: 'equal_weight', label: '동일가중', ...record(new Array(K).fill(1 / K)) }];
    if (gRec) alts.push({ name: 'min_variance', label: '최소분산', ...gRec });
    if (sRp > 0) alts.push({ name: 'risk_parity', label: '리스크 패리티', ...record(wRp.map(x => x / sRp)) });
    return { method: 'markowitz_js', curve_mv: curve, tangency: tRec, gmv: gRec, alternatives: alts, dates: null };
  }

  // ── d-객체 빌더: payload(전체 월수익) + range(s,e) → 정량분석 객체 ─────────
  function buildAnalytics(payload, range) {
    const allDates = payload.dates || [], assets = payload.assets || [], keys = assets.map(a => a.key);
    const labels = {}, colors = {}; for (const a of assets) { labels[a.key] = a.label; colors[a.key] = a.color; }
    let lo = 0, hi = allDates.length - 1;
    if (range && range.s) while (lo < allDates.length && allDates[lo] < range.s) lo++;
    if (range && range.e) while (hi >= 0 && allDates[hi] > range.e) hi--;
    const idx = []; for (let i = lo; i <= hi; i++) idx.push(i);
    const dates = idx.map(i => allDates[i]);
    const R = keys.map(k => idx.map(i => (payload.returns[k] || [])[i]));
    const ppy = payload.periods_per_year || 12, rf = payload.rf != null ? payload.rf : 0.02, n = dates.length;
    const risk_return = [], vols = {};
    for (let k = 0; k < keys.length; k++) { const st = riskStats(R[k], ppy, rf); vols[keys[k]] = st.ann_vol; risk_return.push({ key: keys[k], label: labels[keys[k]], color: colors[keys[k]], ...st }); }
    const rp = riskParityWeights(vols);
    const defW = ((payload.preset_defs && payload.preset_defs[payload.default_preset]) || {}).weights || {};
    const risk_parity = keys.map(k => ({ key: k, label: labels[k], color: colors[k], vol: rp[k].vol, weight: rp[k].weight, target: +(defW[k] || 0) }));
    const correlation = correlationMatrix(R, keys);
    const mc = monteCarloFrontier(R, keys, labels, colors, ppy, rf, 6000, 12345, payload.preset_defs, 2000);
    let marko = null;
    if (n >= 12) { marko = markowitzFrontier(R, keys, labels, colors, ppy, rf, mc.points, mc._bestW); if (marko) marko.dates = dates; }
    const frontier = { n_sims: mc.n_sims, points: mc.points, curve: mc.curve, max_sharpe: mc.max_sharpe, min_var: mc.min_var, single_asset: mc.single_asset, presets: mc.presets, markowitz: marko };
    return {
      kind: 'analytics', live: true, title: payload.title, generated_at: payload.generated_at,
      currency: payload.currency, periods_per_year: ppy, rf, period: dates.length ? `${dates[0]}~${dates[dates.length - 1]}` : '',
      n_months: n, assets, correlation, risk_return, risk_parity, default_preset: payload.default_preset, frontier,
    };
  }

  const API = { buildAnalytics, riskStats, correlationMatrix, riskParityWeights, monteCarloFrontier, markowitzFrontier, simplexProject, extractFrontier };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;   // node(검증)
  root.ANALYTICS = API;                                                        // 브라우저 전역
})(typeof window !== 'undefined' ? window : globalThis);
