/* web/leverage.js — 최적 레버리지 분석 클라이언트 계산 엔진.
 *
 * Python src/strategies/us/leverage_opt.py + src/common/metrics.py 미러.
 * leverage.json 에 임베드된 일별 기초수익(under_ret)·단기금리(rf)에서 임의 레버리지 L·기간·
 * 시나리오(이론/ETF)로 CAGR(L) 곡선·자산곡선·지표·관리변동성을 브라우저에서 즉석 재계산.
 *
 * 레버리지 일간수익:  r_L = L·u − (L−1)·rf/dpy − expense/dpy − L·spread/dpy   (하한 −0.99 클립)
 * 지표는 metrics.py 공식 동일: CAGR=nav^(365.25/일수)−1, 연변동성=popStd·√dpy, Sharpe=mean/popStd·√dpy.
 */
'use strict';
(function (root) {
  const DPY = 252;

  /** 정렬된 ISO 날짜 배열에서 [start,end] 포함 인덱스 범위 [lo,hi]. 없으면 [0,len-1]. */
  function sliceRange(dates, start, end) {
    let lo = 0, hi = dates.length - 1;
    if (start) { while (lo <= hi && dates[lo] < start) lo++; }
    if (end) { while (hi >= lo && dates[hi] > end) hi--; }
    if (lo > hi) return [0, dates.length - 1];
    return [lo, hi];
  }

  /** 상수 레버리지 일간수익(배열). u/rf 동일 길이. */
  function leverReturns(u, rf, L, opts) {
    opts = opts || {};
    const dpy = opts.dpy || DPY, exp = opts.expense || 0, spr = opts.spread || 0;
    const drag = exp / dpy;
    const out = new Float64Array(u.length);
    for (let i = 0; i < u.length; i++) {
      let r = L * u[i] - (L - 1) * (rf[i] || 0) / dpy - drag - L * spr / dpy;
      out[i] = r < -0.99 ? -0.99 : r;
    }
    return out;
  }

  /** 목표 변동성 추종(동적 레버리지). L_t = clip(target/σ̂_{t-1}, 0, lMax). σ̂=직전 lookback일 popStd·√dpy. */
  function managedVol(u, rf, targetVol, opts) {
    opts = opts || {};
    const dpy = opts.dpy || DPY, lookback = opts.lookback || 20, lMax = opts.lMax || 3.0;
    const exp = opts.expense || 0, spr = opts.spread || 0, drag = exp / dpy;
    const n = u.length, ret = new Float64Array(n), lt = new Float64Array(n);
    // 롤링 popStd (running sums)
    let s = 0, s2 = 0;
    const volEst = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      s += u[i]; s2 += u[i] * u[i];
      if (i >= lookback) { s -= u[i - lookback]; s2 -= u[i - lookback] * u[i - lookback]; }
      if (i >= lookback - 1) {
        const mean = s / lookback;
        const varp = Math.max(s2 / lookback - mean * mean, 0);
        volEst[i] = Math.sqrt(varp) * Math.sqrt(dpy);
      }
    }
    let sumL = 0, cntL = 0;
    for (let i = 0; i < n; i++) {
      const ve = i > 0 ? volEst[i - 1] : NaN;          // shift(1): 룩어헤드 방지
      let L = (isFinite(ve) && ve > 1e-9) ? targetVol / ve : 1.0;
      if (L < 0) L = 0; if (L > lMax) L = lMax;
      lt[i] = L; sumL += L; cntL++;
      let r = L * u[i] - (L - 1) * (rf[i] || 0) / dpy - drag - L * spr / dpy;
      ret[i] = r < -0.99 ? -0.99 : r;
    }
    return { ret, lt, avgL: cntL ? sumL / cntL : 1.0 };
  }

  function navFromReturns(ret) {
    const nav = new Float64Array(ret.length);
    let v = 1.0;
    for (let i = 0; i < ret.length; i++) { v *= (1 + ret[i]); nav[i] = v; }
    return nav;
  }

  /** metrics.py 동일 — ret(일간), dates(ISO, 같은 길이) → 지표. */
  function metrics(ret, dates) {
    const n = ret.length;
    if (n < 2) return { cagr: NaN, vol: NaN, sharpe: NaN, sortino: NaN, mdd: NaN, total: NaN };
    let mean = 0; for (let i = 0; i < n; i++) mean += ret[i]; mean /= n;
    let varp = 0, dvar = 0, dcnt = 0;
    for (let i = 0; i < n; i++) {
      const d = ret[i] - mean; varp += d * d;
      if (ret[i] < 0) { dvar += ret[i] * ret[i]; dcnt++; }   // metrics.sortino: downside=excess<0, std ddof=0 of those
    }
    varp /= n;
    const sd = Math.sqrt(varp);
    // sortino 분모: 음수수익들의 std(ddof=0) = sqrt(mean_over_negatives((r-? )))... metrics.py: downside.std(ddof=0)
    let dmean = 0; if (dcnt) { let s = 0; for (let i = 0; i < n; i++) if (ret[i] < 0) s += ret[i]; dmean = s / dcnt; }
    let dsd = 0; if (dcnt) { let s = 0; for (let i = 0; i < n; i++) if (ret[i] < 0) { const d = ret[i] - dmean; s += d * d; } dsd = Math.sqrt(s / dcnt); }
    const sqp = Math.sqrt(DPY);
    const sharpe = sd > 0 ? mean / sd * sqp : NaN;
    const sortino = dsd > 0 ? mean / dsd * sqp : NaN;
    const vol = sd * sqp;
    // nav, mdd
    let v = 1.0, peak = 1.0, mdd = 0.0;
    for (let i = 0; i < n; i++) { v *= (1 + ret[i]); if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
    const days = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 86400000;
    const years = Math.max(days / 365.25, 1e-9);
    const cagr = Math.pow(v, 1 / years) - 1;
    return { cagr, vol, sharpe, sortino, mdd, total: v - 1 };
  }

  /** L 격자 스윕 → {L,cagr,vol,mdd,sharpe,sortino}. u/rf/dates 는 이미 기간 슬라이스된 배열. */
  function sweep(u, rf, dates, lGrid, opts) {
    const out = { L: [], cagr: [], vol: [], mdd: [], sharpe: [], sortino: [] };
    for (const L of lGrid) {
      const r = leverReturns(u, rf, L, opts);
      const m = metrics(r, dates);
      out.L.push(L); out.cagr.push(m.cagr); out.vol.push(m.vol);
      out.mdd.push(m.mdd); out.sharpe.push(m.sharpe); out.sortino.push(m.sortino);
    }
    return out;
  }

  function optimal(sw, sharpeMinL) {
    sharpeMinL = sharpeMinL == null ? 1.0 : sharpeMinL;
    const am = (vals, minL) => {
      let bi = -1, bv = -Infinity;
      for (let i = 0; i < vals.length; i++) {
        if (minL != null && sw.L[i] < minL) continue;
        if (vals[i] != null && isFinite(vals[i]) && vals[i] > bv) { bv = vals[i]; bi = i; }
      }
      return bi;
    };
    const ic = am(sw.cagr), is = am(sw.sharpe, sharpeMinL);
    const pick = i => i < 0 ? null : { L: sw.L[i], cagr: sw.cagr[i], vol: sw.vol[i], mdd: sw.mdd[i], sharpe: sw.sharpe[i] };
    return { cagr_max: pick(ic), sharpe_max: pick(is) };
  }

  /** 표시용 다운샘플: nav(또는 ret) 배열을 최대 maxPts 점으로 (메트릭은 풀데이터로 별도 계산). */
  function downsampleIdx(n, maxPts) {
    if (n <= maxPts) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }
    const step = (n - 1) / (maxPts - 1), a = [];
    for (let k = 0; k < maxPts; k++) a.push(Math.round(k * step));
    a[a.length - 1] = n - 1;
    return a;
  }

  const API = { DPY, sliceRange, leverReturns, managedVol, navFromReturns, metrics, sweep, optimal, downsampleIdx };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.LEVERAGE = API;
})(typeof window !== 'undefined' ? window : globalThis);
