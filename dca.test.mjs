/* web/dca.test.mjs — 적립식(DCA) 시뮬레이터 JS 엔진 패리티 테스트.
 *
 * tests/fixtures/dca_parity.json(Python src/strategies/us/dca_sim.py 기대값)을 읽어 web/dca.js 가
 * 동일한 평가액 경로·지표·레버리지 스윕을 재현하는지 검증. 실패 시 exit 1(배포 차단).
 * 실행: node web/dca.test.mjs   (픽스처는 먼저 python scripts/us/export_dca_parity.py 로 생성)
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const DCA = require('./dca.js');
const here = dirname(fileURLToPath(import.meta.url));
const fixPath = join(here, '..', 'tests', 'fixtures', 'dca_parity.json');

let fix;
try {
  fix = JSON.parse(readFileSync(fixPath, 'utf-8'));
} catch (e) {
  console.error(`픽스처 없음: ${fixPath}\n  먼저 실행: python scripts/us/export_dca_parity.py`);
  process.exit(2);
}

const d = fix.payload;
const dates = d.dates;
const lo = 0, hi = dates.length - 1;
const fxOne = new Float64Array(dates.length).fill(1);
const byKey = Object.fromEntries(d.assets.map(a => [a.key, a]));

// 상대오차 허용치 — 평가액은 금액이 커서(수억) 절대오차 대신 상대오차로 본다.
// Python round(...,6) 저장 + JS 배정도 누적 → 1e-9 이면 충분히 빡빡하다.
const TOL_REL = 1e-9;
// 픽스처가 round(x,6) 으로 저장돼 값마다 최대 5e-7 의 직렬화 오차를 이미 안고 있다.
// 금액이 큰 시계열은 분모가 커서 묻히지만, 현금풀처럼 0 근처까지 내려가는 계열은
// 아래 분모 바닥(1) 때문에 그 반올림 노이즈가 그대로 상대오차로 올라온다 —
// 관측 자체가 불가능한 구간이므로 metric 에서 덜어낸다. 실제 로직 어긋남은
// 최소 1e-3 규모라 이 차감으로 가려지지 않는다.
const TOL_ABS = 1e-6;
let fails = 0, maxRel = 0;

function relErr(got, exp) {
  const den = Math.max(Math.abs(exp), 1);
  const diff = Math.max(0, Math.abs(got - exp) - TOL_ABS);
  return diff / den;
}
function checkArr(name, got, exp) {
  if (got.length !== exp.length) { console.error(`✗ ${name}: 길이 ${got.length} ≠ ${exp.length}`); fails++; return; }
  let worst = 0, wi = -1;
  for (let i = 0; i < exp.length; i++) {
    const e = relErr(got[i], exp[i]);
    if (e > worst) { worst = e; wi = i; }
  }
  if (worst > maxRel) maxRel = worst;
  if (worst > TOL_REL) {
    console.error(`✗ ${name}: 최대 상대오차 ${worst.toExponential(3)} @${wi} (${dates[wi]}) got=${got[wi]} exp=${exp[wi]}`);
    fails++;
  }
}
function checkNum(name, got, exp, tol) {
  tol = tol == null ? TOL_REL : tol;
  if (exp == null || !isFinite(exp)) { if (got != null && isFinite(got)) { console.error(`✗ ${name}: exp=null got=${got}`); fails++; } return; }
  const e = relErr(got, exp);
  if (e > maxRel) maxRel = e;
  if (e > tol) { console.error(`✗ ${name}: got=${got} exp=${exp} (상대오차 ${e.toExponential(3)})`); fails++; }
}

// ── 케이스별 평가액 경로 + 지표 ───────────────────────────────────────────────
for (const c of fix.cases) {
  const a = byKey[c.asset];
  if (!a) { console.error(`✗ ${c.name}: 픽스처에 자산 ${c.asset} 없음`); fails++; continue; }
  const ar = DCA.assetReturns(d, a, lo, hi, 'mixed');
  const buy = DCA.monthFirstIndices(dates, lo, hi);
  const useFx = c.currency === 'krw';
  const sim = DCA.simulate(ar.ret, useFx ? d.fx : fxOne, buy, c.monthly,
    { fee: fix.fee, offset: lo, useFx });
  checkArr(`${c.name} equity`, sim.equity, c.equity);
  checkArr(`${c.name} cost`, sim.cost, c.cost);
  const m = DCA.dcaMetrics(dates, sim);
  if (!m) { console.error(`✗ ${c.name}: JS 지표 null`); fails++; continue; }
  const E = c.metrics;
  checkNum(`${c.name} final`, m.final, E.final);
  checkNum(`${c.name} totalCost`, m.totalCost, E.total_cost);
  checkNum(`${c.name} multiple`, m.multiple, E.multiple);
  checkNum(`${c.name} xirr`, m.xirr, E.xirr, 1e-7);      // 이분법 200회 → 1e-13 수준이나 여유
  checkNum(`${c.name} mdd`, m.mdd, E.mdd);
  checkNum(`${c.name} maxLoss`, m.maxLoss, E.max_loss);
  checkNum(`${c.name} avgCost`, m.avgCost, E.avg_cost);
  checkNum(`${c.name} cheapness`, m.cheapness, E.cheapness, 1e-8);
  checkNum(`${c.name} last5yShare`, m.last5yShare, E.last5y_share, 1e-8);
  if (m.underDays !== E.under_days) { console.error(`✗ ${c.name} underDays: ${m.underDays} ≠ ${E.under_days}`); fails++; }
  if (m.months !== E.months) { console.error(`✗ ${c.name} months: ${m.months} ≠ ${E.months}`); fails++; }

  // 거치식(같은 총액을 첫 매수일에 한 번에) — 화면의 적립식↔거치식 비교가 쓰는 경로
  if (c.lump_equity) {
    const lsim = DCA.lumpSum(ar.ret, useFx ? d.fx : fxOne, buy, c.monthly, { fee: fix.fee, offset: lo, useFx });
    checkArr(`${c.name} lump equity`, lsim.equity, c.lump_equity);
    const lm = DCA.dcaMetrics(dates, lsim), LE = c.lump_metrics;
    if (!lm) { console.error(`✗ ${c.name}: JS 거치식 지표 null`); fails++; continue; }
    checkNum(`${c.name} lump final`, lm.final, LE.final);
    checkNum(`${c.name} lump totalCost`, lm.totalCost, LE.total_cost);
    checkNum(`${c.name} lump multiple`, lm.multiple, LE.multiple);
    checkNum(`${c.name} lump xirr`, lm.xirr, LE.xirr, 1e-7);
    checkNum(`${c.name} lump mdd`, lm.mdd, LE.mdd);
    checkNum(`${c.name} lump maxLoss`, lm.maxLoss, LE.max_loss);
    if (lm.underDays !== LE.under_days) { console.error(`✗ ${c.name} lump underDays: ${lm.underDays} ≠ ${LE.under_days}`); fails++; }
    const cp = DCA.compareDcaLump(m, lm), CE = c.compare || {};
    checkNum(`${c.name} cmp finalRatio`, cp.finalRatio, CE.final_ratio);
    checkNum(`${c.name} cmp finalGap`, cp.finalGap, CE.final_gap);
    checkNum(`${c.name} cmp xirrGap`, cp.xirrGap, CE.xirr_gap, 1e-7);
    if (cp.dcaWins !== CE.dca_wins) { console.error(`✗ ${c.name} cmp dcaWins: ${cp.dcaWins} ≠ ${CE.dca_wins}`); fails++; }
    if (cp.underGap !== CE.under_gap) { console.error(`✗ ${c.name} cmp underGap: ${cp.underGap} ≠ ${CE.under_gap}`); fails++; }

    // 현금 모드(미투입 현금 이자) — 적립통화별 금리. 화면 기본값이라 어긋나면 헤드라인이 갈린다.
    if (c.cash_equity) {
      const rfCash = useFx ? d.rf_krw : d.rf;
      const gs = DCA.cashGlide(ar.ret, useFx ? d.fx : fxOne, buy, c.monthly, rfCash,
        { fee: fix.fee, offset: lo, useFx, dpy: d.dpy });
      checkArr(`${c.name} cash equity`, gs.equity, c.cash_equity);
      const gm = DCA.dcaMetrics(dates, gs), GE = c.cash_metrics;
      if (!gm) { console.error(`✗ ${c.name}: JS 현금모드 지표 null`); fails++; continue; }
      checkNum(`${c.name} cash final`, gm.final, GE.final);
      checkNum(`${c.name} cash totalCost`, gm.totalCost, GE.total_cost);
      checkNum(`${c.name} cash xirr`, gm.xirr, GE.xirr, 1e-7);
      checkNum(`${c.name} cash mdd`, gm.mdd, GE.mdd);
      if (gm.underDays !== GE.under_days) { console.error(`✗ ${c.name} cash underDays: ${gm.underDays} ≠ ${GE.under_days}`); fails++; }
      if (gm.months !== 1) { console.error(`✗ ${c.name} cash months: ${gm.months} ≠ 1 (현금흐름 1건이어야 한다)`); fails++; }
      const gcp = DCA.compareDcaLump(gm, lm), GCE = c.cash_compare || {};
      checkNum(`${c.name} cash cmp finalRatio`, gcp.finalRatio, GCE.final_ratio);
      if (gcp.dcaWins !== GCE.dca_wins) { console.error(`✗ ${c.name} cash cmp dcaWins: ${gcp.dcaWins} ≠ ${GCE.dca_wins}`); fails++; }
    }

    // 실질 고정 모드(화면 **기본값**) — 납입액이 물가에 연동된다. 여기가 어긋나면 첫 화면 숫자가 갈린다.
    if (c.real_equity) {
      const cpi = useFx ? d.cpi_krw : d.cpi_usd;
      if (!cpi || !cpi.length) { console.error(`✗ ${c.name}: 픽스처에 CPI 배열 없음`); fails++; }
      else {
        const rs = DCA.simulate(ar.ret, useFx ? d.fx : fxOne, buy, c.monthly,
          { fee: fix.fee, offset: lo, useFx, scale: cpi });
        checkArr(`${c.name} real equity`, rs.equity, c.real_equity);
        checkArr(`${c.name} real cost`, rs.cost, c.real_cost);
        const rm = DCA.dcaMetrics(dates, rs), RE = c.real_metrics;
        if (!rm) { console.error(`✗ ${c.name}: JS 실질모드 지표 null`); fails++; continue; }
        checkNum(`${c.name} real final`, rm.final, RE.final);
        checkNum(`${c.name} real totalCost`, rm.totalCost, RE.total_cost);
        checkNum(`${c.name} real realCost`, rm.realCost, RE.real_cost);
        checkNum(`${c.name} real firstAmt`, rm.firstAmt, RE.first_amt);
        checkNum(`${c.name} real lastAmt`, rm.lastAmt, RE.last_amt);
        checkNum(`${c.name} real multiple`, rm.multiple, RE.multiple);
        checkNum(`${c.name} real xirr`, rm.xirr, RE.xirr, 1e-7);
        checkNum(`${c.name} real mdd`, rm.mdd, RE.mdd);
        checkNum(`${c.name} real maxLoss`, rm.maxLoss, RE.max_loss);
        if (rm.underDays !== RE.under_days) { console.error(`✗ ${c.name} real underDays: ${rm.underDays} ≠ ${RE.under_days}`); fails++; }
        // 계약: 첫 달 납입액 = 입력액(첫 매수일 재기준화), 시작시점 실질 합계 = 거치식 투입액
        checkNum(`${c.name} real firstAmt==monthly`, rm.firstAmt, c.monthly, 1e-12);
        checkNum(`${c.name} real realCost==lump totalCost`, rm.realCost, lm.totalCost, 1e-12);
        const rcp = DCA.compareDcaLump(rm, lm), RCE = c.real_compare || {};
        checkNum(`${c.name} real cmp finalRatio`, rcp.finalRatio, RCE.final_ratio);
        if (rcp.dcaWins !== RCE.dca_wins) { console.error(`✗ ${c.name} real cmp dcaWins: ${rcp.dcaWins} ≠ ${RCE.dca_wins}`); fails++; }
        // 거치식이 실질 모드에 오염되지 않았는지(lumpSum 이 scale 을 벗기는지) 직접 확인
        const lchk = DCA.lumpSum(ar.ret, useFx ? d.fx : fxOne, buy, c.monthly,
          { fee: fix.fee, offset: lo, useFx, scale: cpi });
        checkNum(`${c.name} lump ignores scale`, lchk.equity[lchk.equity.length - 1], lm.final, 1e-12);
      }
    }
    if (!fails) console.log(`✓ ${c.name}  적립식=${m.final.toExponential(6)} XIRR=${(m.xirr * 100).toFixed(4)}% MDD=${(m.mdd * 100).toFixed(2)}%` +
      ` | 거치식=${lm.final.toExponential(6)} CAGR=${(lm.xirr * 100).toFixed(4)}% → 적립식/거치식=${cp.finalRatio.toFixed(4)}`);
    continue;
  }
  if (!fails) console.log(`✓ ${c.name}  최종=${m.final.toExponential(6)} XIRR=${(m.xirr * 100).toFixed(4)}% MDD=${(m.mdd * 100).toFixed(2)}%`);
}

// ── 레버리지 스윕 ─────────────────────────────────────────────────────────────
for (const s of fix.sweeps) {
  const fam = d.families[s.family];
  if (!fam) { console.error(`✗ ${s.name}: family 없음`); fails++; continue; }
  const st = fam.start_idx, n = fam.ret.length;
  const famRet = Float64Array.from(fam.ret);
  const useFx = s.currency === 'krw';
  const sw = DCA.sweep(dates, famRet, d.rf, useFx ? d.fx : fxOne, st, st + n - 1, d.l_grid,
    { monthly: s.monthly, fee: fix.fee, expense: fam.expense, spread: fam.spread, dpy: d.dpy, useFx });
  for (const k of ['dca_final', 'dca_xirr', 'dca_mdd', 'dca_multiple', 'lump_cagr', 'lump_mdd',
                   'lump_final_amt', 'lump_xirr', 'lump_mdd_amt', 'dca_calmar']) {
    if (!s.sweep[k]) continue;                       // 구 픽스처 호환
    const got = sw[k], exp = s.sweep[k];
    if (got.length !== exp.length) { console.error(`✗ ${s.name}.${k}: 길이 불일치`); fails++; continue; }
    for (let i = 0; i < exp.length; i++) checkNum(`${s.name}.${k}[L=${exp.length ? sw.L[i] : i}]`, got[i], exp[i], 1e-7);
  }
  for (const k of ['dca_under_days', 'lump_under_days']) {
    if (!s.sweep[k]) continue;                       // 구 픽스처 호환
    for (let i = 0; i < s.sweep[k].length; i++) {
      if (sw[k][i] !== s.sweep[k][i]) {
        console.error(`✗ ${s.name}.${k}[L=${sw.L[i]}]: ${sw[k][i]} ≠ ${s.sweep[k][i]}`); fails++;
      }
    }
  }
  const o = DCA.optimal(sw), E = s.optimal;
  for (const k of ['dca_final', 'dca_xirr', 'dca_calmar', 'lump_cagr']) {
    if (!E[k]) continue;
    if (!o[k]) { console.error(`✗ ${s.name}.optimal.${k}: JS null`); fails++; continue; }
    if (Math.abs(o[k].L - E[k].L) > 1e-9) { console.error(`✗ ${s.name}.optimal.${k}.L: ${o[k].L} ≠ ${E[k].L}`); fails++; }
  }
  // 제약 최적(견딜 수 있는 낙폭 안에서의 최적 배수)
  for (const [key, EC] of Object.entries(s.constrained || {})) {
    const g = DCA.constrainedOptimal(sw, parseFloat(key));
    if (!!g.feasible !== !!EC.feasible) { console.error(`✗ ${s.name}.constrained[${key}].feasible: ${g.feasible} ≠ ${EC.feasible}`); fails++; continue; }
    if (!EC.feasible) continue;
    if (Math.abs(g.L - EC.L) > 1e-9) { console.error(`✗ ${s.name}.constrained[${key}].L: ${g.L} ≠ ${EC.L}`); fails++; }
    checkNum(`${s.name}.constrained[${key}].value`, g.value, EC.value, 1e-7);
    checkNum(`${s.name}.constrained[${key}].mdd`, g.dca_mdd, EC.dca_mdd);
  }
  // 현금 모드 스윕(적립식이 미투입 현금 이자를 받는 회계)
  if (s.sweep_cash) {
    const useFxC = s.currency === 'krw';
    const swc = DCA.sweep(dates, famRet, d.rf, useFxC ? d.fx : fxOne, st, st + n - 1, d.l_grid,
      { monthly: s.monthly, fee: fix.fee, expense: fam.expense, spread: fam.spread, dpy: d.dpy,
        useFx: useFxC, rfCash: useFxC ? d.rf_krw : d.rf });
    for (const k of ['dca_final', 'dca_xirr', 'dca_mdd', 'dca_calmar']) {
      const got = swc[k], exp = s.sweep_cash[k];
      if (!exp) continue;
      for (let i = 0; i < exp.length; i++) checkNum(`${s.name}.cash.${k}[L=${swc.L[i]}]`, got[i], exp[i], 1e-7);
    }
    const oc = DCA.optimal(swc), EOC = s.optimal_cash || {};
    for (const k of ['dca_final', 'dca_xirr']) {
      if (!EOC[k] || !oc[k]) continue;
      if (Math.abs(oc[k].L - EOC[k].L) > 1e-9) { console.error(`✗ ${s.name}.optimal_cash.${k}.L: ${oc[k].L} ≠ ${EOC[k].L}`); fails++; }
    }
  }
  // 실질 고정 스윕 — 화면 기본 기준이라 최적 L 이 어긋나면 헤드라인 배수가 갈린다.
  if (s.sweep_real) {
    const useFxR = s.currency === 'krw';
    const cpi = useFxR ? d.cpi_krw : d.cpi_usd;
    const swr = DCA.sweep(dates, famRet, d.rf, useFxR ? d.fx : fxOne, st, st + n - 1, d.l_grid,
      { monthly: s.monthly, fee: fix.fee, expense: fam.expense, spread: fam.spread, dpy: d.dpy,
        useFx: useFxR, scale: cpi });
    for (const k of ['dca_final', 'dca_xirr', 'dca_mdd', 'dca_calmar', 'lump_final_amt']) {
      const got = swr[k], exp = s.sweep_real[k];
      if (!exp) continue;
      for (let i = 0; i < exp.length; i++) checkNum(`${s.name}.real.${k}[L=${swr.L[i]}]`, got[i], exp[i], 1e-7);
    }
    const oR = DCA.optimal(swr), EOR = s.optimal_real || {};
    for (const k of ['dca_final', 'dca_xirr', 'dca_calmar']) {
      if (!EOR[k] || !oR[k]) continue;
      if (Math.abs(oR[k].L - EOR[k].L) > 1e-9) { console.error(`✗ ${s.name}.optimal_real.${k}.L: ${oR[k].L} ≠ ${EOR[k].L}`); fails++; }
    }
    // 거치식은 비교 기준과 무관하게 동일해야 한다(lumpSum 이 scale 을 벗긴다)
    for (let i = 0; i < sw.lump_final_amt.length; i++) {
      checkNum(`${s.name}.real lump unchanged[L=${sw.L[i]}]`, swr.lump_final_amt[i], sw.lump_final_amt[i], 1e-12);
    }
  }
  if (!fails) console.log(`✓ ${s.name}  적립식최적 L=${o.dca_final.L} · 거치식최적 L=${o.lump_cagr.L}`);
}

// ── 시작 시점 민감도(롤링 창 + 요약) ─────────────────────────────────────────
for (const rc of (fix.rolls || [])) {
  const a = byKey[rc.asset];
  if (!a) { console.error(`✗ ${rc.name}: 자산 ${rc.asset} 없음`); fails++; continue; }
  const ar = DCA.assetReturns(d, a, lo, hi, 'mixed');
  const useFx = rc.currency === 'krw';
  const basis = rc.basis || (rc.cash ? 'cash' : 'nominal');    // 구 픽스처 호환
  const rows = DCA.rollingStarts(dates, ar.ret, useFx ? d.fx : fxOne, lo, hi, rc.years, 1,
    { fee: fix.fee, useFx, step: rc.step, dpy: d.dpy,
      rfCash: basis === 'cash' ? (useFx ? d.rf_krw : d.rf) : null,
      scale: basis === 'real' ? (useFx ? d.cpi_krw : d.cpi_usd) : null });
  const exp = rc.rows;
  if (rows.length !== exp.length) {
    console.error(`✗ ${rc.name}: 창 수 ${rows.length} ≠ ${exp.length}`); fails++; continue;
  }
  for (let i = 0; i < exp.length; i++) {
    const g = rows[i], E = exp[i];
    if (g.start !== E.start || g.end !== E.end) {
      console.error(`✗ ${rc.name}[${i}]: 창 ${g.start}~${g.end} ≠ ${E.start}~${E.end}`); fails++; continue;
    }
    checkNum(`${rc.name}[${i}] multiple`, g.multiple, E.multiple);
    checkNum(`${rc.name}[${i}] xirr`, g.xirr, E.xirr, 1e-7);
    checkNum(`${rc.name}[${i}] finalRatio`, g.finalRatio, E.final_ratio);
    checkNum(`${rc.name}[${i}] lumpXirr`, g.lumpXirr, E.lump_xirr, 1e-7);
    checkNum(`${rc.name}[${i}] firstYear`, g.firstYear, E.first_year);
    if (g.dcaWins !== E.dca_wins) { console.error(`✗ ${rc.name}[${i}] dcaWins: ${g.dcaWins} ≠ ${E.dca_wins}`); fails++; }
    if (g.underDays !== E.under_days) { console.error(`✗ ${rc.name}[${i}] underDays: ${g.underDays} ≠ ${E.under_days}`); fails++; }
  }
  const s = DCA.sensitivitySummary(rows, rc.current_ratio), E = rc.summary;
  if (!s) { console.error(`✗ ${rc.name}: JS 요약 null`); fails++; continue; }
  if (s.n !== E.n || s.wins !== E.wins) { console.error(`✗ ${rc.name} 표본: n=${s.n}/${E.n} wins=${s.wins}/${E.wins}`); fails++; }
  checkNum(`${rc.name} winRate`, s.winRate, E.win_rate);
  for (const [k, ek] of [['ratioP10', 'ratio_p10'], ['ratioP50', 'ratio_p50'], ['ratioP90', 'ratio_p90'],
                         ['ratioMin', 'ratio_min'], ['ratioMax', 'ratio_max'],
                         ['currentPct', 'current_pct'], ['negFirstYearShare', 'neg_first_year_share'],
                         ['corrFirstYear', 'corr_first_year']]) {
    checkNum(`${rc.name} ${k}`, s[k], E[ek], 1e-8);
  }
  if (!fails) console.log(`✓ ${rc.name}  표본=${s.n} 승률=${(s.winRate * 100).toFixed(1)}% ` +
    `성과비 p50=${s.ratioP50.toFixed(4)} 현재백분위=${(s.currentPct * 100).toFixed(1)}%`);
}

// ── 🧪 VIX 연동 적립(현금풀) — 3파전이 JS 에서도 같은 숫자를 내는가 ──────────
const vixPresets = Object.fromEntries((fix.vix_presets || []).map(p => [p.key, p]));
for (const vc of (fix.vix_cases || [])) {
  const a = byKey[vc.asset];
  if (!a) { console.error(`✗ ${vc.name}: 자산 ${vc.asset} 없음`); fails++; continue; }
  const p = vixPresets[vc.preset];
  if (!p) { console.error(`✗ ${vc.name}: 프리셋 ${vc.preset} 없음`); fails++; continue; }
  const ar = DCA.assetReturns(d, a, lo, hi, 'mixed');
  const useFx = vc.currency === 'krw';
  const mult = DCA.vixMultiplier(d.vix, {
    mode: p.mode, edges: p.edges, mults: p.mults,
    lag: fix.vix_lag, minObs: fix.vix_min_obs,
  });
  checkArr(`${vc.name} mult`, mult, vc.mult);
  const buy = DCA.monthFirstIndices(dates, lo, hi);
  // 총액 기준(예산/납입액) · 물가 기준(실질/명목) 토글을 픽스처가 지정한 대로 태운다.
  const scale = vc.price === 'real' ? (useFx ? d.cpi_krw : d.cpi_usd) : null;
  if (vc.price === 'real' && !(scale && scale.length)) {
    console.error(`✗ ${vc.name}: CPI 없음(실질 케이스인데 페이로드에 물가지수가 없다)`); fails++; continue;
  }
  // opts 는 한 번만 만들어 compareFundingModes·leaveOneEpisodeOut 이 **같은 것**을 쓰게 한다 —
  // 한쪽에만 scale/budget 을 빠뜨리면 JS 가 조용히 다른 모드를 돌아 패리티가 거짓으로 갈린다.
  const vopt = { fee: fix.fee, useFx, offset: lo, dpy: d.dpy, seedMonths: vc.seed_months,
                 scale, basis: vc.basis, budget: vc.basis === 'budget' };
  const cmp = DCA.compareFundingModes(dates, ar.ret, useFx ? d.fx : fxOne, buy, vc.monthly,
    mult, useFx ? d.rf_krw : d.rf, vopt);
  checkArr(`${vc.name} equity`, cmp.sims.vix.equity, vc.equity);
  checkArr(`${vc.name} cost`, cmp.sims.vix.cost, vc.cost);
  checkArr(`${vc.name} cash`, cmp.sims.vix.cash, vc.cash);
  const legs = [['vix', vc.metrics], ['fixed', vc.fixed_metrics], ['lump', vc.lump_metrics]];
  if (vc.tilt_metrics) legs.push(['tilt', vc.tilt_metrics]);   // flex 전용 — 시간기울기 대조군
  for (const [leg, exp] of legs) {
    checkNum(`${vc.name}.${leg} final`, cmp[leg].final, exp.final);
    checkNum(`${vc.name}.${leg} totalCost`, cmp[leg].totalCost, exp.total_cost);
    checkNum(`${vc.name}.${leg} xirr`, cmp[leg].xirr, exp.xirr, 1e-7);
    checkNum(`${vc.name}.${leg} mdd`, cmp[leg].mdd, exp.mdd);
    checkNum(`${vc.name}.${leg} avgCost`, cmp[leg].avgCost, exp.avg_cost);
    if (cmp[leg].underDays !== exp.under_days) {
      console.error(`✗ ${vc.name}.${leg} underDays: ${cmp[leg].underDays} ≠ ${exp.under_days}`); fails++;
    }
  }
  // 총 유입이 세 방식에서 같아야 한다 — 이게 깨지면 '같은 총액 비교'라는 전제가 무너진다.
  // 단 **실질 고정 모드**에서는 명목 총액이 다른 게 정상이라 실질 총액으로 본다:
  //   · 거치식 — 첫 매수일에 '그 시절 가치로 환산한 총액'을 한 번에 넣는다(lump_simulate docstring).
  //   · flex  — 매달 넣는 **실질** 금액이 달라서 각 납입에 곱해지는 물가배수도 달라진다. 실질 총액
  //             (= monthly × 매수횟수)은 정확히 같지만 명목 합계는 어긋나는 게 이 모드의 정의다.
  for (const leg of ['fixed', 'lump']) {
    const nominalOk = !(vc.price === 'real' && (leg === 'lump' || vc.basis === 'flex'));
    if (nominalOk) {
      checkNum(`${vc.name} totalCost 일치(${leg})`, cmp[leg].totalCost, cmp.vix.totalCost, 1e-12);
    } else {
      checkNum(`${vc.name} realCost 일치(${leg})`, cmp[leg].realCost, cmp.vix.realCost, 1e-9);
    }
  }
  checkNum(`${vc.name}.pool investRate`, cmp.pool.investRate, vc.pool.invest_rate);
  checkNum(`${vc.name}.pool leftoverCash`, cmp.pool.leftoverCash, vc.pool.leftover_cash);
  checkNum(`${vc.name}.pool multMean`, cmp.pool.multMean, vc.pool.mult_mean);
  checkNum(`${vc.name}.pool multTargetMean`, cmp.pool.multTargetMean, vc.pool.mult_target_mean);
  checkNum(`${vc.name}.pool investedReal`, cmp.pool.investedReal, vc.pool.invested_real);
  checkNum(`${vc.name}.pool budgetReal`, cmp.pool.budgetReal, vc.pool.budget_real);
  checkNum(`${vc.name}.pool fillRate`, cmp.pool.fillRate, vc.pool.fill_rate);
  checkNum(`${vc.name}.pool investedRealFixed`, cmp.pool.investedRealFixed,
    vc.pool.invested_real_fixed);
  // 예산 모드의 존재 이유 — 주식에 넣는 **실질 총액**이 세 방식에서 같아야 한다.
  // 대조군(고정 적립)은 정의상 정확히 예산을 채운다. VIX 쪽은 대기 현금이 물가에 녹으면
  // 못 채울 수 있으므로(설계상 허용 — fill_rate 가 그걸 드러낸다) '넘지 않는다'만 강제한다.
  if (vc.basis === 'budget') {
    checkNum(`${vc.name} 고정적립 예산 정확 충족`, cmp.pool.investedRealFixed,
      cmp.pool.budgetReal, 1e-9);
    if (cmp.pool.investedReal > cmp.pool.budgetReal * (1 + 1e-9)) {
      console.error(`✗ ${vc.name} 예산 초과 투자: ${cmp.pool.investedReal} > ${cmp.pool.budgetReal}`);
      fails++;
    }
  }
  if (cmp.pool.starved !== vc.pool.starved) {
    console.error(`✗ ${vc.name}.pool starved: ${cmp.pool.starved} ≠ ${vc.pool.starved}`); fails++;
  }
  checkNum(`${vc.name} vsFixed ratio`, cmp.vsFixed.finalRatio, vc.vs_fixed.final_ratio);
  checkNum(`${vc.name} vsLump ratio`, cmp.vsLump.finalRatio, vc.vs_lump.final_ratio);
  // flex 모드 — 현금을 들지 않는다는 성질과 시간기울기 대조군까지 JS 가 재현해야 한다.
  if (vc.basis === 'flex') {
    checkNum(`${vc.name}.pool maxRatio`, cmp.pool.maxRatio, vc.pool.max_ratio);
    checkNum(`${vc.name}.pool minRatio`, cmp.pool.minRatio, vc.pool.min_ratio);
    checkNum(`${vc.name}.pool dwYears`, cmp.pool.dwYears, vc.pool.dw_years, 1e-9);
    checkNum(`${vc.name}.pool dwYearsTilt`, cmp.pool.dwYearsTilt, vc.pool.dw_years_tilt, 1e-6);
    checkNum(`${vc.name} vsTilt ratio`, cmp.vsTilt.finalRatio, vc.vs_tilt.final_ratio, 1e-7);
    // 예산을 정확히 소진하고 현금을 한 푼도 들지 않는다 — 이 모드를 만든 이유 그 자체.
    checkNum(`${vc.name} flex 예산 정확 소진`, cmp.pool.investedReal, cmp.pool.budgetReal, 1e-9);
    if (cmp.pool.leftoverCash !== 0 || cmp.pool.starved !== 0) {
      console.error(`✗ ${vc.name} flex 인데 현금이 남았다: ${cmp.pool.leftoverCash} / 고갈 ${cmp.pool.starved}`);
      fails++;
    }
  }
  // 사건 탐지 + leave-one-episode-out — 과최적화 점검 표가 파이썬과 갈리면 결론이 갈린다.
  const eps = DCA.vixEpisodes(d.vix, mult);
  if (eps.length !== (vc.episodes || []).length) {
    console.error(`✗ ${vc.name} 사건 수: ${eps.length} ≠ ${(vc.episodes || []).length}`); fails++;
  } else {
    eps.forEach((e, i) => {
      const E = vc.episodes[i];
      if (e.lo !== E.lo || e.hi !== E.hi) {
        console.error(`✗ ${vc.name} 사건[${i}] 범위: ${e.lo}~${e.hi} ≠ ${E.lo}~${E.hi}`); fails++;
      }
      checkNum(`${vc.name} 사건[${i}] peakVix`, e.peakVix, E.peak_vix);
    });
    const loo = DCA.leaveOneEpisodeOut(dates, ar.ret, useFx ? d.fx : fxOne, buy, vc.monthly,
      mult, useFx ? d.rf_krw : d.rf, eps, vopt);
    loo.forEach((r, i) => {
      checkNum(`${vc.name} loo[${i}] ratioWithout`, r.ratioWithout, vc.loo[i].ratio_without);
      checkNum(`${vc.name} loo[${i}] share`, r.share, vc.loo[i].share, 1e-8);
      if (vc.basis === 'flex') {
        checkNum(`${vc.name} loo[${i}] ratioWithoutTilt`, r.ratioWithoutTilt,
          vc.loo[i].ratio_without_tilt, 1e-7);
      }
    });
  }
  // 화면의 새 패널 2개 — 구간별 이후 수익률 · 임계×배수 격자.
  if (vc.buckets) {
    const bk = DCA.signalBucketForward(d.vix, ar.ret, buy, {
      offset: lo, dpy: d.dpy, lag: fix.vix_lag, edges: fix.bucket_edges, horizons: fix.bucket_horizons });
    if (bk.length !== vc.buckets.length) {
      console.error(`✗ ${vc.name} buckets 행 수: ${bk.length} ≠ ${vc.buckets.length}`); fails++;
    } else {
      bk.forEach((x, i) => {
        const E = vc.buckets[i];
        if (x.label !== E.label || x.n !== E.n || x.nEpisodes !== E.n_episodes) {
          console.error(`✗ ${vc.name} buckets[${i}]: ${x.label}/${x.n}/${x.nEpisodes} ` +
            `≠ ${E.label}/${E.n}/${E.n_episodes}`); fails++;
        }
        fix.bucket_horizons.forEach(h => {
          checkNum(`${vc.name} buckets[${i}].${h}y median`, x.fwd[h].median, E.fwd[h].median);
          checkNum(`${vc.name} buckets[${i}].${h}y worst`, x.fwd[h].worst, E.fwd[h].worst);
        });
      });
    }
  }
  if (vc.grid) {
    const gr = DCA.thresholdGrid(ar.ret, useFx ? d.fx : fxOne, buy, vc.monthly, d.vix,
      Object.assign({}, vopt, { lag: fix.vix_lag, thresholds: fix.grid_thresholds, mults: fix.grid_mults }));
    checkNum(`${vc.name} grid fixedFinal`, gr.fixedFinal, vc.grid.fixed_final);
    if (gr.rows.length !== vc.grid.rows.length) {
      console.error(`✗ ${vc.name} grid 칸 수: ${gr.rows.length} ≠ ${vc.grid.rows.length}`); fails++;
    } else {
      gr.rows.forEach((x, i) => {
        const E = vc.grid.rows[i];
        if (x.threshold !== E.threshold || x.mult !== E.mult || x.nHigh !== E.n_high) {
          console.error(`✗ ${vc.name} grid[${i}] 키: ${x.threshold}/${x.mult}/${x.nHigh} ` +
            `≠ ${E.threshold}/${E.mult}/${E.n_high}`); fails++;
        }
        checkNum(`${vc.name} grid[${i}] vsFixed`, x.vsFixed, E.vs_fixed, 1e-9);
        checkNum(`${vc.name} grid[${i}] vsTilt`, x.vsTilt, E.vs_tilt, 1e-7);
        checkNum(`${vc.name} grid[${i}] maxRatio`, x.maxRatio, E.max_ratio);
      });
    }
  }
  // 배수 ≡ 1(off) 이면 (현금풀이든 flex 든) 단순 적립과 완전히 같아야 한다(파이썬 불변식의 JS 판).
  if (vc.preset === 'off') {
    const plain = DCA.simulate(ar.ret, useFx ? d.fx : fxOne, buy, vc.monthly,
      { fee: fix.fee, useFx, offset: lo, scale });
    checkArr(`${vc.name} off ≡ simulate`, cmp.sims.vix.equity, Array.from(plain.equity));
  }
  if (!fails) console.log(`✓ ${vc.name}  평균배수=${cmp.pool.multMean.toFixed(2)} ` +
    (vc.basis === 'flex'
      ? `월납입=${cmp.pool.minRatio.toFixed(2)}~${cmp.pool.maxRatio.toFixed(2)}배 `
      : `투입률=${(cmp.pool.investRate * 100).toFixed(0)}% 달성률=${(cmp.pool.fillRate * 100).toFixed(1)}% `) +
    `| VIX/고정=${cmp.vsFixed.finalRatio.toFixed(3)} ` +
    `VIX/거치=${cmp.vsLump.finalRatio.toFixed(3)}` +
    (vc.basis === 'flex' ? ` VIX/시간대조군=${cmp.vsTilt.finalRatio.toFixed(3)}` : ''));
}

const nReal = (fix.cases || []).filter(c => c.real_equity).length
  + (fix.sweeps || []).filter(s => s.sweep_real).length
  + (fix.rolls || []).filter(r => (r.basis || '') === 'real').length;
if (!fails) console.log(`
  · 실질 고정(물가 연동) 검증 ${nReal}건 — 케이스·스윕·롤링 전 경로`);

if (fails) {
  console.error(`\n✗ 패리티 실패 ${fails}건 (최대 상대오차 ${maxRel.toExponential(3)}) — Python dca_sim.py 와 web/dca.js 가 어긋났습니다.`);
  process.exit(1);
}
console.log(`\n✓ 적립식 패리티 통과 — ${fix.cases.length}개 케이스 + ${fix.sweeps.length}개 스윕 + ` +
  `${(fix.rolls || []).length}개 롤링(시작 시점 민감도), 최대 상대오차 ${maxRel.toExponential(3)} (허용 ${TOL_REL.toExponential(0)})`);
