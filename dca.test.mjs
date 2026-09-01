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
  for (const k of ['dca_final', 'dca_xirr', 'dca_mdd', 'dca_multiple', 'lump_cagr', 'lump_mdd']) {
    const got = sw[k], exp = s.sweep[k];
    if (got.length !== exp.length) { console.error(`✗ ${s.name}.${k}: 길이 불일치`); fails++; continue; }
    for (let i = 0; i < exp.length; i++) checkNum(`${s.name}.${k}[L=${exp.length ? sw.L[i] : i}]`, got[i], exp[i], 1e-7);
  }
  for (let i = 0; i < s.sweep.dca_under_days.length; i++) {
    if (sw.dca_under_days[i] !== s.sweep.dca_under_days[i]) {
      console.error(`✗ ${s.name}.dca_under_days[L=${sw.L[i]}]: ${sw.dca_under_days[i]} ≠ ${s.sweep.dca_under_days[i]}`); fails++;
    }
  }
  const o = DCA.optimal(sw), E = s.optimal;
  for (const k of ['dca_final', 'dca_xirr', 'lump_cagr']) {
    if (!E[k]) continue;
    if (!o[k]) { console.error(`✗ ${s.name}.optimal.${k}: JS null`); fails++; continue; }
    if (Math.abs(o[k].L - E[k].L) > 1e-9) { console.error(`✗ ${s.name}.optimal.${k}.L: ${o[k].L} ≠ ${E[k].L}`); fails++; }
  }
  if (!fails) console.log(`✓ ${s.name}  적립식최적 L=${o.dca_final.L} · 일시불최적 L=${o.lump_cagr.L}`);
}

if (fails) {
  console.error(`\n✗ 패리티 실패 ${fails}건 (최대 상대오차 ${maxRel.toExponential(3)}) — Python dca_sim.py 와 web/dca.js 가 어긋났습니다.`);
  process.exit(1);
}
console.log(`\n✓ 적립식 패리티 통과 — ${fix.cases.length}개 케이스 + ${fix.sweeps.length}개 스윕, 최대 상대오차 ${maxRel.toExponential(3)} (허용 ${TOL_REL.toExponential(0)})`);
