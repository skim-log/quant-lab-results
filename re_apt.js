/* web/re_apt.js — 단지(개별 아파트) 백테스트 JS 엔진 (브라우저 계산).
 *
 * Python 미러: denseSeries ↔ src/data/re/apt.py::smooth_ffill,
 *              netNav     ↔ src/strategies/re/buyhold.py::net_nav.
 * 패리티: web/re_apt.test.mjs 가 픽스처(scripts/re/export_apt_parity.py)와
 * 최대오차 <1e-9 검증(배포 전 필수). 엔진 드리프트 방지.
 *
 * 핵심 규약(Python 일치):
 *  - 평활은 trailing(과거만) smooth개월 평균 — 거래월 값에만 적용.
 *  - 갭은 직전 거래월 평활값 ffill(전월가 유지 — 인과적). 선형보간 금지(룩어헤드).
 *  - 첫 거래월 이전·마지막 거래월 이후는 null(시리즈를 만들어내지 않음).
 *  - NAV: rets=pct_change, 매월 (1-hold/12) drag, 첫 전이에서 (1-entry) 일회 차감.
 */
'use strict';
(function (root) {
  /** sparse {mi:[월인덱스], px:[중위가]} → 길이 nMonths dense 배열(null 포함).
   *  opts: {smooth=3}. apt.smooth_ffill 미러. */
  function denseSeries(sparse, nMonths, opts) {
    const smooth = (opts && opts.smooth) || 3;
    const dense = new Array(nMonths).fill(null);
    for (let k = 0; k < sparse.mi.length; k++) {
      const i = sparse.mi[k];
      if (i >= 0 && i < nMonths) dense[i] = sparse.px[k];
    }
    const out = new Array(nMonths).fill(null);
    let first = -1, last = -1;
    for (let i = 0; i < nMonths; i++) {
      if (dense[i] == null) continue;
      if (first < 0) first = i;
      last = i;
      let s = 0, c = 0;                                  // trailing 창 — 거래월에서만 평활
      for (let j = Math.max(0, i - smooth + 1); j <= i; j++) {
        if (dense[j] != null) { s += dense[j]; c++; }
      }
      out[i] = s / c;
    }
    if (first < 0) return out;                           // 거래 없음 → 전부 null
    for (let i = first + 1; i <= last; i++) {            // 내부 갭 ffill
      if (out[i] == null) out[i] = out[i - 1];
    }
    return out;
  }

  /** levels: 유효 구간 숫자 배열(null 없음 — 호출자가 first~last 로 슬라이스).
   *  costs: {entry, holdingAnnual, exitCost}. 시작=1.0 NAV. buyhold.net_nav 미러. */
  function netNav(levels, costs) {
    const n = levels.length;
    if (n < 2) return new Array(n).fill(1.0);
    const entry = costs.entry || 0, holdM = (costs.holdingAnnual || 0) / 12;
    const exit = costs.exitCost || 0;
    const nav = [1.0];
    for (let i = 1; i < n; i++) {
      const r = levels[i] / levels[i - 1] - 1;           // pandas pct_change 와 동일 연산순서
      let step = (1 + r) * (1 - holdM);
      if (i === 1 && entry) step *= (1 - entry);         // 취득비용 일회(최초 전이)
      nav.push(nav[nav.length - 1] * step);
    }
    if (exit) nav[nav.length - 1] *= (1 - exit);
    return nav;
  }

  /** 갭투자 자기자본 NAV — src/strategies/re/gap.py::gap_equity_nav 미러.
   *  levels: 유효 구간 매매가 배열(슬라이스됨), ratio0: 초기 전세가율(0<ratio0<1) → 레버리지 1/(1-ratio0).
   *  순자산 = 집값비율 − 초기전세가율 − 누적보유세, 자기자본 기준 정규화. 시작=1.0. */
  function gapEquityNav(levels, ratio0, costs) {
    const n = levels.length;
    if (n < 2 || !(ratio0 > 0 && ratio0 < 1)) return new Array(n).fill(1.0);
    const e0 = 1 - ratio0, holdM = (costs.holdingAnnual || 0) / 12, entry = costs.entry || 0;
    const v0 = levels[0];
    const nav = new Array(n);
    let holdCum = 0;                                  // Σ_{j=1..i} holdM·value_j (Python cumsum − value_0항)
    for (let i = 0; i < n; i++) {
      const value = levels[i] / v0;
      if (i > 0) holdCum += holdM * value;
      nav[i] = (value - ratio0 - holdCum) / e0;       // 순자산 / 자기자본
    }
    nav[0] = 1.0;
    if (entry) for (let i = 1; i < n; i++) nav[i] *= (1 - entry / e0);   // 취득비용 일회(자기자본 대비)
    return nav;
  }

  /** 백테스트 가드 — 번들 밴드의 sale {mi,n} 로 재계산(메시지용; Python bt 플래그가 1차 진실).
   *  cfg: {min_tx, min_months, min_span, max_gap}, fromMi(선택): 사용자 시작월 이후만 평가. */
  function guards(band, cfg, fromMi) {
    const mi = [], n = [];
    for (let k = 0; k < band.sale.mi.length; k++) {
      if (fromMi == null || band.sale.mi[k] >= fromMi) { mi.push(band.sale.mi[k]); n.push(band.sale.n[k]); }
    }
    const tx = n.reduce((a, b) => a + b, 0);
    if (tx < cfg.min_tx) return { ok: false, reason: `매매 ${tx}건 < ${cfg.min_tx}건` };
    if (mi.length < cfg.min_months) return { ok: false, reason: `거래발생 ${mi.length}개월 < ${cfg.min_months}개월` };
    const span = mi[mi.length - 1] - mi[0] + 1;
    if (span < cfg.min_span) return { ok: false, reason: `기간 ${span}개월 < ${cfg.min_span}개월` };
    let gap = 0;
    for (let k = 1; k < mi.length; k++) gap = Math.max(gap, mi[k] - mi[k - 1] - 1);
    if (gap > cfg.max_gap) return { ok: false, reason: `최장 무거래 ${gap}개월 > ${cfg.max_gap}개월` };
    return { ok: true, reason: '' };
  }

  /** dense 배열의 유효 구간 [first, last] (없으면 null). */
  function validRange(dense) {
    let first = -1, last = -1;
    for (let i = 0; i < dense.length; i++) {
      if (dense[i] != null) { if (first < 0) first = i; last = i; }
    }
    return first < 0 ? null : { first, last };
  }

  const API = { denseSeries, netNav, gapEquityNav, guards, validRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;   // node(패리티 테스트)
  root.RE_APT = API;                                                           // 브라우저 전역
})(typeof window !== 'undefined' ? window : globalThis);
