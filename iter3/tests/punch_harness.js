/**
 * punch_harness.js — 펀치 인식(tryPunch/classifyPunch) 헤드리스 검증
 *
 *   cd iter3/tests && node punch_harness.js
 *
 * fighter_client.html 에서 TUNE · classifyPunch · tryPunch 의 **원문을 그대로 추출**해 구동한다.
 * 팔 운동학(armKinematics)이 만들어내는 값을 흉내낸 궤적을 흘려보내며
 * "잽이 인식되는가 / 훅·어퍼가 잽으로 오분류되지 않는가"를 수치로 확인한다.
 *
 * 임계값을 감으로 만지면 한쪽을 고치다 다른 쪽을 부순다. 이 하니스가 그 균형을 잡아 준다.
 */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../server/templates/fighter_client.html'), 'utf8');

function extract(startPattern) {
  const i = html.indexOf(startPattern);
  if (i < 0) throw new Error('찾지 못함: ' + startPattern);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

const src = `
  ${extract('const TUNE = {')};
  const PUNCH_NAME = {
    L: { STRAIGHT: 'LEFT_JAB',  HOOK: 'LEFT_HOOK',  UPPERCUT: 'LEFT_UPPERCUT'  },
    R: { STRAIGHT: 'RIGHT_CROSS', HOOK: 'RIGHT_HOOK', UPPERCUT: 'RIGHT_UPPERCUT' },
  };
  const arms = {
    L: { armed: false, armT: 0, peak: 0, reach0: 0, lastPunch: -99999, pvx: 0, pvy: 0, pelbow: 180 },
    R: { armed: false, armT: 0, peak: 0, reach0: 0, lastPunch: -99999, pvx: 0, pvy: 0, pelbow: 180 },
  };
  let lastPunchAny = -99999;
  ${extract('function classifyPunch(')}
  ${extract('function tryPunch(')}
  return {
    TUNE, arms, classifyPunch, tryPunch,
    reset: () => {
      for (const s of ['L', 'R']) Object.assign(arms[s], {
        armed: false, armT: 0, peak: 0, reach0: 0, lastPunch: -99999, pvx: 0, pvy: 0, pelbow: 180 });
      lastPunchAny = -99999;
    },
    fire: (t) => { lastPunchAny = t; },
  };
`;
const S = new Function(src)();
const TUNE = S.TUNE;

let fail = 0;
const ck = (n, c, x) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? `  (${x})` : ''}`);
  if (!c) fail++;
};

/**
 * 펀치 궤적을 흘려보낸다.
 *  reach: 어깨→손목 거리(어깨폭 배수). 가드에서 시작해 peakReach 까지 뻗었다 돌아온다.
 *  속도/방향은 궤적에서 유도한다 (armKinematics 가 실제로 하는 계산과 같은 형태).
 *
 * @param opts.startReach  가드 자세의 뻗음
 * @param opts.peakReach   최대로 뻗었을 때
 * @param opts.riseMs      뻗는 데 걸리는 시간 (잽은 짧다)
 * @param opts.dirx/diry   속도 벡터의 좌우/상하 성분 비중 (훅/어퍼 구분)
 * @param opts.elbow0/elbow1  팔꿈치 각도(도) 시작→끝.
 *        스트레이트는 가드(약 95도)에서 펴지며 나가고, 훅·어퍼컷은 **이미 접은 채** 휘두른다.
 *        판정은 "최고 속도 순간"의 각도를 쓰므로 이 차이가 분류를 가른다.
 * @param opts.shoulderM   어깨폭(m) — 어깨폭 배수를 미터로 바꾸는 환산
 */
function throwPunch(opts) {
  const side = opts.side || 'L';
  const dt = 1 / 30;                       // 포즈 추정 30fps
  const shoulderM = opts.shoulderM || 0.40;
  const rise = (opts.riseMs || 150) / 1000;
  const total = rise * 2.2;
  let t0 = opts.t0 || 10000;
  let prevReach = opts.startReach;
  let result = null;

  for (let t = 0; t <= total; t += dt) {
    // 뻗었다 되돌아오는 궤적 (sin 반주기)
    const u = Math.min(1, t / rise);
    const env = Math.sin(Math.min(t / total, 1) * Math.PI);
    const reachN = opts.startReach + (opts.peakReach - opts.startReach) * env;
    const dReachN = (reachN - prevReach) / dt;           // 어깨폭 배수/초
    prevReach = reachN;

    // 손목 속도(m/s). 뻗음 변화율이 전방 성분이고, 여기에 좌우/상하 성분을 얹는다.
    const fwd = Math.abs(dReachN) * shoulderM;
    const vx = fwd * (opts.dirx || 0);
    const vy = fwd * (opts.diry || 0);
    const speed = Math.hypot(fwd, vx, vy) * (opts.speedGain || 1);

    const now = t0 + t * 1000;
    const k = {
      side, speed,
      dReach: dReachN * shoulderM,          // m/s
      reachN,
      vx, vy,
      elbow: opts.elbow0 + (opts.elbow1 - opts.elbow0) * u,
    };
    const r = S.tryPunch(k, now);
    if (r) { result = r; S.fire(now); break; }
  }
  return result;
}

const GUARD = 0.42;      // 가드 자세의 어깨→손목 거리 (어깨폭 배수)

console.log(`설정: PUNCH_SPEED=${TUNE.PUNCH_SPEED} REACH_N=${TUNE.PUNCH_REACH_N} `
          + `GROW_N=${TUNE.PUNCH_GROW_N} ARM=${TUNE.PUNCH_ARM} WINDOW=${TUNE.PUNCH_WINDOW}\n`);

console.log('--- 잽: 짧고 빠른 정면 펀치 ---');
{
  // 잽은 리치가 짧다. 가드(0.42)에서 1.05 정도까지, 130ms 만에 뻗는다.
  S.reset();
  const jab = throwPunch({ side: 'L', startReach: GUARD, peakReach: 1.05, riseMs: 130,
                           dirx: 0.10, diry: -0.10, elbow0: 95, elbow1: 172 });
  ck('빠른 잽이 인식된다', !!jab, jab ? jab.action : '미인식');
  ck('잽으로 분류된다 (훅/어퍼 아님)', jab && jab.action === 'LEFT_JAB', jab ? jab.action : '-');

  // 더 짧은 잽 (거의 툭 치는 수준)
  S.reset();
  const short = throwPunch({ side: 'L', startReach: GUARD, peakReach: 0.92, riseMs: 110,
                             dirx: 0.12, diry: -0.08, elbow0: 95, elbow1: 168 });
  ck('짧은 잽도 인식된다', !!short, short ? short.action : '미인식');

  // 오른손 스트레이트
  S.reset();
  const cross = throwPunch({ side: 'R', startReach: GUARD, peakReach: 1.15, riseMs: 150,
                             dirx: -0.08, diry: -0.05, elbow0: 92, elbow1: 174 });
  ck('오른손 스트레이트도 인식', cross && cross.action === 'RIGHT_CROSS', cross ? cross.action : '미인식');
}

console.log('\n--- 훅 / 어퍼컷이 잽으로 오분류되지 않는가 ---');
{
  S.reset();
  const hook = throwPunch({ side: 'R', startReach: GUARD, peakReach: 0.95, riseMs: 190,
                            dirx: 1.35, diry: 0, elbow0: 112, elbow1: 122 });   // 훅 — 접은 채로 휘두른다
  ck('훅이 인식된다', !!hook, hook ? hook.action : '미인식');
  ck('훅으로 분류된다', hook && hook.action === 'RIGHT_HOOK', hook ? hook.action : '-');

  S.reset();
  const upper = throwPunch({ side: 'R', startReach: GUARD, peakReach: 0.92, riseMs: 190,
                             dirx: 0, diry: -1.25, elbow0: 98, elbow1: 112 });   // 어퍼 — 깊게 접은 채
  ck('어퍼컷이 인식된다', !!upper, upper ? upper.action : '미인식');
  ck('어퍼컷으로 분류된다', upper && upper.action === 'RIGHT_UPPERCUT', upper ? upper.action : '-');
}

console.log('\n--- 오검출: 펀치가 아닌 동작 ---');
{
  S.reset();
  // 가드에서 천천히 손을 내리는 동작
  const slow = throwPunch({ side: 'L', startReach: GUARD, peakReach: 0.95, riseMs: 900,
                            dirx: 0.1, diry: 0.2, elbow0: 100, elbow1: 150 });
  ck('느린 팔 이동은 펀치가 아니다', !slow, slow ? slow.action : '미발동');

  S.reset();
  // 빠르지만 거의 뻗지 않는 동작 (가드 안에서 손만 흔들기)
  const twitch = throwPunch({ side: 'L', startReach: GUARD, peakReach: 0.58, riseMs: 110,
                              dirx: 0.4, diry: 0.3, elbow0: 95, elbow1: 100 });
  ck('뻗지 않는 잔동작은 펀치가 아니다', !twitch, twitch ? twitch.action : '미발동');
}

console.log('\n--- 연타 쿨다운 ---');
{
  S.reset();
  const a = throwPunch({ side: 'L', t0: 10000, startReach: GUARD, peakReach: 1.05, riseMs: 130,
                         dirx: 0.1, diry: -0.1, elbow0: 95, elbow1: 172 });
  ck('첫 잽 발동', !!a);
  // 같은 팔로 즉시 다시 (PUNCH_CD 이내)
  const b = throwPunch({ side: 'L', t0: 10150, startReach: GUARD, peakReach: 1.05, riseMs: 130,
                         dirx: 0.1, diry: -0.1, elbow0: 95, elbow1: 172 });
  ck('같은 팔 연타는 쿨다운에 막힌다', !b, b ? b.action : '막힘');
  // 쿨다운이 지난 뒤
  const c = throwPunch({ side: 'L', t0: 10700, startReach: GUARD, peakReach: 1.05, riseMs: 130,
                         dirx: 0.1, diry: -0.1, elbow0: 95, elbow1: 172 });
  ck('쿨다운 후에는 다시 발동', !!c, c ? c.action : '미발동');
}

console.log('\n--- 좌/우 원투 콤비네이션 ---');
{
  S.reset();
  const j = throwPunch({ side: 'L', t0: 20000, startReach: GUARD, peakReach: 1.02, riseMs: 130,
                         dirx: 0.1, diry: -0.1, elbow0: 95, elbow1: 172 });
  ck('1번 잽', !!j, j ? j.action : '미인식');
  const cr = throwPunch({ side: 'R', t0: 20320, startReach: GUARD, peakReach: 1.15, riseMs: 150,
                          dirx: -0.08, diry: -0.05, elbow0: 92, elbow1: 174 });
  ck('2번 스트레이트 (양팔 쿨다운 200ms 이후)', !!cr, cr ? cr.action : '미인식');
}

console.log(fail === 0 ? '\n>>> 전부 통과' : `\n>>> ${fail}개 실패`);
process.exit(fail ? 1 : 0);
