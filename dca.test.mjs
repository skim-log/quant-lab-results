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
const TOL_ABS = 1e-6;
let fails = 0, maxRel = 0;

function relErr(got, exp) {
  const den = Math.max(Math.abs(exp), 1);
  return Math.abs(got - exp) / den;
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
                   'lump_final_amt', 'lump_xirr', 'lump_mdd_amt']) {
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
  for (const k of ['dca_final', 'dca_xirr', 'lump_cagr']) {
    if (!E[k]) continue;
    if (!o[k]) { console.error(`✗ ${s.name}.optimal.${k}: JS null`); fails++; continue; }
    if (Math.abs(o[k].L - E[k].L) > 1e-9) { console.error(`✗ ${s.name}.optimal.${k}.L: ${o[k].L} ≠ ${E[k].L}`); fails++; }
  }
  if (!fails) console.log(`✓ ${s.name}  적립식최적 L=${o.dca_final.L} · 거치식최적 L=${o.lump_cagr.L}`);
}

// ── 시작 시점 민감도(롤링 창 + 요약) ─────────────────────────────────────────
for (const rc of (fix.rolls || [])) {
  const a = byKey[rc.asset];
  if (!a) { console.error(`✗ ${rc.name}: 자산 ${rc.asset} 없음`); fails++; continue; }
  const ar = DCA.assetReturns(d, a, lo, hi, 'mixed');
  const useFx = rc.currency === 'krw';
  const rows = DCA.rollingStarts(dates, ar.ret, useFx ? d.fx : fxOne, lo, hi, rc.years, 1,
    { fee: fix.fee, useFx, step: rc.step });
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

if (fails) {
  console.error(`\n✗ 패리티 실패 ${fails}건 (최대 상대오차 ${maxRel.toExponential(3)}) — Python dca_sim.py 와 web/dca.js 가 어긋났습니다.`);
  process.exit(1);
}
console.log(`\n✓ 적립식 패리티 통과 — ${fix.cases.length}개 케이스 + ${fix.sweeps.length}개 스윕 + ` +
  `${(fix.rolls || []).length}개 롤링(시작 시점 민감도), 최대 상대오차 ${maxRel.toExponential(3)} (허용 ${TOL_REL.toExponential(0)})`);
