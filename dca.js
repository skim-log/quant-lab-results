/* web/dca.js — 적립식(DCA) 시뮬레이터 클라이언트 계산 엔진.
 *
 * Python src/strategies/us/dca_sim.py 미러(패리티 테스트 web/dca.test.mjs 가 강제).
 * dca.json 에 임베드된 마스터 날짜축 + family 일간수익 + 실제 ETF 일간수익 + 금리 + 환율에서
 * 임의의 월적립금·기간·종목·레버리지로 평가액·XIRR·낙폭·L 스윕을 브라우저에서 즉석 재계산한다.
 *
 * 레버리지 일간수익:  r_L = L·u − (L−1)·rf/dpy − expense/dpy − L·spread/dpy   (하한 −0.99 클립)
 * 적립식:            매월 첫 거래일에 monthly(적립통화) 납입 → 그날 환율로 USD 환전 → 수수료 차감 후 매수
 * 거치식(일시불):     같은 총액(monthly × 매수횟수)을 첫 매수일에 한 번에 → 같은 규약으로 보유(lumpSum)
 *
 * 비교 기준 3택(화면 토글과 1:1, dca_sim.py 헤더와 같은 규약):
 *   ① 명목 고정  simulate()                 매달 같은 명목 금액 — 순수 '시점 효과'
 *   ② 실질 고정  simulate({scale: CPI}) 기본  매달 같은 구매력(A_t = monthly × CPI_t / CPI_첫매수일).
 *                                           거치식 투입액은 monthly × 매수횟수 로 불변 → 같은 구매력 비교.
 *   ③ 현금 이자  cashGlide()                미투입분을 단기금리로 굴린다(적립식이 주식+예금 배분이 된다)
 *   ②와 ③은 상호배타 — lumpSum·cashGlide 는 scale 을 명시적으로 벗긴다.
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
   *
   * opts.scale — **물가지수 배열(마스터 축 전체**, fx·rfCash 와 같은 규약). 주면 납입액이 명목
   * 고정이 아니라 **실질 고정**이 된다: A_t = monthly × scale[t] / scale[첫 매수일].
   * 재기준화(÷ 첫 매수일 값)를 **이 함수 안에서** 하는 것이 dca_sim.simulate 와의 계약이다 —
   * rollingStarts 는 창마다 시작이 다른데, 호출부가 각자 재기준화하면 파이썬과 어긋난다.
   * null 이면 기존 명목 고정 동작과 완전히 동일하다.
   */
  function simulate(ret, fx, buyIdx, monthly, opts) {
    opts = opts || {};
    const fee = opts.fee || 0, offset = opts.offset || 0, useFx = opts.useFx !== false;
    const scale = opts.scale || null;
    const n = ret.length;
    const nav = new Float64Array(n);
    let v = 1.0;
    for (let i = 0; i < n; i++) { v *= (1 + ret[i]); nav[i] = v; }
    const buy = new Uint8Array(n);
    // 축 밖 매수일은 버린다 — 파이썬 simulate 도 같은 규약(0 <= i < n)으로 거른다.
    let firstBuy = -1;
    for (const b of buyIdx) {
      const j = b - offset;
      if (j >= 0 && j < n) { buy[j] = 1; if (firstBuy < 0 || j < firstBuy) firstBuy = j; }
    }
    // 재기준화 기준값 = **첫 매수일**의 물가지수. 0/결측이면 명목 고정으로 안전 퇴각.
    let base = 1;
    if (scale && firstBuy >= 0) {
      const v0 = scale[offset + firstBuy];
      base = (v0 > 0) ? v0 : 1;
    }

    const equity = new Float64Array(n), cost = new Float64Array(n), costReal = new Float64Array(n);
    let units = 0, paid = 0, spentUsd = 0, nBuys = 0;
    const flows = [];            // [마스터인덱스, 금액(음수)]
    const buyPrices = [];
    for (let i = 0; i < n; i++) {
      const f = useFx ? (fx[offset + i] || 0) : 1;
      if (buy[i]) {
        // 적립통화 기준 납입액 — 실질 고정이면 물가만큼 증액된 **명목** 금액
        const amt = scale ? monthly * (scale[offset + i] / base) : monthly;
        const amtUsd = f ? amt / f : 0;
        units += amtUsd * (1 - fee) / nav[i];
        spentUsd += amtUsd;
        paid += amt;
        nBuys++;
        flows.push([offset + i, -amt]);
        buyPrices.push(nav[i]);
      }
      equity[i] = units * nav[i] * f;
      cost[i] = paid;
      // 각 납입의 시작시점 가치는 정의상 정확히 monthly → 부동소수 오차 없이 monthly × 횟수.
      costReal[i] = monthly * nBuys;
    }
    const avgCost = units > 1e-15 ? spentUsd / units : NaN;
    return { equity, cost, costReal, nav, units, flows, avgCost, buyPrices, offset };
  }

  /**
   * 거치식(일시불) — 적립식과 **같은 총액을 첫 매수일에 한 번에** 넣고 끝까지 보유.
   * dca_sim.lump_simulate 미러. simulate 를 그대로 재사용하므로(매수 1회·금액=총액)
   * 수수료·환전·가격 프록시 규약이 적립식과 완전히 같다 — 차이는 '언제 넣었는가'뿐.
   * 반환 형태가 simulate 와 같아 dcaMetrics 를 그대로 태울 수 있다.
   */
  function lumpSum(ret, fx, buyIdx, monthly, opts) {
    // 실질 모드에서도 거치식 투입액은 monthly × 매수횟수 로 **불변**이다(= 적립 흐름을 첫 매수일
    // 가치로 환산한 합, simulate 의 costReal 마지막 값). scale 을 명시적으로 벗겨 규약을 못박는다
    // — 넘겨도 첫 매수일 배수는 1.0 이라 결과는 같지만, 미러 드리프트를 원천 차단한다.
    const o = Object.assign({}, opts || {}, { scale: null });
    if (!buyIdx || !buyIdx.length) return simulate(ret, fx, [], 0, o);
    // opts.total 을 주면 monthly × 매수횟수 대신 그 금액을 첫날 넣는다 — 현금풀(poolSimulate)의
    // 시드 때문에 총 유입이 늘어난 경우에도 '같은 총액' 비교를 유지하기 위해서다.
    const amt = (o.total != null) ? o.total : monthly * buyIdx.length;
    return simulate(ret, fx, [buyIdx[0]], amt, o);
  }

  // ── VIX 연동 적립 — 배수 스케줄 ────────────────────────────────────────────
  /**
   * 확장창 백분위 순위 — p[i] = #{j < i : v[j] < v[i]} / i. 앞부분(minObs 미달)은 NaN.
   * dca_sim.expanding_pct_rank 미러(펜윅 트리 O(n log n), 동률은 세지 않는다).
   *
   * 고정 임계(VIX 20·30)가 아니라 이걸 정본으로 두는 이유: "VIX 30이면 공포"라는 감각은 VIX 의
   * 장기 분포를 **지나고 나서** 알기 때문에 생긴 것이라 그 자체가 룩어헤드다. 확장창 백분위는
   * 그 시점까지 관측된 VIX 만 쓴다.
   */
  function expandingPctRank(v, minObs) {
    minObs = (minObs == null) ? 252 : minObs;
    const n = v.length;
    const out = new Float64Array(n).fill(NaN);
    if (!n) return out;
    // rank compression — np.unique + searchsorted(side='left') 미러.
    const sorted = Array.from(v).sort((a, b) => a - b);
    const uniq = [];
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) uniq.push(sorted[i]);
    const k = uniq.length;
    const lowerBound = x => {            // 첫 uniq[m] >= x 의 위치
      let lo = 0, hi = k;
      while (lo < hi) { const m = (lo + hi) >> 1; if (uniq[m] < x) lo = m + 1; else hi = m; }
      return lo;
    };
    const tree = new Int32Array(k + 1);
    const add = i => { for (; i <= k; i += i & (-i)) tree[i]++; };
    const sum = i => { let s = 0; for (; i > 0; i -= i & (-i)) s += tree[i]; return s; };
    for (let i = 0; i < n; i++) {
      const code = lowerBound(v[i]) + 1;
      if (i >= minObs) out[i] = sum(code - 1) / i;
      add(code);
    }
    return out;
  }

  /**
   * VIX → 그날 매수 배수 배열(입력과 같은 길이, 마스터 축). dca_sim.vix_multiplier 미러.
   *
   * opts.mode  'pct'(확장창 백분위, 정본) | 'level'(고정 임계, 대조군) | 'off'(전부 1.0)
   * opts.edges 구간 경계, opts.mults 배수(길이 = edges+1). **경계값은 위 버킷**(searchsorted right).
   * opts.lag   기본 1 = **전일 종가**로 정한다. 매수는 그날 종가 체결이라 당일 VIX 를 쓰면
   *            장 마감을 미리 아는 셈이 된다. lag=1 은 실제로 가능한 행동이다.
   * VIX 가 0(관측 없음)인 구간·lag 로 음수 인덱스가 되는 앞부분·백분위 minObs 미달 구간은
   * 전부 배수 1.0 — 데이터가 없으면 조용히 고정 적립으로 퇴각한다(신호를 지어내지 않는다).
   */
  function vixMultiplier(vix, opts) {
    opts = opts || {};
    const n = vix ? vix.length : 0;
    const m = new Float64Array(n).fill(1);
    if (!n || opts.mode === 'off' || !opts.mode) return m;
    const edges = opts.edges || [], mults = opts.mults || [1];
    const lag = (opts.lag == null) ? 1 : opts.lag;
    if (mults.length !== edges.length + 1) throw new Error('mults 는 edges 보다 하나 많아야 한다');
    const sig = new Float64Array(n).fill(NaN);
    if (opts.mode === 'pct') {
      const idx = [];
      for (let i = 0; i < n; i++) if (vix[i] > 0) idx.push(i);
      if (!idx.length) return m;
      const obs = new Float64Array(idx.length);
      for (let i = 0; i < idx.length; i++) obs[i] = vix[idx[i]];
      const p = expandingPctRank(obs, opts.minObs);
      for (let i = 0; i < idx.length; i++) sig[idx[i]] = p[i];
    } else {
      for (let i = 0; i < n; i++) if (vix[i] > 0) sig[i] = vix[i];
    }
    for (let i = 0; i < n; i++) {
      const j = i - lag;
      if (j < 0) continue;
      const s = sig[j];
      if (!isFinite(s)) continue;
      let b = 0;                                 // searchsorted(edges, s, side='right')
      while (b < edges.length && edges[b] <= s) b++;
      m[i] = mults[b];
    }
    return m;
  }

  /**
   * 현금풀 적립 — 매달 같은 금액이 풀로 들어오고 `monthly × 배수` 만큼 꺼내 산다.
   * dca_sim.pool_simulate 미러. **총 유입을 늘리지 않고** "공포에 더 사기"를 구현하는 장치다
   * (그냥 곱하면 돈을 더 넣은 것이라 최종 평가액을 나란히 놓을 수 없다).
   *
   * 하루 순서: ① 매수일이면 monthly 유입(+첫 매수일엔 시드) ② want = monthly×배수, 실제 투입은
   * min(want, 잔고) — **풀은 마이너스가 될 수 없다** ③ 매수 ④ 그날 말 잔액에 하루치 이자
   * ⑤ 총 부 = 주식 평가액 + 남은 현금.
   * cost/flows 는 **지갑에서 나간 금액**(유입)이지 주식에 들어간 금액이 아니다 — 그래야 XIRR 이
   * 고정 적립·거치식과 같은 축에 놓인다.
   *
   * mult/rfCash 는 **마스터 축 전체** 배열(fx 와 같은 규약). mult 가 null 이면 전 구간 1.0 이고
   * 그 결과는 simulate() 와 완전히 같다(풀 잔고가 항상 0).
   */
  function poolSimulate(ret, fx, buyIdx, monthly, mult, rfCash, opts) {
    opts = opts || {};
    const fee = opts.fee || 0, off = opts.offset || 0, useFx = opts.useFx !== false;
    const dpy = opts.dpy || DPY, seedMonths = opts.seedMonths || 0;
    const scale = opts.scale || null, budget = !!opts.budget;
    const n = ret.length;
    const nav = new Float64Array(n);
    let v = 1.0;
    for (let i = 0; i < n; i++) { v *= (1 + ret[i]); nav[i] = v; }
    const isBuy = new Uint8Array(n);
    // 매수 순번(몇 번째 매수인가)을 미리 매긴다 — 예산 모드가 '남은 횟수'를 알아야 한다.
    const rank = new Int32Array(n).fill(-1);
    const sorted = [];
    for (const b of buyIdx) {
      const j = b - off;
      if (j >= 0 && j < n) { isBuy[j] = 1; sorted.push(j); }
    }
    sorted.sort((a, b) => a - b);
    for (let k = 0; k < sorted.length; k++) rank[sorted[k]] = k;
    const nBuysTotal = sorted.length;
    const first = nBuysTotal ? sorted[0] : -1;
    // 물가 재기준화 — 첫 매수일이 1.0. 0/결측이면 명목으로 안전 퇴각(simulate 와 같은 규약).
    let sbase = 1;
    if (scale && first >= 0) {
      const v0 = scale[off + first];
      sbase = (v0 > 0) ? v0 : 1;
    }
    const sAt = (i) => {
      if (!scale) return 1;
      const x = scale[off + i];
      return (x > 0) ? x / sbase : 1;
    };
    const seed = monthly * seedMonths;
    // 주식 예산(실질) — 예산 모드에서만 의미가 있다. 시드는 예산이 아니라 초기 탄약이다.
    const budgetReal = monthly * nBuysTotal;
    const equity = new Float64Array(n), cost = new Float64Array(n), cashPath = new Float64Array(n);
    const costReal = new Float64Array(n);
    const flows = [], buyPrices = [], buyAmts = [], buyScales = [];
    let units = 0, cash = 0, inflow = 0, invested = 0, investedReal = 0, spentUsd = 0, starved = 0;
    let multTargetSum = 0, nBuys = 0, seedReal = 0;
    for (let i = 0; i < n; i++) {
      const f = useFx ? (fx[off + i] || 0) : 1;
      if (isBuy[i]) {
        const si = sAt(i);
        buyScales.push(si);
        nBuys++;
        if (i === first) seedReal = seed;   // 시드는 첫 매수일 투입이라 실질 가치 = 명목 그대로
        const add = monthly * si + (i === first ? seed : 0);
        cash += add; inflow += add;
        flows.push([off + i, -add]);
        const m = mult ? (mult[off + i] == null ? 1 : mult[off + i]) : 1;
        multTargetSum += m;
        let want;
        if (budget) {
          const left = nBuysTotal - rank[i];        // 이번 것 포함 남은 매수 횟수
          let rem = budgetReal - investedReal;
          if (rem < 0) rem = 0;
          want = (left <= 1) ? rem * si             // 마지막 — 배수 무시하고 소진
                             : (rem / left) * si * m;
        } else {
          want = monthly * si * m;
        }
        const amt = (want <= cash) ? want : cash;
        if (want > cash + 1e-12) starved++;
        if (amt > 0) {
          cash -= amt; invested += amt; investedReal += amt / si;
          const amtUsd = f ? amt / f : 0;
          units += amtUsd * (1 - fee) / nav[i];
          spentUsd += amtUsd;
          buyPrices.push(nav[i]);
        }
        buyAmts.push(amt);
      }
      const rr = rfCash ? (rfCash[off + i] || 0) : 0;
      cash *= 1 + rr / dpy;
      cashPath[i] = cash;
      equity[i] = units * nav[i] * f + cash;
      cost[i] = inflow;
      // 실질 납입원금 — 각 유입(monthly × 물가배수)의 첫 매수일 가치는 정의상 정확히 monthly 다.
      costReal[i] = monthly * nBuys + seedReal;
    }
    return {
      equity, cost, costReal, nav, units, flows, buyPrices, offset: off,
      avgCost: units > 1e-15 ? spentUsd / units : NaN,
      cash: cashPath, buyAmts, invested, starved,
      investRate: inflow ? invested / inflow : NaN,
      leftoverCash: n ? cashPath[n - 1] : 0,
      totalInflow: inflow,
      investedReal, budgetReal, buyScales,
      fillRate: budgetReal ? investedReal / budgetReal : NaN,
      // 실제 실현 배수 — 물가를 걷어낸 기준액(monthly × 그날 물가배수) 대비 실제 투입.
      multMean: (buyAmts.length && monthly)
        ? buyAmts.reduce((s2, a, k) => s2 + a / (monthly * buyScales[k]), 0) / buyAmts.length : NaN,
      // 규칙이 지시한 배수의 평균 — 실현치와의 간격이 곧 '고갈로 못 산 몫'이다.
      multTargetMean: buyAmts.length ? multTargetSum / buyAmts.length : NaN,
    };
  }

  /**
   * **같은 총액** 위의 3파전 — VIX 연동 현금풀 / 단순 고정 적립 / 거치식.
   * dca_sim.compare_funding_modes 미러. 세 방식의 총 유입이 `monthly × 매수횟수 + 시드` 로
   * 정확히 같아 최종 평가액을 그대로 나란히 놓을 수 있다. 다만 거치식은 그 돈을 t=0 에 이미
   * 갖고 있어야 하므로 **t=0 부(富)가 다르다** — 화면이 그 차이를 문구로 밝혀야 한다.
   * fixed 를 simulate 가 아니라 poolSimulate(null) 로 도는 건 회계 규약을 한 글자도 안 어긋나게
   * 하기 위해서다(두 결과가 같다는 건 파이썬 테스트가 강제한다).
   */
  function idleCashPath(n, rfCash, cash0, first, off, dpy) {
    // dca_sim._idle_cash_path 미러 — 예산 모드에서 거치식이 시드를 '투자하지 않고 이자만' 받게 한다.
    const out = new Float64Array(n);
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (i === first) c += cash0;
      const rr = rfCash ? (rfCash[off + i] || 0) : 0;
      c *= 1 + rr / dpy;
      out[i] = c;
    }
    return out;
  }

  function compareFundingModes(dates, ret, fx, buyIdx, monthly, mult, rfCash, opts) {
    opts = opts || {};
    const buy = Array.from(buyIdx).map(Number).sort((a, b) => a - b);
    const off = opts.offset || 0, dpy = opts.dpy || DPY, budget = !!opts.budget;
    const seedCash = monthly * (opts.seedMonths || 0);
    // 거치식이 첫날 넣는 주식 금액 — 예산 모드면 시드를 빼고 그 시드는 현금으로 들고 있는다.
    const total = monthly * buy.length + (budget ? 0 : seedCash);
    const vixSim = poolSimulate(ret, fx, buy, monthly, mult, rfCash, opts);
    const fixSim = poolSimulate(ret, fx, buy, monthly, null, rfCash, opts);
    let lmpSim = lumpSum(ret, fx, buy, monthly, Object.assign({}, opts, { total }));
    const n = ret.length;
    let firstJ = -1;
    for (const b of buy) { const j = b - off; if (j >= 0 && j < n && (firstJ < 0 || j < firstJ)) firstJ = j; }
    if (budget && seedCash > 0 && firstJ >= 0) {
      const idle = idleCashPath(n, rfCash, seedCash, firstJ, off, dpy);
      const eq = new Float64Array(n), ct = new Float64Array(n), cr = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const step = i >= firstJ ? seedCash : 0;
        eq[i] = lmpSim.equity[i] + idle[i];
        ct[i] = lmpSim.cost[i] + step;
        cr[i] = lmpSim.costReal[i] + step;
      }
      lmpSim = Object.assign({}, lmpSim, {
        equity: eq, cost: ct, costReal: cr,
        flows: lmpSim.flows.concat([[off + firstJ, -seedCash]]),
      });
    }
    const vm = dcaMetrics(dates, vixSim), fm = dcaMetrics(dates, fixSim), lm = dcaMetrics(dates, lmpSim);
    const multMean = vixSim.multMean;
    return {
      vix: vm, fixed: fm, lump: lm,
      pool: {
        investRate: vixSim.investRate, starved: vixSim.starved,
        leftoverCash: vixSim.leftoverCash, invested: vixSim.invested,
        totalInflow: vixSim.totalInflow, multMean,
        multTargetMean: vixSim.multTargetMean,
        investedReal: vixSim.investedReal, budgetReal: vixSim.budgetReal,
        fillRate: vixSim.fillRate, investedFixed: fixSim.invested,
        investedRealFixed: fixSim.investedReal, budget,
      },
      vsFixed: compareDcaLump(vm, fm), vsLump: compareDcaLump(vm, lm),
      sims: { vix: vixSim, fixed: fixSim, lump: lmpSim },
    };
  }

  /**
   * **미투입 현금에 이자를 주는** 적립식 — 거치식과 t=0 부를 같게 맞춘 공정 비교판.
   * dca_sim.cash_glide 미러. simulate() 는 안 넣은 돈을 장롱 현금(이자 0)으로 두는데, 거치식은
   * t=0 에 전액을 넣으므로 그대로 비교하면 적립식만 수십 년의 현금 이자를 잃는 편향이 생긴다.
   *
   * 규약: t=0 에 총액을 적립통화 현금으로 보유 → 매수일마다 monthly 를 꺼내 매수 →
   *       **그날 말** 잔액에 하루치 이자. 현금은 환전이 없다(적립통화로 놀기 때문).
   * 반환 형태가 simulate 와 같아 dcaMetrics 를 그대로 태울 수 있고, 현금흐름이 t=0 1건이라
   * 이 모드에서는 적립식도 **거치식과 완전히 같은 축**에 놓인다(XIRR = CAGR).
   *
   * rfCash 는 **마스터 축 전체** 배열(적립통화 기준 연율). null 이면 이자 0(회계는 동일).
   */
  function cashGlide(ret, fx, buyIdx, monthly, rfCash, opts) {
    // 실질 고정(scale)과 상호배타 — 둘 다 t=0 기준을 건드려 섞으면 '총 투자원금'의 정의가 모호해진다.
    opts = Object.assign({}, opts || {}, { scale: null });
    const sim = simulate(ret, fx, buyIdx, monthly, opts);
    const n = sim.equity.length, off = sim.offset || 0;
    const dpy = opts.dpy || DPY;
    const buy = Array.from(buyIdx).map(Number).sort((a, b) => a - b);
    const total = monthly * buy.length;
    const isBuy = new Uint8Array(n);
    for (const b of buy) { const j = b - off; if (j >= 0 && j < n) isBuy[j] = 1; }
    const cashPath = new Float64Array(n), equity = new Float64Array(n), cost = new Float64Array(n);
    const costReal = new Float64Array(n);
    let cash = total;
    for (let i = 0; i < n; i++) {
      if (isBuy[i]) cash -= monthly;
      const rr = rfCash ? (rfCash[off + i] || 0) : 0;
      cash *= 1 + rr / dpy;
      cashPath[i] = cash;
      equity[i] = sim.equity[i] + cash;
      cost[i] = total;                                  // t=0 에 이미 총액을 갖고 있었다
      costReal[i] = total;                              // 명목=실질(물가 연동을 쓰지 않는 모드)
    }
    return Object.assign({}, sim, {
      equity, cost, costReal, cash: cashPath,
      flows: buy.length ? [[buy[0], -total]] : [],
    });
  }

  /**
   * 배수가 **최고 버킷**에 들어간 구간 = '공포 사건'. dca_sim.vix_episodes 미러.
   * 이 실험의 진짜 한계는 데이터 시작일이 아니라 **사건의 개수**다 — VIX 최상위 구간은
   * 1990~현재를 다 써도 1998·2001-02·2008-09·2011·2020·2022 정도에 뭉쳐 있어, 수천 거래일처럼
   * 보여도 독립 관측은 사실상 그 사건 수다. gap 거래일 이내로 떨어진 구간은 한 사건으로 잇는다.
   */
  function vixEpisodes(vix, mult, opts) {
    opts = opts || {};
    const gap = opts.gap == null ? 60 : opts.gap, minDays = opts.minDays == null ? 3 : opts.minDays;
    const n = mult ? mult.length : 0;
    if (!n) return [];
    let top = -Infinity;
    for (let i = 0; i < n; i++) if (mult[i] > top) top = mult[i];
    if (!(top > 1)) return [];
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (mult[i] < top - 1e-12) continue;
      if (runs.length && i - runs[runs.length - 1][1] <= gap) runs[runs.length - 1][1] = i;
      else runs.push([i, i]);
    }
    const out = [];
    for (const [lo, hi] of runs) {
      if (hi - lo + 1 < minDays) continue;
      let peak = NaN;
      for (let i = lo; i <= hi; i++) if (vix[i] > 0 && !(vix[i] <= peak)) peak = vix[i];
      out.push({ lo, hi, days: hi - lo + 1, peakVix: peak });
    }
    return out;
  }

  /**
   * 사건을 **하나씩 빼고**(그 구간만 배수 1.0) 다시 돌려 성과비가 얼마나 남는지.
   * dca_sim.leave_one_episode_out 미러. 성과비 1.05 가 2008 을 빼면 1.00 이 된다면 그 전략의
   * 근거는 "고VIX 에 더 사기"가 아니라 **2008 한 번**이다 — 화면은 이 표를 숨기지 않는다.
   */
  function leaveOneEpisodeOut(dates, ret, fx, buyIdx, monthly, mult, rfCash, episodes, opts) {
    const base = compareFundingModes(dates, ret, fx, buyIdx, monthly, mult, rfCash, opts);
    const baseRatio = base.vsFixed.finalRatio;
    return episodes.map(ep => {
      const m2 = Float64Array.from(mult);
      for (let i = ep.lo; i <= ep.hi; i++) m2[i] = 1;
      const c = compareFundingModes(dates, ret, fx, buyIdx, monthly, m2, rfCash, opts);
      const r = c.vsFixed.finalRatio;
      return {
        lo: ep.lo, hi: ep.hi, days: ep.days, peakVix: ep.peakVix,
        start: dates[ep.lo], end: dates[ep.hi], ratioWithout: r,
        share: Math.abs(baseRatio - 1) > 1e-12 ? (baseRatio - r) / (baseRatio - 1) : NaN,
      };
    });
  }

  /** 적립식 vs 거치식 대조 요약 — dca_sim.compare_dca_lump 미러. */
  function compareDcaLump(dm, lm) {
    if (!dm || !lm) return null;
    return {
      finalRatio: lm.final ? dm.final / lm.final : NaN,
      finalGap: dm.final - lm.final,
      xirrGap: dm.xirr - lm.xirr,
      mddGap: dm.mdd - lm.mdd,
      underGap: dm.underDays - lm.underDays,
      dcaWins: dm.final > lm.final,
    };
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
      // 실질 고정 모드용 — 시작시점 가치로 환산한 납입 합계(= 거치식 투입액)와 첫/마지막 달 납입액.
      realCost: sim.costReal ? sim.costReal[n - 1] : cost[n - 1],
      firstAmt: sim.flows.length ? -sim.flows[0][1] : NaN,
      lastAmt: sim.flows.length ? -sim.flows[sim.flows.length - 1][1] : NaN,
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
    const out = { L: [], dca_final: [], dca_xirr: [], dca_mdd: [], dca_multiple: [], dca_under_days: [], lump_cagr: [], lump_mdd: [], lump_final: [], lump_final_amt: [], lump_xirr: [], lump_mdd_amt: [], lump_under_days: [], dca_calmar: [] };
    // opts.rfCash 를 주면 적립식이 '미투입 현금에 이자를 받는' 회계로 바뀐다(거치식과 t=0 부 동일).
    // 그때 dca_* 는 주식 계좌가 아니라 **총 부** 기준이 된다.
    const rfCash = opts.rfCash || null;
    // opts.scale(물가지수, 마스터 축)을 주면 적립식이 '실질 고정'이 된다. rfCash 와 상호배타.
    const scale = opts.scale || null;
    for (const L of lGrid) {
      const r = leverReturns(famRet, rfSeg, L, { dpy: opts.dpy || DPY, expense: opts.expense, spread: opts.spread });
      const simOpt = { fee, offset: lo, useFx, dpy: opts.dpy || DPY, scale };
      const sim = rfCash ? cashGlide(r, fx, buy, monthly, rfCash, simOpt)
        : simulate(r, fx, buy, monthly, simOpt);
      const m = dcaMetrics(dates, sim);
      const lm = lumpMetrics(r, dates, lo);
      // 거치식(같은 총액을 첫 매수일에) — 적립식과 같은 축에 놓고 비교하기 위한 금액 기준선
      const lsim = lumpSum(r, fx, buy, monthly, { fee, offset: lo, useFx });
      const lmA = dcaMetrics(dates, lsim);
      out.L.push(L);
      out.dca_final.push(m ? m.final : null);
      out.dca_xirr.push(m ? m.xirr : null);
      out.dca_mdd.push(m ? m.mdd : null);
      out.dca_multiple.push(m ? m.multiple : null);
      out.dca_under_days.push(m ? m.underDays : null);
      out.lump_cagr.push(lm.cagr); out.lump_mdd.push(lm.mdd); out.lump_final.push(lm.navEnd);
      out.lump_final_amt.push(lmA ? lmA.final : null);
      out.lump_xirr.push(lmA ? lmA.xirr : null);
      out.lump_mdd_amt.push(lmA ? lmA.mdd : null);
      out.lump_under_days.push(lmA ? lmA.underDays : null);
      // 위험조정은 낙폭 기준(Calmar) — Sharpe 는 레버리지에 거의 불변이라 이 문제에 못 쓴다
      // (초과수익·변동성이 같은 배수로 늘어 비용 탓에 단조 감소만 → 최적 L≈0 이라는 무의미한 답).
      out.dca_calmar.push(m && isFinite(m.xirr) && isFinite(m.mdd) && Math.abs(m.mdd) > 1e-9
        ? m.xirr / Math.abs(m.mdd) : null);
    }
    return out;
  }

  /**
   * **견딜 수 있는 범위**의 최적 레버리지 — |평가액 MDD| ≤ maxMdd 격자점 중 key 최대.
   * dca_sim.constrained_optimal 미러. maxMdd 는 양수 비율(0.5 = −50%까지 허용).
   * 무제약 최적은 대개 −95~−99% 낙폭을 동반하므로, 이 함수가 그 경고를 숫자로 만든다.
   */
  function constrainedOptimal(sw, maxMdd, key) {
    key = key || 'dca_final';
    const vals = sw[key], mdds = sw.dca_mdd;
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < vals.length; i++) {
      const m = mdds[i], v = vals[i];
      if (m == null || v == null || !isFinite(m) || !isFinite(v)) continue;
      if (Math.abs(m) <= maxMdd + 1e-12 && v > bv) { bv = v; bi = i; }
    }
    if (bi < 0) return { feasible: false, maxMdd };
    return {
      feasible: true, maxMdd, L: sw.L[bi], idx: bi, value: bv,
      dca_mdd: sw.dca_mdd[bi], dca_under_days: sw.dca_under_days[bi],
      dca_xirr: sw.dca_xirr[bi], dca_calmar: sw.dca_calmar ? sw.dca_calmar[bi] : null,
      lump_final_amt: sw.lump_final_amt ? sw.lump_final_amt[bi] : null,
    };
  }

  /** 스윕에서 적립식 최종평가액 최대 L / 적립식 XIRR 최대 L / 일시불 CAGR 최대 L. */
  function optimal(sw) {
    const am = vals => {
      let bi = -1, bv = -Infinity;
      for (let i = 0; i < vals.length; i++) if (vals[i] != null && isFinite(vals[i]) && vals[i] > bv) { bv = vals[i]; bi = i; }
      return bi;
    };
    const pick = (i) => i < 0 ? null : {
      L: sw.L[i], idx: i, dca_mdd: sw.dca_mdd[i], dca_under_days: sw.dca_under_days[i], lump_mdd: sw.lump_mdd[i],
      // 같은 L 의 거치식 값 — 화면이 격자를 다시 뒤지지 않고 마커를 찍을 수 있게
      lump_final_amt: sw.lump_final_amt ? sw.lump_final_amt[i] : null,
      lump_xirr: sw.lump_xirr ? sw.lump_xirr[i] : null,
    };
    const res = {};
    const f = am(sw.dca_final), x = am(sw.dca_xirr), c = am(sw.lump_cagr);
    if (f >= 0) res.dca_final = Object.assign(pick(f), { value: sw.dca_final[f] });
    if (x >= 0) res.dca_xirr = Object.assign(pick(x), { value: sw.dca_xirr[x] });
    if (c >= 0) res.lump_cagr = Object.assign(pick(c), { value: sw.lump_cagr[c] });
    if (sw.dca_calmar) {
      const k = am(sw.dca_calmar);
      if (k >= 0) res.dca_calmar = Object.assign(pick(k), { value: sw.dca_calmar[k] });
    }
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

  /**
   * 롤링 N년 적립 결과 분포 — "언제 시작했느냐"의 민감도. 시작 월을 opts.step 개월씩 밀며 반복.
   * dca_sim.rolling_starts 미러. 각 창마다 **같은 총액을 창 첫달에 한 번에** 넣은 거치식도 같이
   * 계산해 승패를 붙인다(opts.withLump !== false). 창마다 조건이 완전히 동일하므로
   * '적립식이 거치식을 이긴 비율'이 시작 시점 운을 배제한 정직한 비교가 된다.
   *
   * monthly 는 비·승률을 바꾸지 않는다(둘 다 monthly 에 선형이라 약분) → 화면은 monthly=1 로
   * 계산해 적립금 변경 시에도 캐시를 재사용한다.
   */
  function rollingStarts(dates, ret, fx, lo, hi, years, monthly, opts) {
    opts = opts || {};
    const fee = opts.fee || 0, useFx = opts.useFx !== false, withLump = opts.withLump !== false;
    const step = Math.max(1, opts.step || 1);
    // opts.rfCash(마스터 축 전체)를 주면 창마다 적립식이 미투입 현금 이자를 받는 회계로 바뀐다
    const rfCash = opts.rfCash || null;
    // opts.scale(마스터 축 전체)을 주면 창마다 '실질 고정' 적립이 된다. simulate 가 창의 첫 매수일로
    // 자동 재기준화하므로 어느 창에서든 첫 달 납입액은 정확히 monthly 다 — 창끼리 비교가 성립한다.
    const scale = opts.scale || null;
    let starts = monthFirstIndices(dates, lo, hi);
    if (step > 1) starts = starts.filter((_, i) => i % step === 0);
    const winDays = Math.round(years * 365.25);
    const out = [];
    for (const s of starts) {
      const startMs = Date.parse(dates[s]);
      const endMs = startMs + winDays * 86400000;
      // 이력이 창을 다 못 채우면 제외 — 잘린 창(예: 4년짜리)이 '10년 적립' 분포에 섞이면
      // 승률·분위수가 오염된다. 200거래일 하한도 유지.
      if (Date.parse(dates[hi]) < endMs) continue;
      let e = s;
      while (e + 1 <= hi && Date.parse(dates[e + 1]) <= endMs) e++;
      if (e - s < 200) continue;
      const seg = ret.subarray(s - lo, e - lo + 1);
      const buy = monthFirstIndices(dates, s, e);
      const simOpt = { fee, offset: s, useFx, dpy: opts.dpy || DPY, scale };
      const sim = rfCash ? cashGlide(seg, fx, buy, monthly, rfCash, simOpt)
        : simulate(seg, fx, buy, monthly, simOpt);
      const m = dcaMetrics(dates, sim);
      if (!m || !isFinite(m.multiple)) continue;
      const row = { start: dates[s], end: dates[e], multiple: m.multiple, xirr: m.xirr, mdd: m.mdd, underDays: m.underDays };
      if (withLump) {
        const lsim = lumpSum(seg, fx, buy, monthly, { fee, offset: s, useFx });
        const lm = dcaMetrics(dates, lsim);
        if (lm && isFinite(lm.multiple)) {
          // 창 시작 +365일 시점의 거치식 원금 대비 손익 — 승패의 메커니즘(초기 하락)
          const y1 = startMs + 365 * 86400000;
          let k = 0;
          while (s + k + 1 <= e && Date.parse(dates[s + k + 1]) <= y1) k++;
          const total = lsim.cost[lsim.cost.length - 1];
          row.lumpMultiple = lm.multiple; row.lumpXirr = lm.xirr; row.lumpMdd = lm.mdd;
          row.lumpUnderDays = lm.underDays; row.dcaWins = m.final > lm.final;
          row.finalRatio = lm.final ? m.final / lm.final : NaN;
          row.firstYear = total ? lsim.equity[k] / total - 1 : NaN;
        }
      }
      out.push(row);
    }
    return out;
  }

  /** rollingStarts 요약 — dca_sim.sensitivity_summary 미러(분위수는 최근접 순위). */
  function sensitivitySummary(rows, currentRatio) {
    const rs = rows.filter(r => r.finalRatio != null && isFinite(r.finalRatio));
    if (!rs.length) return null;
    const ratios = rs.map(r => r.finalRatio).sort((a, b) => a - b);
    const wins = rs.filter(r => r.dcaWins);
    const q = p => ratios[Math.min(ratios.length - 1, Math.max(0, Math.round(p * (ratios.length - 1))))];
    const fyWins = wins.filter(r => r.firstYear != null && isFinite(r.firstYear));
    const out = {
      n: rs.length, wins: wins.length, winRate: wins.length / rs.length,
      ratioP10: q(0.10), ratioP50: q(0.50), ratioP90: q(0.90),
      ratioMin: ratios[0], ratioMax: ratios[ratios.length - 1],
      negFirstYearShare: fyWins.length ? fyWins.filter(r => r.firstYear < 0).length / fyWins.length : NaN,
    };
    // 상관은 ln(비)로 — 비 자체는 소각 종목에서 수만 배까지 벌어져 선형상관이 무의미해진다.
    const pairs = rs.filter(r => r.firstYear != null && isFinite(r.firstYear) && r.finalRatio > 0)
      .map(r => [r.firstYear, Math.log(r.finalRatio)]);
    if (pairs.length >= 3) {
      const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
      const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      let cov = 0, vx = 0, vy = 0;
      for (const p of pairs) { const dx = p[0] - mx, dy = p[1] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
      const sx = Math.sqrt(vx / pairs.length), sy = Math.sqrt(vy / pairs.length);
      out.corrFirstYear = (sx > 1e-15 && sy > 1e-15) ? (cov / pairs.length) / (sx * sy) : NaN;
    }
    if (currentRatio != null && isFinite(currentRatio)) {
      out.currentPct = ratios.filter(v => v < currentRatio).length / ratios.length;
    }
    return out;
  }

  const API = { DPY, CLIP, sliceRange, monthFirstIndices, leverReturns, assetReturns, simulate, lumpSum, cashGlide, compareDcaLump, xirr, dcaMetrics, lumpMetrics, sweep, optimal, constrainedOptimal, downsampleIdx, rollingStarts, sensitivitySummary, expandingPctRank, vixMultiplier, poolSimulate, compareFundingModes, vixEpisodes, leaveOneEpisodeOut };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.DCASIM = API;
})(typeof window !== 'undefined' ? window : globalThis);
