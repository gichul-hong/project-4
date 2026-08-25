/**
 * pose_harness.js — humanoid.js 절차적 애니메이션 헤드리스 검증
 *
 * 브라우저·Three.js 없이 THREE 최소 스텁(three_stub.js) 위에서 humanoid.js를 직접 구동해
 * 기술별 펀치 궤적 / K.O. 다운 / 피격 리액션이 의도대로 나오는지 수치로 확인한다.
 * 포즈 로직을 고칠 때마다 돌릴 것.
 *
 *   cd iter3/tests && node pose_harness.js
 */
require('./three_stub.js');
require('../server/static/humanoid.js');

let T = 0;
global.performance.now = () => T;

function fresh() { T = 0; return window.createHumanoid(0xff3366); }
function step(h, ms) { T += ms; h.update(); }

// 펀치 궤적을 샘플링해 (어깨X, 어깨Z, 팔꿈치X)의 극값을 뽑는다
function trace(action) {
  const h = fresh();
  for (let i = 0; i < 5; i++) step(h, 16);        // 중립 안정화
  h.setAction(action);
  const rec = { sx: [], sz: [], ex: [] };
  const right = !action.startsWith('LEFT');
  for (let i = 0; i < 32; i++) {
    step(h, 16);
    const arm = right ? h.armR : h.armL;
    rec.sx.push(arm.shoulder.rotation.x);
    rec.sz.push(arm.shoulder.rotation.z);
    rec.ex.push(arm.elbow.rotation.x);
  }
  const rng = a => Math.max(...a) - Math.min(...a);
  return {
    reachMin: Math.min(...rec.sx),          // 팔을 얼마나 앞/위로 올렸나 (작을수록 높이)
    swing:    rng(rec.sz),                  // 좌우 스윙 폭 → 훅의 서명
    extend:   Math.max(...rec.ex),          // 팔꿈치가 얼마나 펴졌나 (0에 가까울수록 곧음)
    elbowMin: Math.min(...rec.ex),
  };
}

const R = {};
['RIGHT_CROSS','RIGHT_HOOK','RIGHT_UPPERCUT','LEFT_JAB','LEFT_HOOK','LEFT_UPPERCUT'].forEach(a => R[a] = trace(a));

console.log('기술            어깨X최소  스윙폭   팔꿈치최대(펴짐)');
for (const [a, v] of Object.entries(R)) {
  console.log(`${a.padEnd(15)} ${v.reachMin.toFixed(2).padStart(7)} ${v.swing.toFixed(2).padStart(8)} ${v.extend.toFixed(2).padStart(12)}`);
}

let fail = 0;
const ck = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };
console.log('\n--- 기술이 서로 구별되는가 ---');
ck('스트레이트: 팔꿈치를 편다 (>-0.5)',        R.RIGHT_CROSS.extend > -0.5);
ck('훅: 팔꿈치를 접은 채 유지 (<-1.0)',        R.RIGHT_HOOK.extend < -1.0);
ck('훅: 좌우 스윙이 가장 크다',                R.RIGHT_HOOK.swing > R.RIGHT_CROSS.swing * 3 && R.RIGHT_HOOK.swing > R.RIGHT_UPPERCUT.swing * 3);
ck('어퍼컷: 팔을 가장 높이 올린다',            R.RIGHT_UPPERCUT.reachMin < R.RIGHT_CROSS.reachMin);
ck('어퍼컷: 팔꿈치를 깊게 접는다 (<-1.5)',     R.RIGHT_UPPERCUT.extend < -1.5);
ck('좌우 대칭: 훅 스윙폭이 좌우 동일',         Math.abs(R.RIGHT_HOOK.swing - R.LEFT_HOOK.swing) < 0.02);
ck('좌우 대칭: 어퍼 도달높이 좌우 동일',       Math.abs(R.RIGHT_UPPERCUT.reachMin - R.LEFT_UPPERCUT.reachMin) < 0.02);

console.log('\n--- 치지 않는 팔은 가드를 유지하는가 ---');
{
  const h = fresh();
  for (let i = 0; i < 5; i++) step(h, 16);
  h.setAction('RIGHT_CROSS');
  for (let i = 0; i < 12; i++) step(h, 16);
  ck('오른손 크로스 중 왼팔은 가드(팔꿈치 접힘 <-1.6)', h.armL.elbow.rotation.x < -1.6);
  ck('오른팔은 뻗어 있다 (팔꿈치 >-1.0)',                h.armR.elbow.rotation.x > -1.0);
}

console.log('\n--- K.O. 다운 (#5) ---');
{
  const h = fresh();
  for (let i = 0; i < 5; i++) step(h, 16);
  ck('평상시 보인다', h.group.visible === true);
  h.setDown(true);
  for (let i = 0; i < 70; i++) step(h, 16);   // 1.12초
  ck('쓰러진 뒤 링에서 사라진다', h.group.visible === false);
  ck('뒤로 눕는다 (rig.rotation.x < -1.0)', h.rig.rotation.x < -1.0);
  h.setDown(false);
  for (let i = 0; i < 45; i++) step(h, 16);
  ck('라운드 리셋으로 부활한다', h.group.visible === true && Math.abs(h.rig.rotation.x) < 0.1);
}

console.log('\n--- 피격 리액션 (#4) ---');
{
  const h = fresh();
  for (let i = 0; i < 5; i++) step(h, 16);
  const z0 = h.rig.position.z;
  h.hit(8);
  step(h, 16);
  ck('맞으면 뒤(-z)로 밀린다', h.rig.position.z < z0 - 0.1);
  ck('맞으면 상체가 젖혀진다', h.rig.rotation.x < -0.05);
  for (let i = 0; i < 30; i++) step(h, 16);
  ck('0.5초 뒤 원자세로 복귀', Math.abs(h.rig.position.z) < 0.02 && Math.abs(h.rig.rotation.x) < 0.02);
}

console.log(fail === 0 ? '\n>>> 전부 통과' : `\n>>> ${fail}개 실패`);
process.exit(fail ? 1 : 0);
