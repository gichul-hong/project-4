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
 *   h.setAction("RIGHT_CROSS"); // "LEFT_JAB" · "RIGHT_HOOK" · "LEFT_UPPERCUT" · "DUAL_GUARD" · "IDLE" ...
 *   h.update();                 // idle 바운스/보행/펀치/가드/피격/다운 포즈를 자동 보간
 *
 *   h.hit(damage)   // 피격 리액션 (움찔 + 뒤로 밀림)
 *   h.setDown(true) // K.O. — 뒤로 넘어지며 사라짐 (false면 다시 일어남)
 *   h.setFace(face) // 3D 복원 얼굴을 머리로 사용 (face3d.js 의 createFace3D 결과)
 *
 * 노출 API (기존 코드 호환):
 *   .group, .head, .body(몸통), .leftGlove, .rightGlove, .shield
 *   .armL { shoulder, elbow, glove }, .armR { ... }
 *   .legL { hip, knee }, .legR { hip, knee }
 *   .setAction(action), .update(), .hit(dmg), .setDown(bool), .isDown()
 *
 * 좌표 규약: 아바타 로컬 +z가 정면. 펀치는 +z로 뻗고, 넘어질 때는 -z(뒤)로 눕는다.
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

  // 액션 이름 → 펀치 종류. 아바타 모션이 기술마다 달라지는 근거표.
  const PUNCH_KIND = {
    LEFT_JAB:       { kind: 'straight', side: 'left'  },
    RIGHT_CROSS:    { kind: 'straight', side: 'right' },
    JAB_STRAIGHT:   { kind: 'straight', side: 'right' },
    LEFT_HOOK:      { kind: 'hook',     side: 'left'  },
    RIGHT_HOOK:     { kind: 'hook',     side: 'right' },
    LEFT_UPPERCUT:  { kind: 'uppercut', side: 'left'  },
    RIGHT_UPPERCUT: { kind: 'uppercut', side: 'right' },
    ENERGY_WAVE:    { kind: 'wave',     side: 'both'  },
  };

  // 기술별 모션 길이(초) — 훅/어퍼는 궤적이 커서 조금 길게 잡아야 눈에 읽힌다.
  const PUNCH_DUR = { straight: 0.30, hook: 0.42, uppercut: 0.42, wave: 0.55 };

  // 3D 얼굴을 씌울 때의 두개골 형상.
  // z를 납작하게 눌러 "뒤통수"만 담당하게 하고, 그 앞을 얼굴이 덮는다.
  const HEAD_R = 1.3;                                    // 구 머리 반지름
  const SKULL_SCALE = { x: 0.90, y: 0.96, z: 0.58 };
  const FACE_MARGIN = 0.04;   // 두개골 표면에서 얼굴을 이만큼 더 띄운다 (z-fighting 방지)

  /**
   * 얼굴 메쉬가 두개골 타원체에 **한 정점도 파묻히지 않는** 최소 전방 오프셋을 구한다.
   *
   * bounds.zMin 하나로 어림하면 얼굴 형태에 따라 뚫린다 —
   * 가장 뒤쪽 정점이 반드시 가장 깊이 박히는 정점은 아니기 때문이다(옆으로 벌어진 뺨은
   * 타원체가 좁아지는 자리라 오히려 여유가 있고, 가운데 낮은 정점이 더 위험하다).
   * 정점마다 정확히 풀어서 최댓값을 취한다.
   *
   *   타원체 밖 조건: (x/a)^2 + (y/b)^2 + ((z+d)/c)^2 >= 1
   *   k = 1 - (x/a)^2 - (y/b)^2  가 0 이하면 그 정점은 x·y 만으로 이미 바깥 → 제약 없음
   *   그렇지 않으면  d >= c*sqrt(k) - z
   */
  function faceForwardOffset(face) {
    const a = HEAD_R * SKULL_SCALE.x, b = HEAD_R * SKULL_SCALE.y, c = HEAD_R * SKULL_SCALE.z;
    const attr = face.mesh && face.mesh.geometry && face.mesh.geometry.attributes
              && face.mesh.geometry.attributes.position;
    const pos = attr && attr.array;
    if (!pos || !pos.length) {
      const zMin = (face.bounds && face.bounds.zMin) || -0.4;
      return c - zMin + FACE_MARGIN;      // 바운딩만 있을 때의 안전한 폴백
    }
    let d = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const k = 1 - (x / a) * (x / a) - (y / b) * (y / b);
      if (k <= 0) continue;               // x·y 만으로 이미 타원체 바깥
      const need = c * Math.sqrt(k) - z;
      if (need > d) d = need;
    }
    if (d === -Infinity) d = 0;           // 모든 정점이 이미 바깥
    return d + FACE_MARGIN;
  }

  window.createHumanoid = function (hexColor, opts) {
    opts = opts || {};
    const color = (hexColor !== undefined && hexColor !== null) ? hexColor : 0xff3366;

    // group = 외부 변환(위치·yaw). rig = 내부 변환(넘어짐·피격 리액션·어퍼컷 상하).
    // 넘어짐을 group에 직접 걸면 호출자가 매 프레임 쓰는 rotation.y와 축이 섞여
    // 바라보는 방향과 무관하게 이상한 쪽으로 눕는다. 그래서 한 겹 분리한다.
    const group = new THREE.Group();
    const rig = new THREE.Group();
    group.add(rig);

    const outfitMat = new THREE.MeshStandardMaterial({ color: 0x252a3c, roughness: 0.55, metalness: 0.15 });
    const skinMat   = new THREE.MeshStandardMaterial({ color: 0xc89a6b, roughness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4, metalness: 0.3 });
    const gloveMat  = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.35 });
    const visorMat  = new THREE.MeshBasicMaterial({ color: color });
    const fadeMats  = [outfitMat, skinMat, accentMat, gloveMat, visorMat];   // headMat 은 아래에서 추가

    // ---------- 몸통 / 골반 ----------
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, 3.2, 10), outfitMat);
    torso.position.y = 3.1;
    rig.add(torso);

    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.95, 10, 8), outfitMat);
    pelvis.position.y = 1.7;
    rig.add(pelvis);

    // ---------- 목 / 머리(헤드기어) ----------
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.7, 8), skinMat);
    neck.position.y = 4.85;
    rig.add(neck);

    // 머리는 전용 머티리얼을 쓴다 — accentMat 을 공유하면 3D 얼굴을 씌울 때
    // 발/머리띠 등 accentMat 을 쓰는 다른 부위 색까지 같이 바뀐다.
    const headMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4, metalness: 0.3 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 16), headMat);
    head.position.y = 5.7;
    rig.add(head);

    fadeMats.push(headMat);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 0.55), visorMat);
    visor.position.set(0, 5.7, 1.15);
    rig.add(visor);

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
      rig.add(arm.shoulder);
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
      rig.add(leg.hip);
    });

    // ---------- 가드 실드 (홀로그램) ----------
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 20, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0 })
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.y = 4.0;
    rig.add(shield);

    // ---------- 애니메이션 상태 ----------
    const S = {
      action: 'IDLE',
      punch: 0,          // 1 → 0 감쇠 (남은 비율)
      punchSide: 'right',
      punchKind: 'straight',
      punchDur: PUNCH_DUR.straight,
      guard: 0,          // 0..1 (감쇠)
      flinch: 0,         // 피격 움찔 0..1
      flinchMag: 1,      // 데미지에 비례한 세기
      down: false,       // K.O. 여부
      downAmt: 0,        // 넘어짐 진행도 0..1
      walkPhase: 0,
      lastPos: new THREE.Vector3(),
      lastT: performance.now(),
      // 현재 포즈 (lerp 대상으로 점진 수렴)
      lSX: 0.15, lSZ: -0.15, lEX: -1.7,
      rSX: 0.15, rSZ: 0.15, rEX: -1.7
    };

    // 박싱 포즈 목표값 정의 (펀치가 아닐 때의 정지 포즈)
    const POSES = {
      neutral: { lSX: 0.15, lSZ: -0.15, lEX: -1.7, rSX: 0.15, rSZ: 0.15, rEX: -1.7 },
      guard:   { lSX: -0.5, lSZ: -0.2,  lEX: -2.1, rSX: -0.5, rSZ: 0.2,  rEX: -2.1 }
    };

    /**
     * 기술별 팔 포즈. 이 함수가 "쨉/훅/어퍼가 서로 다르게 보이는" 실체다.
     *   p — 모션 진행도 0(시작) → 1(끝). 단조 증가. 궤적을 한 방향으로 쓸 때 쓴다.
     *   w — 뻗음 정도 0 → 1 → 0. 뻗었다가 회수하는 왕복에 쓴다.
     *   s — 좌우 부호 (왼팔 -1 / 오른팔 +1). 어깨 z회전이 몸 바깥쪽으로 향하는 방향.
     * 반환: SX(어깨 앞뒤) · SZ(어깨 좌우) · EX(팔꿈치 굽힘) · twist(몸통 회전) · lift(상하)
     */
    function punchPose(kind, s, p, w) {
      if (kind === 'hook') {
        // 훅: 팔꿈치를 90°로 접은 채 바깥에서 안쪽으로 감아친다.
        // 스윙(SZ)은 p로 한 방향으로만 쓸어야 "휘두른다"로 읽힌다. w로 하면 갔다 되돌아온다.
        return {
          SX: -0.30 - 0.95 * w,          // 어깨 높이까지 들어올림
          SZ: s * (1.20 - 1.55 * p),     // 바깥(1.20) → 몸 앞을 가로질러(-0.35)
          EX: -1.60 + 0.25 * w,          // 팔꿈치는 끝까지 접힌 채 유지
          twist: -s * 0.55 * w,          // 훅은 몸통 회전이 주력 — 크게 돌린다
          lift: 0
        };
      }
      if (kind === 'uppercut') {
        // 어퍼컷: 무릎을 낮췄다가 아래에서 위로 솟구친다.
        return {
          SX: 0.60 - 2.65 * w,           // 아래 뒤(+0.60) → 위 앞(-2.05)
          SZ: s * (0.35 - 0.15 * w),
          EX: -2.25 + 0.45 * w,          // 깊게 접은 팔꿈치
          twist: -s * 0.30 * w,
          lift: -0.55 * Math.sin(p * Math.PI * 0.9) + 0.85 * w  // 살짝 가라앉았다 솟음
        };
      }
      if (kind === 'wave') {
        // 장풍: 양손을 앞으로 밀어낸다 (side='both'이므로 호출부에서 양팔에 같은 값 적용)
        return {
          SX: 0.15 - 1.65 * w,
          SZ: s * 0.45,
          EX: -1.70 + 1.55 * w,
          twist: 0,
          lift: 0.25 * w
        };
      }
      // 쨉 / 스트레이트: 팔꿈치를 펴면서 정면으로 곧게 뻗는다.
      return {
        SX: 0.15 - 1.75 * w,
        SZ: s * 0.15,
        EX: -1.70 + 1.65 * w,
        twist: -s * 0.25 * w,
        lift: 0
      };
    }

    function setAction(action) {
      if (!action) return;
      S.action = action;
      const spec = PUNCH_KIND[action];
      if (spec) {
        S.punch = 1;
        S.punchKind = spec.kind;
        S.punchSide = spec.side;
        S.punchDur = PUNCH_DUR[spec.kind] || 0.30;
      } else if (action === 'DUAL_GUARD' || action === 'TWO_HAND_GUARD') {
        S.guard = 1;
      }
    }

    /**
     * 3D 복원 얼굴을 머리에 붙인다 (face3d.js).
     * 단색 구 머리는 숨기고, 얼굴 메쉬를 같은 자리에 놓는다.
     * face 를 null 로 주면 원래 구 머리로 되돌아간다.
     */
    let faceObj = null;
    function setFace(face) {
      if (faceObj && faceObj.mesh && faceObj.mesh.parent) rig.remove(faceObj.mesh);
      faceObj = face || null;
      if (faceObj && faceObj.mesh) {
        // Face Mesh 는 얼굴 **앞면만** 덮는다. 구 머리를 숨겨버리면 뒤통수가 없는
        // "떠 있는 가면"이 되므로, 구는 두개골로 남기고 얼굴을 그 **앞면 바깥**에 얹는다.
        //
        // 배치를 상수로 박으면 안 된다. 얼굴 깊이는 사람마다 다르고, 조금만 뒤로 가면
        // 얼굴 전체가 구 안에 파묻혀 **아무것도 안 보인다**(실제로 그렇게 됐었다).
        // 얼굴의 가장 뒤쪽 점(bounds.zMin)이 두개골 표면보다 앞에 오도록 역산한다.
        head.scale.set(SKULL_SCALE.x, SKULL_SCALE.y, SKULL_SCALE.z);
        faceObj.mesh.position.set(0, head.position.y, faceForwardOffset(faceObj));
        rig.add(faceObj.mesh);
        head.visible = true;
        headMat.color.setHex(0x2a2f3e);        // 두개골은 어둡게 — 얼굴이 도드라진다
        headMat.emissive.setHex(0x000000);
        visor.visible = false;                 // 바이저는 얼굴과 겹친다
      } else {
        head.visible = true;
        head.scale.set(1, 1, 1);
        headMat.color.setHex(color);
        headMat.emissive.setHex(0x000000);
        visor.visible = true;
      }
    }

    /** 피격 리액션 — 데미지가 클수록 크게 움찔한다. */
    function hit(damage) {
      if (faceObj) {
        // 어느 쪽을 맞았는지는 알 수 없으므로 번갈아 — 같은 자리만 계속 눌리면 부자연스럽다
        const sides = ['left', 'right', 'center', 'chin'];
        faceObj.hit(damage, sides[(S.hitCount = (S.hitCount || 0) + 1) % sides.length]);
      }
      S.flinch = 1;
      S.flinchMag = Math.min(1.4, 0.45 + (damage || 5) / 12);
    }

    /** K.O. — true면 뒤로 넘어지며 페이드아웃, false면 되살아난다. */
    function setDown(isDown) {
      S.down = !!isDown;
      if (!S.down) group.visible = true;
    }

    function update() {
      const now = performance.now();
      let dt = (now - S.lastT) / 1000;
      if (dt > 0.05) dt = 0.05; // 탭 전환 시 점프 방지
      S.lastT = now;

      // ---------- K.O. 다운 (다른 모든 포즈보다 우선) ----------
      const downTarget = S.down ? 1 : 0;
      const downRate = dt / (S.down ? 0.75 : 0.45);   // 넘어지는 건 느리게, 일어나는 건 빠르게
      S.downAmt += Math.max(-downRate, Math.min(downRate, downTarget - S.downAmt));
      S.downAmt = Math.max(0, Math.min(1, S.downAmt));

      // 넘어짐 진행도(downEase)만 여기서 구하고, 실제 변환은 update() 맨 끝에서 적용한다.
      // 앞에서 rig를 건드리면 아래의 피격·어퍼컷 리액션이 그대로 덮어써 자세가 튄다.
      const downEase = S.downAmt * S.downAmt * (3 - 2 * S.downAmt);  // smoothstep
      if (S.downAmt > 0) {
        const op = 1 - downEase;
        fadeMats.forEach(m => { m.transparent = true; m.opacity = op; });
        group.visible = op > 0.02;
        if (S.downAmt >= 1) {            // 완전히 쓰러지면 나머지 연출은 계산할 필요가 없다
          shield.material.opacity = 0;
          return;
        }
      } else if (fadeMats[0].opacity !== 1) {
        fadeMats.forEach(m => { m.opacity = 1; m.transparent = false; });
      }

      // 이동 속도 감지 (group 위치 변화)
      const dx = group.position.x - S.lastPos.x;
      const dz = group.position.z - S.lastPos.z;
      const speed = Math.hypot(dx, dz) / Math.max(dt, 0.001);
      S.lastPos.set(group.position.x, group.position.y, group.position.z);
      if (speed > 0.4) S.walkPhase += dt * speed * 1.3;
      else S.walkPhase *= 0.9;

      // 감쇠는 프레임 수가 아니라 시간 기준 (렌더 FPS가 달라도 같은 길이로 보이도록)
      S.punch  = Math.max(0, S.punch - dt / S.punchDur);
      S.guard  = Math.max(0, S.guard - dt / 0.50);   // 가드 ~0.5초 (100ms마다 갱신되므로 유지됨)
      S.flinch = Math.max(0, S.flinch - dt / 0.35);

      // 목표 포즈 결정 — 펀치가 가드보다 우선.
      // 가드를 우선하면, 클라이언트가 10Hz로 보내는 DUAL_GUARD가 S.guard를 계속 1로 되살려
      // 펀치 포즈가 화면에 아예 나타나지 않는다. (복싱 스탠스는 상시 가드 판정)
      const punching = S.punch > 0.02;
      let target, twist = 0, lift = 0;

      if (punching) {
        const p = 1 - S.punch;                                  // 0 → 1
        const w = Math.sin(Math.pow(p, 0.65) * Math.PI);        // 0 → 1 → 0 (빠르게 뻗고 천천히 회수)
        // 치지 않는 팔은 가드를 올린 채로 둔다 — 실제 복싱 폼이고, 어느 팔로 쳤는지가 선명해진다.
        const G = POSES.guard;
        if (S.punchSide === 'both') {
          const pl = punchPose(S.punchKind, -1, p, w);
          const pr = punchPose(S.punchKind,  1, p, w);
          target = { lSX: pl.SX, lSZ: pl.SZ, lEX: pl.EX, rSX: pr.SX, rSZ: pr.SZ, rEX: pr.EX };
          twist = pl.twist; lift = pl.lift;
        } else if (S.punchSide === 'left') {
          const q = punchPose(S.punchKind, -1, p, w);
          target = { lSX: q.SX, lSZ: q.SZ, lEX: q.EX, rSX: G.rSX, rSZ: G.rSZ, rEX: G.rEX };
          twist = q.twist; lift = q.lift;
        } else {
          const q = punchPose(S.punchKind, 1, p, w);
          target = { lSX: G.lSX, lSZ: G.lSZ, lEX: G.lEX, rSX: q.SX, rSZ: q.SZ, rEX: q.EX };
          twist = q.twist; lift = q.lift;
        }
      } else if (S.guard > 0.3) {
        target = POSES.guard;
      } else {
        target = POSES.neutral;
      }

      // 부드러운 lerp — 펀치(공격) 순간엔 빠르게, 회수/대기 시엔 부드럽게
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

      // 피격 리액션 — 뒤로 젖히며 밀린다. 펀치 몸통 회전과 더해진다.
      const fl = S.flinch * S.flinchMag;
      rig.rotation.x = -fl * 0.30;
      rig.rotation.y += (twist - rig.rotation.y) * 0.35;
      rig.position.z = -fl * 0.9;
      rig.position.y = lift + fl * 0.15;
      head.rotation.x = -fl * 0.55;

      // 3D 얼굴 — 호흡/피격/표정 갱신은 얼굴 모듈이 스스로 한다
      if (faceObj) {
        faceObj.update(dt);
        faceObj.mesh.position.y = head.position.y;
        faceObj.mesh.visible = group.visible;
      }

      // 호흡/바운스
      const breathe = Math.sin(now * 0.004) * 0.06;
      torso.position.y = 3.1 + breathe;
      pelvis.position.y = 1.7 + breathe * 0.5;
      neck.position.y = 4.85 + breathe * 0.6;
      head.position.y = 5.7 + breathe;
      visor.position.y = 5.7 + breathe;

      // 다리: 이동 시 보행 스윙, 대기 시 미세 자세.
      // 어퍼컷은 다리로 밀어올리는 기술이라 무릎 굽힘을 lift와 연동한다.
      const moving = speed > 0.4 ? 1 : 0;
      const swing = Math.sin(S.walkPhase);
      const crouch = (punching && S.punchKind === 'uppercut') ? Math.max(0, -lift) * 0.9 : 0;
      legL.hip.rotation.x = swing * 0.55 * moving + Math.sin(now * 0.003) * 0.02;
      legR.hip.rotation.x = -swing * 0.55 * moving + Math.sin(now * 0.003 + Math.PI) * 0.02;
      const kneeBend = moving ? Math.max(0, Math.sin(S.walkPhase + Math.PI) * 0.5) : 0.08;
      legL.knee.rotation.x = 0.08 + kneeBend + crouch;
      legR.knee.rotation.x = 0.08 + Math.max(0, Math.sin(S.walkPhase) * 0.5) * moving + crouch;

      // 가드 실드 시각화
      shield.material.opacity += (((S.guard > 0.3 && !punching) ? 0.85 : 0) - shield.material.opacity) * 0.2;

      // K.O. 다운 변환은 마지막에 덧씌운다 (위의 리액션 값 위에 얹혀 자연스럽게 넘어간다)
      if (downEase > 0) {
        rig.rotation.x -= downEase * 1.45;    // 뒤(-z)로 눕는다
        rig.position.y -= downEase * 1.15;    // 매트로 가라앉음
        rig.position.z -= downEase * 1.60;
        shield.material.opacity *= (1 - downEase);
      }
    }

    return {
      group, rig, head, body: torso, leftGlove: armL.glove, rightGlove: armR.glove, shield,
      armL, armR, legL, legR, visor,
      setAction, update, hit, setDown, setFace,
      getFace: () => faceObj,
      isDown: () => S.down,
      state: S
    };
  };
})();
