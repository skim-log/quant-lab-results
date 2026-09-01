/* web/dca.js — 적립식(DCA) 시뮬레이터 클라이언트 계산 엔진.
 *
 * Python src/strategies/us/dca_sim.py 미러(패리티 테스트 web/dca.test.mjs 가 강제).
 * dca.json 에 임베드된 마스터 날짜축 + family 일간수익 + 실제 ETF 일간수익 + 금리 + 환율에서
 * 임의의 월적립금·기간·종목·레버리지로 평가액·XIRR·낙폭·L 스윕을 브라우저에서 즉석 재계산한다.
 *
 * 레버리지 일간수익:  r_L = L·u − (L−1)·rf/dpy − expense/dpy − L·spread/dpy   (하한 −0.99 클립)
 * 적립식:            매월 첫 거래일에 monthly(적립통화) 납입 → 그날 환율로 USD 환전 → 수수료 차감 후 매수
 *
 * ※ 파이썬과 어긋나기 쉬운 지점(패리티 테스트가 지키는 계약):
 *   - 매수일 = '연*100+월'이 바뀌는 첫 인덱스 (월 1일이 휴장이면 그 달 첫 거래일)
 *   - 수수료는 매수금액에서 차감(주수 = 금액×(1−fee)/가격), 매도 없음
 *   - 평가액 = 주수 × 가격 × 그날 환율 (환율은 마스터 축에 이미 ffill 되어 들어온다)
 *   - XIRR 은 이분법 200회 고정(연율 365.25일 기준), 부호는 납입=음수·최종평가액=양수
 *   - 1x 자산의 'family ETF 구간'에서는 운용보수를 다시 빼지 않는다(수정종가가 이미 실비용 반영)
 */
'use strict';
(function (root) {
  const DPY = 252;
  const CLIP = -0.99;

  // ── 기간 슬라이스 ──────────────────────────────────────────────────────────
  /** 정렬된 ISO 날짜 배열에서 [start,end] 포함 인덱스 범위 [lo,hi]. 비면 null. */
  function sliceRange(dates, start, end) {
    let lo = 0, hi = dates.length - 1;
    if (start) { while (lo <= hi && dates[lo] < start) lo++; }
    if (end) { while (hi >= lo && dates[hi] > end) hi--; }
    if (lo > hi) return null;
    return [lo, hi];
  }

  /** 매월 첫 거래일의 위치 인덱스(dates 는 'YYYY-MM-DD'). dca_sim.month_first_indices 미러. */
  function monthFirstIndices(dates, lo, hi) {
    lo = lo || 0; hi = (hi == null ? dates.length - 1 : hi);
    const out = [];
    let prev = '';
    for (let i = lo; i <= hi; i++) {
      const ym = dates[i].slice(0, 7);
      if (ym !== prev) { out.push(i); prev = ym; }
    }
    return out;
  }

  // ── 수익률 조립 ────────────────────────────────────────────────────────────
  /** 상수 레버리지 일간수익. u/rf 동일 길이 배열. */
  function leverReturns(u, rf, L, opts) {
    opts = opts || {};
    const dpy = opts.dpy || DPY, exp = opts.expense || 0, spr = opts.spread || 0;
    const drag = exp / dpy;
    const out = new Float64Array(u.length);
    for (let i = 0; i < u.length; i++) {
      const r = L * u[i] - (L - 1) * (rf[i] || 0) / dpy - drag - L * spr / dpy;
      out[i] = r < CLIP ? CLIP : r;
    }
    return out;
  }

  /**
   * 자산 하나의 일간수익을 마스터 축 [lo,hi] 구간에 대해 조립.
   * d: dca.json, asset: assets[] 원소, source: 'mixed'(합성+실제) | 'real'(실제만)
   * 반환 {ret: Float64Array, lo, hi} — ret[0] 이 마스터 인덱스 lo 에 대응.
   */
  function assetReturns(d, asset, lo, hi, source) {
    const fam = d.families[asset.family];
    const famStart = fam.start_idx, famRet = fam.ret;
    const real = asset.real ? d.reals[asset.real] : null;
    const n = hi - lo + 1;
    const out = new Float64Array(n);
    const dpy = d.dpy || DPY;
    const exp = asset.expense || 0, spr = asset.spread || 0, L = asset.leverage;
    // 실제 데이터가 시작되는 마스터 인덱스: 별도 실제 시리즈가 있으면 그 시작, 없으면 family ETF 상장
    const realIdx = real ? real.start_idx : fam.etf_start_idx;
    for (let i = 0; i < n; i++) {
      const m = lo + i;                        // 마스터 인덱스
      const fi = m - famStart;                 // family 배열 인덱스
      const u = (fi >= 0 && fi < famRet.length) ? famRet[fi] : 0;
      const rfv = (d.rf[m] || 0) / dpy;
      let r;
      if (real && m >= real.start_idx) {
        const ri = m - real.start_idx;
        r = ri < real.ret.length ? real.ret[ri] : 0;          // ③ 실제 펀드 수익률(실비용 반영)
      } else if (L === 1 && m >= fam.etf_start_idx) {
        // ② family 가 이미 실제 1x ETF(수정종가=실비용 반영) → 운용보수를 다시 빼지 않는다.
        //    VOO·VTI 처럼 별도 실제 시리즈가 있는 1x 도 그 상장 이전 구간은 여기로 온다
        //    (SPY 수익률에 VOO 보수를 덧씌우면 이중부과가 된다).
        r = u;
      } else {
        r = L * u - (L - 1) * rfv - exp / dpy - L * spr / dpy;  // ① 합성 확장 구간
        if (r < CLIP) r = CLIP;
      }
      out[i] = r;
    }
    return { ret: out, lo, hi, realIdx };
  }

  // ── 적립식 시뮬레이션 ──────────────────────────────────────────────────────
  /**
   * ret(일간수익), fx(마스터 축 전체), buyIdx(마스터 인덱스 배열) → 평가액·납입원금 경로.
   * offset = ret[0] 에 대응하는 마스터 인덱스(=lo). currency='usd' 면 fx 를 1 로 취급.
   */
  function simulate(ret, fx, buyIdx, monthly, opts) {
    opts = opts || {};
    const fee = opts.fee || 0, offset = opts.offset || 0, useFx = opts.useFx !== false;
    const n = ret.length;
    const nav = new Float64Array(n);
    let v = 1.0;
    for (let i = 0; i < n; i++) { v *= (1 + ret[i]); nav[i] = v; }
    const buy = new Uint8Array(n);
    for (const b of buyIdx) { const j = b - offset; if (j >= 0 && j < n) buy[j] = 1; }

    const equity = new Float64Array(n), cost = new Float64Array(n);
    let units = 0, paid = 0, spentUsd = 0;
    const flows = [];            // [마스터인덱스, 금액(음수)]
    const buyPrices = [];
    for (let i = 0; i < n; i++) {
      const f = useFx ? (fx[offset + i] || 0) : 1;
      if (buy[i]) {
        const amtUsd = f ? monthly / f : 0;
        units += amtUsd * (1 - fee) / nav[i];
        spentUsd += amtUsd;
        paid += monthly;
        flows.push([offset + i, -monthly]);
        buyPrices.push(nav[i]);
      }
      equity[i] = units * nav[i] * f;
      cost[i] = paid;
    }
    const avgCost = units > 1e-15 ? spentUsd / units : NaN;
    return { equity, cost, nav, units, flows, avgCost, buyPrices, offset };
  }

  /** 이분법 XIRR — dca_sim._xirr 미러(200회 고정, 365.25일 연율). */
  function xirr(dates, flows, finalIdx, finalVal) {
    const cfs = flows.map(f => [dates[f[0]], f[1]]);
    cfs.push([dates[finalIdx], finalVal]);
    if (cfs.length < 2) return NaN;
    let pos = false, neg = false;
    for (const c of cfs) { if (c[1] > 0) pos = true; if (c[1] < 0) neg = true; }
    if (!(pos && neg)) return NaN;
    const t0 = Date.parse(cfs[0][0]);
    const times = cfs.map(c => (Date.parse(c[0]) - t0) / 86400000 / 365.25);
    const amts = cfs.map(c => c[1]);
    const npv = rate => {
      let s = 0;
      for (let i = 0; i < amts.length; i++) s += amts[i] / Math.pow(1 + rate, times[i]);
      return s;
    };
    let lo = -0.9999, hi = 10.0;
    const fLo = npv(lo), fHi = npv(hi);
    if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return NaN;
    for (let k = 0; k < 200; k++) {
      const mid = 0.5 * (lo + hi);
      if (npv(mid) * fLo > 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** 적립식 지표 — dca_sim.dca_metrics 미러. dates 는 마스터 축 전체(ISO). */
  function dcaMetrics(dates, sim) {
    const eq = sim.equity, cost = sim.cost, n = eq.length, off = sim.offset;
    if (!n || cost[n - 1] <= 0) return null;
    let peak = -Infinity, mdd = 0, maxLoss = Infinity;
    let run = 0, best = 0, total = 0;
    for (let i = 0; i < n; i++) {
      if (eq[i] > peak) peak = eq[i];
      if (peak > 0) { const dd = eq[i] / peak - 1; if (dd < mdd) mdd = dd; }
      const gap = eq[i] - cost[i];
      if (gap < maxLoss) maxLoss = gap;
      if (eq[i] < cost[i]) { run++; total++; if (run > best) best = run; } else run = 0;
    }
    let bpSum = 0;
    for (const p of sim.buyPrices) bpSum += p;
    const meanPrice = sim.buyPrices.length ? bpSum / sim.buyPrices.length : NaN;
    const endMs = Date.parse(dates[off + n - 1]);
    const cutMs = endMs - 5 * 365.25 * 86400000;
    let last5 = 0;
    for (const f of sim.flows) if (Date.parse(dates[f[0]]) >= cutMs) last5 += -f[1];
    return {
      totalCost: cost[n - 1], final: eq[n - 1], multiple: eq[n - 1] / cost[n - 1],
      profit: eq[n - 1] - cost[n - 1],
      xirr: xirr(dates, sim.flows, off + n - 1, eq[n - 1]),
      mdd, maxLoss, underDays: best, underTotal: total, months: sim.flows.length,
      avgCost: sim.avgCost, meanPrice, cheapness: meanPrice / sim.avgCost - 1,
      last5yShare: last5 / cost[n - 1],
      start: dates[off], end: dates[off + n - 1],
    };
  }

  /** 같은 기간 일시불 기준선(총수익·MDD·CAGR) — 적립식 최적 L 과 대조용. */
  function lumpMetrics(ret, dates, off) {
    const n = ret.length;
    let v = 1, peak = 1, mdd = 0;
    for (let i = 0; i < n; i++) { v *= (1 + ret[i]); if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
    const days = (Date.parse(dates[off + n - 1]) - Date.parse(dates[off])) / 86400000;
    const years = Math.max(days / 365.25, 1e-9);
    return { navEnd: v, total: v - 1, mdd, cagr: Math.pow(v, 1 / years) - 1 };
  }

  /**
   * 레버리지 격자 스윕 — 적립식·일시불 동시. dca_sim.sweep 미러.
   * famRet 은 이미 [lo,hi] 로 슬라이스된 기초 일간수익, rf/fx 는 마스터 축 전체.
   */
  function sweep(dates, famRet, rf, fx, lo, hi, lGrid, opts) {
    opts = opts || {};
    const monthly = opts.monthly || 1, fee = opts.fee || 0;
    const useFx = opts.useFx !== false;
    const rfSeg = new Float64Array(famRet.length);
    for (let i = 0; i < famRet.length; i++) rfSeg[i] = rf[lo + i] || 0;
    const buy = monthFirstIndices(dates, lo, hi);
    const out = { L: [], dca_final: [], dca_xirr: [], dca_mdd: [], dca_multiple: [], dca_under_days: [], lump_cagr: [], lump_mdd: [], lump_final: [] };
    for (const L of lGrid) {
      const r = leverReturns(famRet, rfSeg, L, { dpy: opts.dpy || DPY, expense: opts.expense, spread: opts.spread });
      const sim = simulate(r, fx, buy, monthly, { fee, offset: lo, useFx });
      const m = dcaMetrics(dates, sim);
      const lm = lumpMetrics(r, dates, lo);
      out.L.push(L);
      out.dca_final.push(m ? m.final : null);
      out.dca_xirr.push(m ? m.xirr : null);
      out.dca_mdd.push(m ? m.mdd : null);
      out.dca_multiple.push(m ? m.multiple : null);
      out.dca_under_days.push(m ? m.underDays : null);
      out.lump_cagr.push(lm.cagr); out.lump_mdd.push(lm.mdd); out.lump_final.push(lm.navEnd);
    }
    return out;
  }

  /** 스윕에서 적립식 최종평가액 최대 L / 적립식 XIRR 최대 L / 일시불 CAGR 최대 L. */
  function optimal(sw) {
    const am = vals => {
      let bi = -1, bv = -Infinity;
      for (let i = 0; i < vals.length; i++) if (vals[i] != null && isFinite(vals[i]) && vals[i] > bv) { bv = vals[i]; bi = i; }
      return bi;
    };
    const pick = (i) => i < 0 ? null : {
      L: sw.L[i], dca_mdd: sw.dca_mdd[i], dca_under_days: sw.dca_under_days[i], lump_mdd: sw.lump_mdd[i],
    };
    const res = {};
    const f = am(sw.dca_final), x = am(sw.dca_xirr), c = am(sw.lump_cagr);
    if (f >= 0) res.dca_final = Object.assign(pick(f), { value: sw.dca_final[f] });
    if (x >= 0) res.dca_xirr = Object.assign(pick(x), { value: sw.dca_xirr[x] });
    if (c >= 0) res.lump_cagr = Object.assign(pick(c), { value: sw.lump_cagr[c] });
    return res;
  }

  /** 표시용 다운샘플 인덱스(차트 점 수 제한). leverage.js 와 동일. */
  function downsampleIdx(n, maxPts) {
    if (n <= maxPts) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }
    const step = (n - 1) / (maxPts - 1), a = [];
    for (let k = 0; k < maxPts; k++) a.push(Math.round(k * step));
    a[a.length - 1] = n - 1;
    return a;
  }

  /** 롤링 N년 적립 결과 분포 — "언제 시작했느냐"의 민감도. 시작 월을 1개월씩 밀며 반복. */
  function rollingStarts(dates, ret, fx, lo, hi, years, monthly, opts) {
    opts = opts || {};
    const fee = opts.fee || 0, useFx = opts.useFx !== false;
    const starts = monthFirstIndices(dates, lo, hi);
    const winDays = Math.round(years * 365.25);
    const out = [];
    for (const s of starts) {
      const endMs = Date.parse(dates[s]) + winDays * 86400000;
      let e = s;
      while (e + 1 <= hi && Date.parse(dates[e + 1]) <= endMs) e++;
      if (e - s < 200) continue;                       // 창이 못 차면 제외(끝부분)
      const seg = ret.subarray(s - lo, e - lo + 1);
      const buy = monthFirstIndices(dates, s, e);
      const sim = simulate(seg, fx, buy, monthly, { fee, offset: s, useFx });
      const m = dcaMetrics(dates, sim);
      if (m && isFinite(m.multiple)) out.push({ start: dates[s], end: dates[e], multiple: m.multiple, xirr: m.xirr, mdd: m.mdd, underDays: m.underDays });
    }
    return out;
  }

  const API = { DPY, CLIP, sliceRange, monthFirstIndices, leverReturns, assetReturns, simulate, xirr, dcaMetrics, lumpMetrics, sweep, optimal, downsampleIdx, rollingStarts };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.DCASIM = API;
})(typeof window !== 'undefined' ? window : globalThis);
