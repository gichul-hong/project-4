/**
 * punch_core.js — 펀치 판정 단일 소스 (런타임 · 평가기 공용)
 *
 * 브라우저와 Node 양쪽에서 **같은 파일**을 쓴다.
 *   브라우저:  <script src="/static/punch_core.js"></script>  →  window.PunchCore
 *   Node:      const PunchCore = require('../server/static/punch_core.js');
 *
 * ── 왜 분리했나 ────────────────────────────────────────────────────────────
 * 판정 로직이 fighter_client.html 안에 있으면 평가기(하니스)는 둘 중 하나를 해야 한다.
 *   (a) 로직을 베껴 쓴다 → 런타임과 조용히 어긋난다. 정작 잡아야 할 회귀를 통과시킨다.
 *   (b) HTML 에서 함수 원문을 텍스트로 추출한다 → 중괄호 매칭에 의존해 취약하다.
 * 파일로 빼면 양쪽이 같은 코드를 import 하므로 이 문제가 사라진다.
 *
 * ── 의존성 없음 ────────────────────────────────────────────────────────────
 * DOM · THREE · MediaPipe 를 참조하지 않는다. 입력은 순수한 3D 좌표(미터)와 시각(ms)뿐이라
 * 웹캠 없이도 궤적을 만들어 넣으면 그대로 판정이 돌아간다.
 *
 * ── 좌표 규약 ──────────────────────────────────────────────────────────────
 * sh/el/wr 은 MediaPipe poseWorldLandmarks 규약을 따른다 (미터, 골반 중심 원점).
 *   +x 오른쪽 · +y 아래 · +z 카메라 반대쪽
 * 따라서 "위로 솟구침"은 vy 가 **음수**다. 거리는 어깨폭(shW)으로 나눠 체격 불변으로 만든다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PunchCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 펀치 판정 기본값.
   *
   * 속도·뻗음이 같은 프레임에 겹치지 않아도 되도록 "창(window)" 안에서 누적 판정한다.
   * 단일 프레임에 둘 다 걸려야 했던 이전 방식은, 포즈 샘플이 성긴 구간에서
   * "속도 최고인 프레임은 아직 덜 뻗었고 / 다 뻗은 프레임은 이미 감속" 이라 양쪽 다 놓쳤다.
   *
   * 잽은 "짧고 빠른" 펀치라 스트레이트 기준으로 잡으면 걸리지 않는다.
   * 리치가 어깨폭 0.9배 남짓이고 신전 시간도 0.11초 안팎이라 최고 속도가 낮게 찍힌다.
   * 완화와 오검출 사이의 균형은 tests/punch_harness.js 가 잡아 준다.
   */
  const PUNCH_TUNE = {
    PUNCH_ARM: 1.0,          // 창을 여는 손목 속도 (m/s)
    PUNCH_EXTEND: 0.40,      // 창을 여는 어깨→손목 거리 증가율 (m/s)
    PUNCH_SPEED: 1.6,        // 창 안에서 도달해야 하는 최고 손목 속도 (m/s)
    PUNCH_REACH_N: 0.88,     // 발사 시점의 팔 뻗음 (어깨폭 배수)
    PUNCH_GROW_N: 0.28,      // 또는 창 시작 대비 뻗음 증가량 (훅·어퍼컷용)
    PUNCH_WINDOW: 380,       // 창 유효 시간(ms)
    PUNCH_CD: 400,           // 같은 팔 재발동 쿨다운(ms)
    PUNCH_CD_ANY: 200,       // 양팔 공통 쿨다운(ms)

    // 종류 분류 임계값.
    // 잽을 완화하면 약간 비스듬한 잽이 훅/어퍼로 새기 쉬우므로 이쪽은 반대로 올려 두었다.
    // 실제 훅/어퍼는 이 값을 훌쩍 넘긴다(하니스 실측 0.78~0.80)라 여유가 충분하다.
    UPPERCUT_VY: 0.55,       // -vy/speed 가 이보다 크면 어퍼컷 (위로 솟구침)
    UPPERCUT_ELBOW: 150,     // 그리고 팔꿈치가 이보다 접혀 있어야 한다 (도)
    HOOK_VX: 0.56,           // |vx|/speed 가 이보다 크면 훅 (옆으로 휘두름)
    HOOK_ELBOW: 158,

    // ── 필살기 (ENERGY_WAVE) ──────────────────────────────────────────
    // 손가락 랜드마크를 쓰는 제스처는 Pose 와 Hands 를 같이 돌려야 해서 FPS 가 무너진다.
    // 그래서 **상체 7노드만으로** 정의한다: 양손을 가슴에 모았다가 함께 앞으로 밀어낸다.
    //   (1) 두 손이 서로 가까이 모인다      — 한 손 펀치와 구분되는 결정적 신호
    //   (2) 두 팔이 함께 빠르게 뻗어 나간다  — 회전 제스처(옆으로 쓸기)와 구분된다
    ULT_GATHER_N: 0.62,      // 두 손목 사이 거리가 어깨폭의 이 배수 이하면 "모았다"
    ULT_GATHER_MS: 260,      // 그 상태를 이만큼 유지해야 장전된다
    ULT_WINDOW: 620,         // 장전 후 이 시간 안에 밀어내야 한다(ms)
    ULT_PUSH_SPEED: 1.1,     // 양손이 함께 나가는 최소 속도 (m/s, 둘 중 느린 쪽 기준)
    ULT_PUSH_GROW: 0.30,     // 장전 시점 대비 뻗음 증가량 (어깨폭 배수, 양팔 평균)
    ULT_CD: 1200,            // 필살기 쿨다운(ms)

    // 펀치 잠금 — 이 시간 동안 자세 신호를 갱신하지 않는다.
    // 펀치는 몸통 회전(투영 어깨폭 축소)과 주먹 이동을 동반해 roll/pitch/shift를 크게 흔들기 때문에,
    // 적용만 막고 신호를 계속 적분하면 잠금이 풀리는 순간 엉뚱한 방향으로 튀어나간다.
    //
    // 하한이 480ms 였을 때는 실측 펀치 간격(최소 0.20초 / 중앙값 0.25초)보다 길어서
    // 연타 중에는 잠금이 한 번도 풀리지 않아 이동이 완전히 죽었다.
    // 실제 보호는 PUNCH_LOCK_MAX + armsBusy(팔이 아직 나가 있는지)가 담당하므로,
    // 하한은 "팔이 확실히 나가 있는 최소 시간"만 덮으면 된다.
    PUNCH_LOCK: 180,         // 최소 잠금 시간(ms)
    PUNCH_LOCK_MAX: 1100,    // 팔이 아직 회수 중이면 여기까지 연장(ms)
    PUNCH_MOVE_DECAY: 1.2,   // 잠금 중 유지되는 이동 의사의 감쇠 시상수(s)
  };

  const PUNCH_NAME = {
    L: { STRAIGHT: 'LEFT_JAB',    HOOK: 'LEFT_HOOK',  UPPERCUT: 'LEFT_UPPERCUT' },
    R: { STRAIGHT: 'RIGHT_CROSS', HOOK: 'RIGHT_HOOK', UPPERCUT: 'RIGHT_UPPERCUT' },
  };

  const ULTIMATE = 'ENERGY_WAVE';

  /** b 를 꼭짓점으로 하는 3D 내각(도). 180에 가까울수록 팔이 곧게 펴진 상태. */
  function angleDeg(a, b, c) {
    const abx = a.x - b.x, aby = a.y - b.y, abz = a.z - b.z;
    const cbx = c.x - b.x, cby = c.y - b.y, cbz = c.z - b.z;
    const d = Math.hypot(abx, aby, abz) * Math.hypot(cbx, cby, cbz);
    if (d < 1e-6) return 180;
    const cos = (abx * cbx + aby * cby + abz * cbz) / d;
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }

  function freshArm() {
    return {
      // 직전 프레임의 손목 위치·거리·시각 (속도 계산용)
      x: 0, y: 0, z: 0, reach: 0, t: 0,
      // 창(window) 래치
      armed: false, armT: 0, peak: 0, reach0: 0,
      pvx: 0, pvy: 0, pelbow: 180,
      // 마지막 발동 시각 + 바깥(잠금 판정·HUD)에서 읽는 값
      lastPunch: -1e9, lastSpeed: 0, lastReachN: 0,
    };
  }

  /**
   * 펀치 판정기 인스턴스를 만든다.
   * @param {object} [overrides] PUNCH_TUNE 을 부분적으로 덮어쓸 값 (실험·튜닝용)
   */
  function createPunchCore(overrides) {
    const tune = Object.assign({}, PUNCH_TUNE, overrides || {});
    const arms = { L: freshArm(), R: freshArm() };
    let lastPunchAny = -1e9;
    // 필살기 상태: 손을 모은 시각 / 장전 여부 / 장전 시점의 평균 뻗음
    const ult = { gatherT: 0, armedT: 0, reach0: 0, lastFire: -1e9 };

    /**
     * 어깨→팔꿈치→손목 운동학. 입력은 3D 미터 좌표.
     * reachN 은 어깨폭 배수라 체격이 달라도 같은 임계값이 통한다.
     * 호출할 때마다 내부 상태(직전 위치·시각)가 갱신되므로 프레임마다 정확히 한 번 부른다.
     */
    function kinematics(side, sh, el, wr, shW, now) {
      const st = arms[side];
      const reach = Math.hypot(wr.x - sh.x, wr.y - sh.y, wr.z - sh.z);   // 어깨→손목 거리(m)
      const elbow = angleDeg(sh, el, wr);
      let vx = 0, vy = 0, vz = 0, speed = 0, dReach = 0;

      const dt = (now - st.t) / 1000;
      // dt 가 너무 짧으면 노이즈가 속도로 증폭되고, 너무 길면 프레임 드롭이라 신뢰할 수 없다
      if (st.t > 0 && dt > 0.008 && dt < 0.4) {
        vx = (wr.x - st.x) / dt;
        vy = (wr.y - st.y) / dt;
        vz = (wr.z - st.z) / dt;
        speed = Math.hypot(vx, vy, vz);
        dReach = (reach - st.reach) / dt;
      }

      st.x = wr.x; st.y = wr.y; st.z = wr.z;
      st.reach = reach; st.t = now;
      // 펀치 잠금 판정(팔이 아직 나가 있는지)에 쓰인다
      st.lastSpeed = speed;
      st.lastReachN = reach / shW;

      return { side, reach, reachN: reach / shW, elbow, vx, vy, vz, speed, dReach };
    }

    /** 손목 궤적 방향 + 팔꿈치 각도로 펀치 종류 판정 */
    function classify(k) {
      const s = Math.max(k.speed, 1e-3);
      if (-k.vy / s > tune.UPPERCUT_VY && k.elbow < tune.UPPERCUT_ELBOW) return 'UPPERCUT';
      if (Math.abs(k.vx) / s > tune.HOOK_VX && k.elbow < tune.HOOK_ELBOW) return 'HOOK';
      return 'STRAIGHT';
    }

    /**
     * 펀치는 "빠르게 뻗기 시작"에서 창을 열고, 창이 유효한 동안 최고속도를 누적한 뒤
     * 팔이 충분히 뻗은 시점에 발사한다.
     * @returns {{action: string, speed: number, kind: string}|null}
     */
    function tryPunch(k, now) {
      const st = arms[k.side];

      // (1) 창 열기
      if (k.speed > tune.PUNCH_ARM && k.dReach > tune.PUNCH_EXTEND && !st.armed) {
        st.armed = true; st.armT = now; st.peak = 0; st.reach0 = k.reachN;
      }
      if (!st.armed) return null;
      if (now - st.armT > tune.PUNCH_WINDOW) { st.armed = false; return null; }

      // (2) 창 안에서 최고 속도와 **그 순간의** 궤적 방향을 기록.
      //     감속 구간의 방향으로 분류하면 종류가 엉뚱하게 잡힌다.
      if (k.speed > st.peak) {
        st.peak = k.speed; st.pvx = k.vx; st.pvy = k.vy; st.pelbow = k.elbow;
      }

      // (3) 발사 — 최고속도 도달 + (충분히 뻗음 또는 창 시작 대비 뻗음 증가)
      if (st.peak < tune.PUNCH_SPEED) return null;
      if (k.reachN < tune.PUNCH_REACH_N && (k.reachN - st.reach0) < tune.PUNCH_GROW_N) return null;
      if (now - st.lastPunch < tune.PUNCH_CD || now - lastPunchAny < tune.PUNCH_CD_ANY) {
        st.armed = false; return null;
      }

      st.armed = false;
      st.lastPunch = now;
      lastPunchAny = now;
      const kind = classify({ speed: st.peak, vx: st.pvx, vy: st.pvy, elbow: st.pelbow });
      return { action: PUNCH_NAME[k.side][kind], kind, speed: st.peak };
    }

    /**
     * 펀치 잠금 여부. 잠금 중에는 자세 신호를 갱신하지 않는다.
     * 최소 시간을 넘겨도 팔이 아직 나가 있으면(armsBusy) PUNCH_LOCK_MAX 까지 연장한다.
     */
    function isLocked(now) {
      const since = now - lastPunchAny;
      if (since < tune.PUNCH_LOCK) return true;
      const busy = Math.max(arms.L.lastSpeed, arms.R.lastSpeed) > 0.9
                || Math.max(arms.L.lastReachN, arms.R.lastReachN) > 1.00;
      return since < tune.PUNCH_LOCK_MAX && busy;
    }

    /**
     * 필살기 판정 — 양손을 모았다가 함께 앞으로 밀어낸다.
     *
     * 일반 펀치와 겹치지 않게 만드는 것이 핵심이다.
     *   · 펀치는 **한쪽 팔만** 빠르다 → 둘 중 느린 쪽 속도를 보면 갈린다
     *   · 회전 제스처는 양손이 **옆으로** 쓸린다 → 뻗음(reach)이 늘지 않는다
     * 여기서는 둘 다 요구하므로 다른 동작이 잘못 걸리지 않는다.
     *
     * @param {object} kL,kR  양팔 운동학 (kinematics 결과)
     * @param {number} wristGapN 두 손목 사이 거리 (어깨폭 배수)
     * @param {boolean} canUse   게이지가 찼는가 (서버가 최종 판정하지만, 못 쓸 때 장전하지 않는다)
     * @returns {{action:string, speed:number}|null}
     */
    function tryUltimate(kL, kR, wristGapN, now, canUse) {
      if (!canUse) { ult.gatherT = 0; ult.armedT = 0; return null; }
      if (now - ult.lastFire < tune.ULT_CD) return null;

      const avgReach = (kL.reachN + kR.reachN) / 2;

      // (1) 손을 모으고 있는가
      if (wristGapN <= tune.ULT_GATHER_N) {
        if (!ult.gatherT) ult.gatherT = now;
        if (!ult.armedT && now - ult.gatherT >= tune.ULT_GATHER_MS) {
          ult.armedT = now;
          ult.reach0 = avgReach;
        }
      } else if (!ult.armedT) {
        ult.gatherT = 0;      // 아직 장전 전인데 손이 벌어졌다 → 처음부터
      }

      if (!ult.armedT) return null;
      if (now - ult.armedT > tune.ULT_WINDOW) { ult.armedT = 0; ult.gatherT = 0; return null; }

      // (2) 두 팔이 **함께** 빠르게 뻗어 나가는가
      const slower = Math.min(kL.speed, kR.speed);
      if (slower < tune.ULT_PUSH_SPEED) return null;
      if (avgReach - ult.reach0 < tune.ULT_PUSH_GROW) return null;

      ult.armedT = 0; ult.gatherT = 0;
      ult.lastFire = now;
      lastPunchAny = now;
      // 양팔 창 래치도 풀어 둔다 — 필살기 직후에 펀치가 겹쳐 나가지 않게
      arms.L.armed = false; arms.R.armed = false;
      arms.L.lastPunch = now; arms.R.lastPunch = now;
      return { action: ULTIMATE, kind: 'ULTIMATE', speed: (kL.speed + kR.speed) / 2 };
    }

    /** 필살기가 장전된 상태인가 (HUD 표시용) */
    function isUltArmed(now) {
      return !!ult.armedT && (now - ult.armedT) <= tune.ULT_WINDOW;
    }

    function reset() {
      arms.L = freshArm();
      arms.R = freshArm();
      lastPunchAny = -1e9;
      ult.gatherT = 0; ult.armedT = 0; ult.lastFire = -1e9;
    }

    /** 창 래치만 푼다 (포즈를 놓쳤을 때. 속도 이력은 유지) */
    function disarm() {
      arms.L.armed = false;
      arms.R.armed = false;
    }

    return {
      tune, arms, PUNCH_NAME, ULTIMATE,
      kinematics, classify, tryPunch, tryUltimate, isUltArmed,
      isLocked, reset, disarm, angleDeg,
      getLastPunchAny: () => lastPunchAny,
      setLastPunchAny: (t) => { lastPunchAny = t; },
    };
  }

  return { PUNCH_TUNE, PUNCH_NAME, ULTIMATE, angleDeg, createPunchCore };
});
