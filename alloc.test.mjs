/* web/alloc.test.mjs — 플레이그라운드 JS 엔진 패리티 테스트.
 *
 * tests/fixtures/alloc_parity.json(Python run_allocation 기대 NAV) 을 읽어, web/alloc.js 가 동일 비중·주기·밴드로
 * KRW/USD NAV 를 최대오차 <1e-6 로 재현하는지 검증. 실패 시 exit 1(배포 차단).
 * 실행: node web/alloc.test.mjs   (픽스처는 먼저 python scripts/multi/export_parity.py 로 생성)
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const ALLOC = require('./alloc.js');
const here = dirname(fileURLToPath(import.meta.url));
const fixPath = join(here, '..', 'tests', 'fixtures', 'alloc_parity.json');

let fix;
try {
  fix = JSON.parse(readFileSync(fixPath, 'utf-8'));
} catch (e) {
  console.error(`픽스처 없음: ${fixPath}\n  먼저 실행: python scripts/multi/export_parity.py`);
  process.exit(2);
}

const panel = fix.panel;
const ids = Object.keys(panel.krw_prices);
const TOL = 1e-6;
let maxErr = 0, fails = 0;

for (const c of fix.cases) {
  if (c.ma && !panel.ma_signal) {
    console.error(`✗ ${c.name}: 픽스처에 ma_signal 없음 — export_parity.py 재실행`); fails++; continue;
  }
  const res = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, c.weights,
    { rebalance: c.rebalance, bandRatio: c.band, costs: panel.costs,
      maSignal: c.ma ? panel.ma_signal : undefined });
  if (!res) { console.error(`✗ ${c.name}: JS 엔진 null`); fails++; continue; }
  const fxWin = res.win.map(t => panel.fx[t]);
  for (const [ccy, expected] of [['krw', c.krw_nav], ['usd', c.usd_nav]]) {
    const got = ALLOC.navToCcy(res.navKrw, fxWin, ccy);
    if (got.length !== expected.length) {
      console.error(`✗ ${c.name}/${ccy}: 길이 ${got.length} != ${expected.length}`); fails++; continue;
    }
    let e = 0;
    for (let i = 0; i < got.length; i++) e = Math.max(e, Math.abs(got[i] - expected[i]));
    maxErr = Math.max(maxErr, e);
    if (e > TOL) { console.error(`✗ ${c.name}/${ccy}: 최대오차 ${e.toExponential(3)} > ${TOL}`); fails++; }
    else console.log(`  ✓ ${c.name}/${ccy}  n=${got.length}  maxErr=${e.toExponential(2)}`);
  }
}

// 후방호환 자기검증: 전부-1(상시 보유) 신호는 maSignal 미전달과 비트 동일해야 함(엔진 리팩터 무해 증명).
{
  const base = fix.cases.find(c => !c.ma) || fix.cases[0];
  const allOnes = {}; ids.forEach(id => { allOnes[id] = panel.dates.map(() => 1); });
  const r0 = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, base.weights,
    { rebalance: base.rebalance, bandRatio: base.band, costs: panel.costs });
  const r1 = ALLOC.runBacktest(panel.dates, panel.krw_prices, ids, base.weights,
    { rebalance: base.rebalance, bandRatio: base.band, costs: panel.costs, maSignal: allOnes });
  let se = 0;
  for (let i = 0; i < r0.navKrw.length; i++) se = Math.max(se, Math.abs(r0.navKrw[i] - r1.navKrw[i]));
  if (se > 0) { console.error(`✗ 자기검증(전부-1 신호 ≠ 무신호): 최대오차 ${se.toExponential(3)}`); fails++; }
  else console.log(`  ✓ 자기검증(전부-1 신호 = 무신호)  maxErr=0`);
}

console.log(`\n패리티: 전체 최대오차 ${maxErr.toExponential(3)}, 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
