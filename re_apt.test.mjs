/* web/re_apt.test.mjs — 단지 백테스트 JS 엔진 패리티 테스트.
 *
 * tests/fixtures/re_apt_parity.json(Python apt.smooth_ffill + buyhold.net_nav 기대값)을 읽어
 * web/re_apt.js 의 denseSeries(상대오차)·netNav(절대오차)가 <1e-9 로 재현하는지 검증.
 * 실패 시 exit 1(배포 차단). 실행: node web/re_apt.test.mjs
 * (픽스처는 먼저 python scripts/re/export_apt_parity.py 로 생성)
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const RE_APT = require('./re_apt.js');
const here = dirname(fileURLToPath(import.meta.url));
const fixPath = join(here, '..', 'tests', 'fixtures', 're_apt_parity.json');

let fix;
try {
  fix = JSON.parse(readFileSync(fixPath, 'utf-8'));
} catch (e) {
  console.error(`픽스처 없음: ${fixPath}\n  먼저 실행: python scripts/re/export_apt_parity.py`);
  process.exit(2);
}

const TOL = 1e-9;
let maxErr = 0, fails = 0;

for (const c of fix.cases) {
  // ① denseSeries — 평활+ffill (값 ~1e5 만원이라 상대오차 기준)
  const dense = RE_APT.denseSeries(c.sparse, c.n_months, { smooth: c.smooth });
  let ok = dense.length === c.expect_dense.length;
  let de = 0;
  if (ok) {
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i], b = c.expect_dense[i];
      if ((a == null) !== (b == null)) { ok = false; break; }
      if (a != null) de = Math.max(de, Math.abs(a - b) / Math.max(1, Math.abs(b)));
    }
  }
  if (!ok || de > TOL) {
    console.error(`✗ ${c.name}/dense: ${ok ? `상대오차 ${de.toExponential(3)} > ${TOL}` : 'null 위치/길이 불일치'}`);
    fails++; continue;
  }
  maxErr = Math.max(maxErr, de);

  // ② netNav — 유효 구간 슬라이스 후 NAV (절대오차)
  const rng = RE_APT.validRange(dense);
  if (!rng || rng.first !== c.expect_first) {
    console.error(`✗ ${c.name}/range: first=${rng && rng.first} != ${c.expect_first}`); fails++; continue;
  }
  const levels = dense.slice(rng.first, rng.last + 1);
  const nav = RE_APT.netNav(levels, { entry: c.costs.entry, holdingAnnual: c.costs.holding, exitCost: c.costs.exit });
  if (nav.length !== c.expect_nav.length) {
    console.error(`✗ ${c.name}/nav: 길이 ${nav.length} != ${c.expect_nav.length}`); fails++; continue;
  }
  let ne = 0;
  for (let i = 0; i < nav.length; i++) ne = Math.max(ne, Math.abs(nav[i] - c.expect_nav[i]));
  maxErr = Math.max(maxErr, ne);
  if (ne > TOL) { console.error(`✗ ${c.name}/nav: 최대오차 ${ne.toExponential(3)} > ${TOL}`); fails++; continue; }

  // ③ gapEquityNav — 전세 레버리지 자기자본 NAV (절대오차)
  let ge = 0;
  if (c.expect_gap_nav) {
    const gnav = RE_APT.gapEquityNav(levels, c.gap_ratio, { entry: c.costs.entry, holdingAnnual: c.costs.holding });
    for (let i = 0; i < gnav.length; i++) ge = Math.max(ge, Math.abs(gnav[i] - c.expect_gap_nav[i]));
    maxErr = Math.max(maxErr, ge);
    if (ge > TOL) { console.error(`✗ ${c.name}/gap: 최대오차 ${ge.toExponential(3)} > ${TOL}`); fails++; continue; }
  }
  console.log(`  ✓ ${c.name}  dense=${de.toExponential(2)}  nav=${ne.toExponential(2)}  gap=${ge.toExponential(2)}  n=${nav.length}`);
}

// 가드 자기검증 — 임계 경계(재계산 로직 스모크; Python bt 플래그가 1차 진실)
{
  const cfg = { min_tx: 30, min_months: 24, min_span: 60, max_gap: 24 };
  const mkBand = (months, perMonth) => ({
    sale: { mi: Array.from({ length: months }, (_, i) => i * 2), n: Array(months).fill(perMonth) } });
  const g1 = RE_APT.guards(mkBand(31, 1), cfg);            // 31건·31개월·61스팬·갭1 → 통과
  const g2 = RE_APT.guards(mkBand(20, 1), cfg);            // 20건 → 거래수 미달
  const g3 = RE_APT.guards({ sale: { mi: [0, 30, 120], n: [20, 20, 20] } }, cfg);   // 갭 89 → 미달
  if (!g1.ok || g2.ok || g3.ok) { console.error(`✗ 가드 자기검증: ${JSON.stringify([g1, g2, g3])}`); fails++; }
  else console.log('  ✓ 가드 자기검증(통과/거래수/갭)');
}

console.log(`\n패리티: 전체 최대오차 ${maxErr.toExponential(3)}, 실패 ${fails}건`);
process.exit(fails ? 1 : 0);
