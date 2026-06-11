/* web/alloc.js — 정적 자산배분 백테스트 JS 엔진 (브라우저 플레이그라운드).
 *
 * Python src/engines/monthly.py::run_backtest + src/strategies/multi/allocation.py 를 미러.
 * 패리티: web/alloc.test.mjs 가 Python run_allocation 결과와 NAV 최대오차 <1e-6 검증(배포 전 필수).
 *
 * 핵심 규약(Python 일치):
 *  - KRW 기준 패널(panel.json krw_prices: USD자산×FX, KR자산 원화)에서 월별 루프.
 *  - 비용 = (buys+sells)*(comm+slip) + sells*sell_tax. cash_monthly = 0(기본).
 *  - 첫 달 항상 초기 매수(periodic). 비리밸 월에 밴드 위반 시 band_target 으로 리밸.
 *  - USD = navKrw × fx0/fx (환율 역산). KRW = navKrw.
 */
'use strict';
(function (root) {
  function periodicMask(dates, mode) {
    const n = dates.length;
    const hit = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const m = parseInt(dates[i].slice(5, 7), 10);
      if (mode === 'monthly') hit[i] = true;
      else if (mode === 'quarterly') hit[i] = (m === 1 || m === 4 || m === 7 || m === 10);
      else if (mode === 'semiannual') hit[i] = (m === 1 || m === 7);
      else if (mode === 'yearly') {
        const y = parseInt(dates[i].slice(0, 4), 10);
        const yp = i > 0 ? parseInt(dates[i - 1].slice(0, 4), 10) : y - 1;
        hit[i] = y !== yp;
      }
      // 'never' → 전부 false
    }
    if (n) hit[0] = true;   // 첫 달 초기 매수
    return hit;
  }

  /** prices: {id:[KRW월봉|null]} (master 축), weights: {id:비중}.
   *  opts: {rebalance, bandRatio, costs, maSignal}.
   *  maSignal(선택): {id:[1|0|null]} — master 축 월말 200일선 신호(panel.json ma_signal).
   *    null·미제공 자산 → 1(보유)로 간주(Python 미러). maSignal 미전달 시 기존 동작과 비트 동일. */
  function runBacktest(dates, prices, ids, weights, opts) {
    const comm = opts.costs.commission_rate, slip = opts.costs.slippage_side;
    const tax = opts.costs.sell_tax || 0;
    const bandRatio = opts.bandRatio || 0, useBand = bandRatio > 0;
    const sel = ids.filter(id => (weights[id] || 0) > 0);
    if (!sel.length) return null;

    // 공통 창: 선택 자산 전부 non-null 인 달(= Python krw.dropna()).
    const win = [];
    for (let t = 0; t < dates.length; t++) {
      if (sel.every(id => prices[id] && prices[id][t] != null)) win.push(t);
    }
    if (win.length < 2) return null;
    const wd = win.map(t => dates[t]);
    let wsum = 0; sel.forEach(id => { wsum += weights[id]; });
    const w = {}; sel.forEach(id => { w[id] = weights[id] / wsum; });
    const mask = periodicMask(wd, opts.rebalance);
    const px = {}; sel.forEach(id => { px[id] = win.map(t => prices[id][t]); });

    // MA 신호: master 축 → 창 축. null·미제공 → 1(보유). (Python ma_filter 미러)
    let sig = null;
    if (opts.maSignal) {
      sig = {};
      sel.forEach(id => {
        const arr = opts.maSignal[id];
        sig[id] = win.map(t => (arr && arr[t] != null) ? arr[t] : 1);
      });
    }

    const navArr = [], events = [];
    let wPrev = {}; sel.forEach(id => { wPrev[id] = 0; });
    let cashW = 1.0, nav = 1.0;
    let lastTarget = null;                     // 마지막 적용 목표(밴드 비교·복원 기준)
    for (let k = 0; k < wd.length; k++) {
      const grown = {}; let gsum = 0;
      sel.forEach(id => {
        const r = k > 0 ? px[id][k] / px[id][k - 1] - 1 : 0;
        grown[id] = wPrev[id] * (1 + r); gsum += grown[id];
      });
      const cashGrown = cashW;                 // cash_monthly = 0
      const total = gsum + cashGrown;
      nav *= total;
      const wDrift = {}; sel.forEach(id => { wDrift[id] = total > 0 ? grown[id] / total : 0; });

      // 신호 플립(주기 미발생 달에도 새 목표행 주입) — maSignal 있을 때만.
      const flip = sig && k > 0 && sel.some(id => sig[id][k] !== sig[id][k - 1]);
      let target = null, trigger = null;
      if (mask[k] || flip) {                   // (주기 ∪ 플립) → 새 목표행
        target = {}; sel.forEach(id => { target[id] = sig ? w[id] * sig[id][k] : w[id]; });
        trigger = mask[k] ? 'periodic' : 'ma';
      } else if (useBand && k > 0 && lastTarget) {
        const breach = sel.some(id => lastTarget[id] > 0 &&
          Math.abs(wDrift[id] - lastTarget[id]) > lastTarget[id] * bandRatio);
        if (breach) { target = Object.assign({}, lastTarget); trigger = 'band'; }
      }
      if (target === null) {
        wPrev = wDrift; cashW = total > 0 ? cashGrown / total : 1;
      } else {
        let buys = 0, sells = 0;
        sel.forEach(id => { const d = target[id] - wDrift[id]; if (d > 0) buys += d; else sells += -d; });
        const cost = (buys + sells) * (comm + slip) + sells * tax;
        nav *= (1 - cost);
        wPrev = Object.assign({}, target);
        let ts = 0; sel.forEach(id => { ts += target[id]; }); cashW = 1 - ts;
        lastTarget = target;
        if (buys + sells > 1e-9) events.push({ date: wd[k].slice(0, 7), trigger, turnover: buys + sells });
      }
      navArr.push(nav);
    }
    return { dates: wd, navKrw: navArr, weights: w, selected: sel, win, events };
  }

  /** navKrw → 통화. USD = navKrw × fx0/fx. fxWin = 창 인덱스에 정렬한 USD/KRW. */
  function navToCcy(navKrw, fxWin, ccy) {
    if (ccy === 'krw') return navKrw.slice();
    const fx0 = fxWin[0];
    return navKrw.map((v, i) => v * (fx0 / fxWin[i]));
  }

  /** 벤치마크 정규화 곡선(시작 1.0). priceArr/fxArr=master 축, win=창 인덱스. */
  function benchCurve(priceArr, nativeCcy, fxArr, outCcy, win) {
    const oc = outCcy.toUpperCase();
    const cur = [];
    for (const t of win) {
      const p = priceArr[t], fx = fxArr[t];
      if (p == null) { cur.push(null); continue; }
      if (nativeCcy === oc) cur.push(p);
      else if (nativeCcy === 'USD' && oc === 'KRW') cur.push(fx == null ? null : p * fx);
      else cur.push(fx == null ? null : p / fx);
    }
    const base = cur.find(v => v != null);
    return base ? cur.map(v => v == null ? null : v / base) : cur;
  }

  const API = { periodicMask, runBacktest, navToCcy, benchCurve };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;   // node(파리티 테스트)
  root.ALLOC = API;                                                            // 브라우저 전역
})(typeof window !== 'undefined' ? window : globalThis);
