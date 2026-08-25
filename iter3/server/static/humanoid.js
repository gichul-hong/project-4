/**
 * humanoid.js — 저폴리 관절형 휴머노이드 빌더 + 절차적 애니메이션
 * (Three.js r128 전역 THREE 의존, ES module 아님)
 *
 * 사용법:
 *   const h = window.createHumanoid(0xff3366);
 *   scene.add(h.group);
 *   h.group.position.set(x, 0, z);
 *   h.group.rotation.y = yaw;
 *
 *   // 매 프레임:
 *   h.setAction("RIGHT_CROSS"); // 또는 "LEFT_JAB", "DUAL_GUARD", "IDLE" 등
 *   h.update();                 // idle 바운스/이동 보행/펀치/가드 포즈를 자동 보간
 *
 * 노출 API (기존 코드 호환):
 *   .group, .head, .body(몸통), .leftGlove, .rightGlove, .shield
 *   .armL { shoulder, elbow, glove }, .armR { ... }
 *   .legL { hip, knee }, .legR { hip, knee }
 *   .setAction(action), .update()
 */
(function () {
  if (typeof THREE === 'undefined') {
    console.error('[humanoid.js] THREE 로드 필요 (three.min.js 이후에 include)');
    return;
  }

  function makeLimb(side) {
    // 팔: 어깨 → 상완 → 팔꿈치 → 전완 → 글러브
    const shoulder = new THREE.Group();
    const elbow = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 2.1, 8), null);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 1.9, 8), null);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 16), null);
    return { shoulder, elbow, upper, fore, glove };
  }

  window.createHumanoid = function (hexColor, opts) {
    opts = opts || {};
    const color = (hexColor !== undefined && hexColor !== null) ? hexColor : 0xff3366;

    const group = new THREE.Group();

    const outfitMat = new THREE.MeshStandardMaterial({ color: 0x252a3c, roughness: 0.55, metalness: 0.15 });
    const skinMat   = new THREE.MeshStandardMaterial({ color: 0xc89a6b, roughness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4, metalness: 0.3 });
    const gloveMat  = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.35 });
    const visorMat  = new THREE.MeshBasicMaterial({ color: color });

    // ---------- 몸통 / 골반 ----------
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, 3.2, 10), outfitMat);
    torso.position.y = 3.1;
    group.add(torso);

    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.95, 10, 8), outfitMat);
    pelvis.position.y = 1.7;
    group.add(pelvis);

    // ---------- 목 / 머리(헤드기어) ----------
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.7, 8), skinMat);
    neck.position.y = 4.85;
    group.add(neck);

    const head = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 16), accentMat);
    head.position.y = 5.7;
    group.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 0.55), visorMat);
    visor.position.set(0, 5.7, 1.15);
    group.add(visor);

    // ---------- 팔 (어깨/팔꿈치 관절) ----------
    const armL = makeLimb(-1), armR = makeLimb(1);

    [armL, armR].forEach(arm => {
      arm.shoulder.position.set(arm === armL ? -1.9 : 1.9, 4.3, 0);
      arm.upper.material = outfitMat;
      arm.upper.position.y = -1.05;
      arm.fore.material = skinMat;
      arm.fore.position.y = -0.95;
      arm.glove.material = gloveMat;
      arm.glove.position.y = -1.9;
      arm.elbow.position.y = -2.1;
      arm.shoulder.add(arm.upper);
      arm.shoulder.add(arm.elbow);
      arm.elbow.add(arm.fore);
      arm.elbow.add(arm.glove);
      group.add(arm.shoulder);
    });

    // ---------- 다리 (고관절/무릎 관절) ----------
    function makeLeg(side) {
      const hip = new THREE.Group();
      const knee = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.5, 2.0, 8), outfitMat);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.34, 1.7, 8), skinMat);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 1.0), accentMat);
      return { hip, knee, thigh, shin, foot };
    }
    const legL = makeLeg(-1), legR = makeLeg(1);
    [legL, legR].forEach(leg => {
      const side = leg === legL ? -1 : 1;
      leg.hip.position.set(side * 0.9, 1.7, 0);
      leg.thigh.position.y = -1.0;
      leg.knee.position.y = -2.0;
      leg.shin.position.y = -0.85;
      leg.foot.position.set(0, -1.75, 0.15);
      leg.hip.add(leg.thigh);
      leg.hip.add(leg.knee);
      leg.knee.add(leg.shin);
      leg.knee.add(leg.foot);
      group.add(leg.hip);
    });

    // ---------- 가드 실드 (홀로그램) ----------
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 20, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0 })
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.y = 4.0;
    group.add(shield);

    // ---------- 애니메이션 상태 ----------
    const S = {
      action: 'IDLE',
      punch: 0,       // 0..1 (감쇠)
      punchSide: 'right',
      guard: 0,       // 0..1 (감쇠)
      walkPhase: 0,
      lastPos: new THREE.Vector3(),
      lastT: performance.now(),
      // 현재 포즈 (lerp 대상으로 점진 수렴)
      lSX: 0.15, lSZ: -0.15, lEX: -1.7,
      rSX: 0.15, rSZ: 0.15, rEX: -1.7
    };

    // 박싱 포즈 목표값 정의
    const POSES = {
      neutral:  { lSX: 0.15, lSZ: -0.15, lEX: -1.7, rSX: 0.15, rSZ: 0.15, rEX: -1.7 },
      punchR:   { lSX: 0.15, lSZ: -0.15, lEX: -1.7, rSX: -1.55, rSZ: 0.15, rEX: -0.05 },
      punchL:   { lSX: -1.55, lSZ: -0.15, lEX: -0.05, rSX: 0.15, rSZ: 0.15, rEX: -1.7 },
      guard:    { lSX: -0.5, lSZ: -0.2, lEX: -2.1, rSX: -0.5, rSZ: 0.2, rEX: -2.1 }
    };

    function setAction(action) {
      if (!action) return;
      S.action = action;
      if (action === 'RIGHT_CROSS' || action === 'JAB_STRAIGHT' || action === 'RIGHT_UPPERCUT' || action === 'RIGHT_HOOK') {
        S.punch = 1; S.punchSide = 'right';
      } else if (action === 'LEFT_JAB' || action === 'LEFT_HOOK' || action === 'LEFT_UPPERCUT') {
        S.punch = 1; S.punchSide = 'left';
      } else if (action === 'DUAL_GUARD' || action === 'TWO_HAND_GUARD') {
        S.guard = 1;
      }
    }

    function update() {
      const now = performance.now();
      let dt = (now - S.lastT) / 1000;
      if (dt > 0.05) dt = 0.05; // 탭 전환 시 점프 방지
      S.lastT = now;

      // 이동 속도 감지 (group 위치 변화)
      const dx = group.position.x - S.lastPos.x;
      const dz = group.position.z - S.lastPos.z;
      const speed = Math.hypot(dx, dz) / Math.max(dt, 0.001);
      S.lastPos.set(group.position.x, group.position.y, group.position.z);
      if (speed > 0.4) S.walkPhase += dt * speed * 1.3;
      else S.walkPhase *= 0.9;

      // 감쇠는 프레임 수가 아니라 시간 기준 (렌더 FPS가 달라도 같은 길이로 보이도록)
      S.punch = Math.max(0, S.punch - dt / 0.30);   // 펀치 ~0.3초
      S.guard = Math.max(0, S.guard - dt / 0.50);   // 가드 ~0.5초 (100ms마다 갱신되므로 유지됨)

      // 목표 포즈 결정 — 펀치가 가드보다 우선.
      // 가드를 우선하면, 클라이언트가 10Hz로 보내는 DUAL_GUARD가 S.guard를 계속 1로 되살려
      // 펀치 포즈가 화면에 아예 나타나지 않는다. (복싱 스탠스는 상시 가드 판정)
      let target;
      if (S.punch > 0.2) target = (S.punchSide === 'right') ? POSES.punchR : POSES.punchL;
      else if (S.guard > 0.3) target = POSES.guard;
      else target = POSES.neutral;

      // 부드러운 lerp — 펀치(공격) 순간엔 빠르게, 회수/대기 시엔 부드럽게
      const punching = S.punch > 0.2;
      const k = punching ? 0.55 : 0.16;
      S.lSX += (target.lSX - S.lSX) * k;
      S.lSZ += (target.lSZ - S.lSZ) * k;
      S.lEX += (target.lEX - S.lEX) * k;
      S.rSX += (target.rSX - S.rSX) * k;
      S.rSZ += (target.rSZ - S.rSZ) * k;
      S.rEX += (target.rEX - S.rEX) * k;

      armL.shoulder.rotation.x = S.lSX;
      armL.shoulder.rotation.z = S.lSZ;
      armL.elbow.rotation.x = S.lEX;
      armR.shoulder.rotation.x = S.rSX;
      armR.shoulder.rotation.z = S.rSZ;
      armR.elbow.rotation.x = S.rEX;

      // 호흡/바운스
      const breathe = Math.sin(now * 0.004) * 0.06;
      torso.position.y = 3.1 + breathe;
      pelvis.position.y = 1.7 + breathe * 0.5;
      neck.position.y = 4.85 + breathe * 0.6;
      head.position.y = 5.7 + breathe;
      visor.position.y = 5.7 + breathe;

      // 다리: 이동 시 보행 스윙, 대기 시 미세 자세
      const moving = speed > 0.4 ? 1 : 0;
      const swing = Math.sin(S.walkPhase);
      legL.hip.rotation.x = swing * 0.55 * moving + Math.sin(now * 0.003) * 0.02;
      legR.hip.rotation.x = -swing * 0.55 * moving + Math.sin(now * 0.003 + Math.PI) * 0.02;
      const kneeBend = moving ? Math.max(0, Math.sin(S.walkPhase + Math.PI) * 0.5) : 0.08;
      legL.knee.rotation.x = 0.08 + kneeBend;
      legR.knee.rotation.x = 0.08 + Math.max(0, Math.sin(S.walkPhase) * 0.5) * moving;

      // 가드 실드 시각화
      shield.material.opacity += (((S.guard > 0.3 && !punching) ? 0.85 : 0) - shield.material.opacity) * 0.2;
    }

    return {
      group, head, body: torso, leftGlove: armL.glove, rightGlove: armR.glove, shield,
      armL, armR, legL, legR, visor, setAction, update, state: S
    };
  };
})();
