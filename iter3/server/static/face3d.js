/**
 * face3d.js — 웹캠 사진 한 장에서 복원한 3D 얼굴 + 피격 손상 표현
 * (Three.js r128 전역 THREE 의존, ES module 아님)
 *
 * ── 왜 이 방식인가 ────────────────────────────────────────────────────────────
 * 기존 검토(DEVLOG 2026-08-24)는 세 가지를 놓고 저울질했다.
 *   A) 사진을 구(sphere)에 텍스처로 — 쉽지만 정면만 맞는 2.5D
 *   B) DECA/FLAME 오프라인 3D 복원 — 진짜 3D지만 Python·GPU·GLB로 시간 리스크 큼
 *   C) 다중 뷰 빌보드 하이브리드 — 단순성 대비 이득이 작음
 *
 * 네 번째 길이 있다. **MediaPipe Face Mesh 가 브라우저에서 468개 3D 랜드마크를 준다.**
 * 정해진 토폴로지(canonical topology)를 쓰므로 랜드마크를 그대로 정점으로 삼고
 * 테셀레이션으로 삼각형을 구성하면, 사진 한 장에서 **그 사람의 실제 3D 얼굴 메쉬**가 나온다.
 * B의 결과물(단안 3D 복원)을 A의 비용으로 얻는 셈이다.
 *
 * 그리고 이 선택이 게임에 직접 값을 한다 — 진짜 메쉬이므로
 * **맞으면 그 지점이 눌리고, HP가 떨어지면 표정이 바뀌는** 것을 정점 변형으로 표현할 수 있다.
 * 텍스처를 입힌 구였다면 불가능하다.
 *
 * FPS: Face Mesh 는 **캡처 순간에만** 돌리고 즉시 끈다. 게임 중에는 Pose 만 돈다.
 * (과거 두 모델 동시 실행 시 30fps 이하로 떨어진 이력이 있어 처음부터 배제한 설계다.)
 *
 * ── 사용법 ──────────────────────────────────────────────────────────────────
 *   const face = window.createFace3D({ landmarks, image, color });
 *   humanoid.setFace(face.mesh);
 *   face.hit(damage, 'left');   // 피격 — 그 방향이 눌리고 멍이 든다
 *   face.setHp(hp);             // 0~100 — 낮을수록 지친 표정 + 코피
 *   face.update(dt);            // 매 프레임
 *
 * 직렬화(네트워크 전송):
 *   const blob = window.serializeFace(landmarks, canvas);   // { lm, tex }
 *   const face = window.createFace3DFromBlob(blob, color);  // 수신 측
 */
(function () {
  if (typeof THREE === 'undefined') {
    console.error('[face3d.js] THREE 로드 필요');
    return;
  }

  // ── MediaPipe canonical face 랜드마크 인덱스 ──────────────────────────────
  // 표정을 만들 때 건드릴 부위. 인덱스는 Face Mesh 의 고정 토폴로지라 사람마다 같다.
  const IDX = {
    NOSE_TIP: 1,
    NOSE_BOTTOM: 2,
    NOSTRIL_L: 98, NOSTRIL_R: 327,
    BROW_L: [70, 63, 105, 66, 107],
    BROW_R: [336, 296, 334, 293, 300],
    LID_UPPER_L: [159, 158, 157, 173],
    LID_UPPER_R: [386, 385, 384, 398],
    LID_LOWER_L: [145, 144, 163],
    LID_LOWER_R: [374, 380, 381],
    LIP_UPPER: [13, 12, 82, 312],
    LIP_LOWER: [14, 15, 87, 317],
    MOUTH_CORNER_L: 61, MOUTH_CORNER_R: 291,
    CHIN: 152,
    CHEEK_L: 234, CHEEK_R: 454,
  };

  // 삼각형 목록은 토폴로지가 고정이라 한 번만 계산해 모든 얼굴이 공유한다.
  let cachedTris = null;

  /**
   * FACEMESH_TESSELATION 은 "삼각형"이 아니라 **간선 쌍** 목록이다.
   * 메쉬를 만들려면 삼각형이 필요하므로 3-사이클을 찾아 복원한다.
   * a<b<c 순서로만 담아 같은 삼각형이 세 번 잡히는 것을 막는다.
   */
  function trianglesFromEdges(edges) {
    const adj = new Map();
    const eset = new Set();
    const key = (a, b) => (a < b ? a * 100000 + b : b * 100000 + a);

    // 먼저 간선을 중복 제거한다. FACEMESH_TESSELATION 은 같은 간선을 [a,b] 와 [b,a] 로
    // **양방향 모두** 담고 있어(2556개 = 1278개 x 2), 그대로 인접 리스트를 만들면
    // 이웃이 두 번씩 들어가 같은 삼각형이 2x2 = 4번 잡힌다.
    // (실측: 중복 제거 전 3288개 → 제거 후 822개. 위상적으로 기대되는 값은 약 811개다.)
    for (const e of edges) {
      const a = e[0], b = e[1];
      if (a === b) continue;
      eset.add(key(a, b));
    }
    for (const k of eset) {
      const a = Math.floor(k / 100000), b = k % 100000;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    }

    const tris = [];
    for (const [a, nbrs] of adj) {
      for (const b of nbrs) {
        if (b <= a) continue;
        for (const c of adj.get(b)) {
          if (c <= b) continue;
          if (eset.has(key(a, c))) tris.push(a, b, c);
        }
      }
    }
    return tris;
  }

  function getTriangles() {
    if (cachedTris) return cachedTris;
    const tess = (typeof FACEMESH_TESSELATION !== 'undefined') ? FACEMESH_TESSELATION
               : (window.FACEMESH_TESSELATION || null);
    if (!tess) {
      console.error('[face3d.js] FACEMESH_TESSELATION 없음 — face_mesh.js 를 먼저 로드하세요');
      return null;
    }
    cachedTris = trianglesFromEdges(tess);
    return cachedTris;
  }

  /**
   * 랜드마크를 머리 크기에 맞게 정규화한다 (원점=얼굴 중심).
   *
   * **종횡비 보정이 핵심이다.** MediaPipe 정규화 좌표는 x를 이미지 *폭*으로,
   * y를 이미지 *높이*로 각각 나눈 값이라 등방(isotropic)이 아니다.
   * 480x360 프레임에서 그대로 쓰면 x가 0.75배로 눌려 얼굴이 세로로 길쭉해진다.
   * x에 aspect(W/H)를 곱해 실제 비율로 되돌린 뒤에 스케일을 잡아야 한다.
   * z는 MediaPipe 가 이미 "폭 기준"으로 낸 값이므로 x와 같은 단위다.
   */
  function normalizeLandmarks(lm, targetWidth, aspect) {
    const n = lm.length;
    const ar = aspect || 1;
    const pos = new Float32Array(n * 3);
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += lm[i].x * ar; cy += lm[i].y; cz += lm[i].z * ar; }
    cx /= n; cy /= n; cz /= n;

    // 좌우 광대(234·454) 폭을 스케일 기준으로 삼는다 — 카메라 거리에 무관하게 일정하다
    const a = lm[IDX.CHEEK_L], b = lm[IDX.CHEEK_R];
    const span = Math.max(Math.hypot((a.x - b.x) * ar, a.y - b.y, (a.z - b.z) * ar), 1e-4);
    const s = targetWidth / span;

    for (let i = 0; i < n; i++) {
      // MediaPipe 는 y가 아래로 증가하고 z가 카메라 쪽으로 음수 → Three.js 좌표로 뒤집는다
      pos[i * 3]     = (lm[i].x * ar - cx) * s;
      pos[i * 3 + 1] = -(lm[i].y - cy) * s;
      pos[i * 3 + 2] = -(lm[i].z * ar - cz) * s;
    }
    return pos;
  }

  /**
   * 삼각형 winding 이 뒤집혔는지 판정해 필요하면 뒤집는다.
   * 코끝은 얼굴에서 가장 앞으로(+z) 튀어나온 점이므로, 코 주변 삼각형의 법선이
   * +z 를 향하지 않으면 전체가 뒤집힌 것이다.
   */
  function fixWinding(pos, tris) {
    let acc = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]];
      const ax = pos[i * 3], ay = pos[i * 3 + 1], az = pos[i * 3 + 2];
      const bx = pos[j * 3], by = pos[j * 3 + 1], bz = pos[j * 3 + 2];
      const cx = pos[k * 3], cy = pos[k * 3 + 1], cz = pos[k * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      acc += ux * vy - uy * vx;          // 법선 z 성분
    }
    if (acc < 0) {
      for (let t = 0; t < tris.length; t += 3) {
        const tmp = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = tmp;
      }
    }
    return tris;
  }

  // ── 공용 텍스처 (코피 방울) ──────────────────────────────────────────────
  let bloodTex = null;
  function makeBloodTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 26, 2, 32, 32, 30);
    grad.addColorStop(0.0, 'rgba(255,60,60,1)');
    grad.addColorStop(0.45, 'rgba(190,10,20,0.95)');
    grad.addColorStop(1.0, 'rgba(120,0,10,0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(32, 34, 16, 26, 0, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  }

  /**
   * 3D 얼굴 생성.
   * @param {Array}  opts.landmarks  Face Mesh 468 랜드마크 (x,y,z 정규화 좌표)
   * @param {Canvas|Image} opts.image  같은 프레임의 얼굴 사진 (텍스처)
   * @param {number} opts.color       파이터 색 (림 라이트/코피 톤에 사용)
   * @param {number} opts.width       머리 폭 (휴머노이드 스케일, 기본 2.6)
   */
  window.createFace3D = function (opts) {
    const tris = getTriangles();
    if (!tris || !opts || !opts.landmarks || opts.landmarks.length < 400) return null;

    const lm = opts.landmarks;
    const width = opts.width || 2.6;
    const color = opts.color || 0xffffff;

    const basePos = normalizeLandmarks(lm, width, opts.aspect || 1);
    const index = fixWinding(basePos, tris.slice());

    // UV = 랜드마크의 2D 화면 좌표. 사진과 랜드마크가 **같은 프레임**에서 나왔으므로
    // 이 매핑이 곧 정확한 텍스처 정합이 된다 (얼굴 정렬 과정이 따로 필요 없다).
    //
    // 텍스처는 얼굴만 잘라 쓴다. 전체 프레임을 그대로 쓰면 얼굴이 텍스처의 1/3 도 안 되어
    // 해상도를 그만큼 버리게 된다. crop 이 주어지면 그 사각형 기준으로 UV 를 다시 잡는다.
    const crop = opts.crop;   // { x0, y0, w, h } — 원본 이미지 픽셀 단위
    const IW = opts.imageW || 1, IH = opts.imageH || 1;
    const uv = new Float32Array(lm.length * 2);
    for (let i = 0; i < lm.length; i++) {
      let u = lm[i].x, v = lm[i].y;
      if (crop) {
        u = (lm[i].x * IW - crop.x0) / crop.w;
        v = (lm[i].y * IH - crop.y0) / crop.h;
      }
      uv[i * 2] = u;
      uv[i * 2 + 1] = 1 - v;
    }

    const geo = new THREE.BufferGeometry();
    const livePos = new Float32Array(basePos);          // 변형이 적용된 실제 정점
    geo.setAttribute('position', new THREE.BufferAttribute(livePos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // 멍/홍조를 정점 색으로 누적한다 — 텍스처를 다시 그리지 않아도 손상이 보인다
    const vcol = new Float32Array(lm.length * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(vcol, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();

    let tex = null;
    if (opts.image) {
      tex = new THREE.CanvasTexture(opts.image);
      tex.flipY = true;
      tex.needsUpdate = true;
    }

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.02,
      side: THREE.DoubleSide,      // 뒤통수가 없는 반쪽 메쉬라 뒤에서 봐도 사라지지 않게
      emissive: color,
      emissiveIntensity: 0.06,     // 파이터 색을 아주 옅게 얹어 아바타와 톤을 맞춘다
    });

    const mesh = new THREE.Mesh(geo, mat);

    // ── 코피 ────────────────────────────────────────────────────────────
    if (!bloodTex) bloodTex = makeBloodTexture();
    const bloodMat = new THREE.MeshBasicMaterial({
      map: bloodTex, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide,
    });
    const blood = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.16, width * 0.42), bloodMat);
    // 콧구멍 아래에 붙인다. 위치는 랜드마크에서 직접 가져오므로 얼굴 형태를 따라간다.
    const nb = IDX.NOSE_BOTTOM;
    blood.position.set(basePos[nb * 3] * 0.6,
                       basePos[nb * 3 + 1] - width * 0.16,
                       basePos[nb * 3 + 2] + 0.02);
    mesh.add(blood);

    // ── 상태 ────────────────────────────────────────────────────────────
    const S = {
      hp: 100,
      impacts: [],        // { idx, dir, amp, t, life } — 눌린 자국
      swellTarget: 0,     // 누적 부기 (HP가 낮을수록 크다)
      swell: 0,
      bloodAmt: 0,
      shake: 0,
      expr: 0,            // 0(멀쩡) → 1(탈진). HP에서 유도
      exprNow: 0,
    };

    // 표정용 오프셋을 미리 계산해 둔다 (매 프레임 인덱스 순회를 피한다)
    const exprOffsets = buildExpressionOffsets(basePos, width);

    /**
     * 지친 표정 오프셋. 사람이 지치면 나타나는 변화를 부위별로 넣는다.
     *  - 눈썹 안쪽이 올라가고 바깥이 처진다 (팔자 눈썹)
     *  - 윗눈꺼풀이 내려온다 (눈이 반쯤 감김)
     *  - 입이 벌어진다 (헐떡임)
     *  - 턱이 살짝 내려간다
     */
    function buildExpressionOffsets(pos, w) {
      const off = new Float32Array(pos.length);   // 정점별 (dx,dy,dz)
      const add = (i, dx, dy, dz) => {
        off[i * 3] += dx; off[i * 3 + 1] += dy; off[i * 3 + 2] += dz;
      };
      // 눈썹 — 안쪽(배열 앞)일수록 올리고 바깥쪽일수록 내린다
      const brow = (arr, sign) => arr.forEach((id, k) => {
        const t = k / Math.max(1, arr.length - 1);          // 0=안쪽, 1=바깥쪽
        add(id, sign * w * 0.005, w * (0.030 - 0.055 * t), 0);
      });
      brow(IDX.BROW_L, -1);
      brow(IDX.BROW_R, 1);
      // 윗눈꺼풀 내림 (눈이 감긴다)
      IDX.LID_UPPER_L.concat(IDX.LID_UPPER_R).forEach(id => add(id, 0, -w * 0.030, 0));
      IDX.LID_LOWER_L.concat(IDX.LID_LOWER_R).forEach(id => add(id, 0, w * 0.008, 0));
      // 입 벌어짐 — 아랫입술과 턱을 내린다
      IDX.LIP_LOWER.forEach(id => add(id, 0, -w * 0.055, 0));
      IDX.LIP_UPPER.forEach(id => add(id, 0, w * 0.010, 0));
      add(IDX.CHIN, 0, -w * 0.070, 0);
      // 입꼬리 처짐
      add(IDX.MOUTH_CORNER_L, -w * 0.012, -w * 0.030, 0);
      add(IDX.MOUTH_CORNER_R, w * 0.012, -w * 0.030, 0);
      return off;
    }

    /** 피격 지점을 고른다. 방향이 주어지면 그쪽 뺨, 아니면 코 주변. */
    function pickImpactIndex(side) {
      if (side === 'left') return IDX.CHEEK_L;
      if (side === 'right') return IDX.CHEEK_R;
      if (side === 'chin') return IDX.CHIN;
      return IDX.NOSE_TIP;
    }

    /**
     * 피격 — 그 지점이 안쪽으로 눌렸다가 탄성으로 돌아오고, 멍이 남는다.
     * @param {number} damage 데미지 (변형 세기)
     * @param {string} side   'left' | 'right' | 'chin' | 'center'
     */
    function hit(damage, side) {
      const idx = pickImpactIndex(side);
      const amp = Math.min(1.0, 0.35 + (damage || 5) / 14) * width * 0.13;
      S.impacts.push({ idx, amp, t: 0, life: 0.7 });
      if (S.impacts.length > 6) S.impacts.shift();
      S.shake = Math.min(1, S.shake + 0.5 + (damage || 5) / 20);

      // 멍 — 맞은 자리 주변 정점을 붉게/보랏빛으로 물들인다. 지워지지 않고 누적된다.
      const cx = basePos[idx * 3], cy = basePos[idx * 3 + 1], cz = basePos[idx * 3 + 2];
      const R = width * 0.30, R2 = R * R;
      const strength = Math.min(0.5, 0.12 + (damage || 5) / 60);
      for (let i = 0; i < lm.length; i++) {
        const dx = basePos[i * 3] - cx, dy = basePos[i * 3 + 1] - cy, dz = basePos[i * 3 + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R2) continue;
        const f = (1 - Math.sqrt(d2) / R) * strength;
        vcol[i * 3]     = Math.max(0.35, vcol[i * 3] - f * 0.15);   // R 은 덜 깎아 붉게 남긴다
        vcol[i * 3 + 1] = Math.max(0.20, vcol[i * 3 + 1] - f);
        vcol[i * 3 + 2] = Math.max(0.28, vcol[i * 3 + 2] - f * 0.75);
      }
      geo.attributes.color.needsUpdate = true;
    }

    /** HP 반영 — 낮을수록 지친 표정, 부기, 코피. */
    function setHp(hp) {
      const v = Math.max(0, Math.min(100, hp));
      // 코피는 60 이하부터 시작해 0 에서 최대. HP 바와 별개로 "몸 상태"가 얼굴에 드러난다.
      S.hp = v;
      S.expr = 1 - v / 100;
      S.swellTarget = (1 - v / 100) * width * 0.045;
      S.bloodAmt = v >= 60 ? 0 : Math.min(1, (60 - v) / 45);
    }

    const _tmpNormal = new THREE.Vector3();
    function update(dt) {
      const n = lm.length;
      const pos = geo.attributes.position.array;

      // 표정 — 목표치로 부드럽게 수렴 (급변하면 표정이 튄다)
      S.exprNow += (S.expr - S.exprNow) * Math.min(1, dt * 3.0);
      S.swell += (S.swellTarget - S.swell) * Math.min(1, dt * 2.0);
      S.shake = Math.max(0, S.shake - dt / 0.45);

      // 피격 자국 감쇠 — 눌렸다가 스프링처럼 되돌아온다 (약간 튕기며)
      for (let k = S.impacts.length - 1; k >= 0; k--) {
        const im = S.impacts[k];
        im.t += dt;
        if (im.t >= im.life) S.impacts.splice(k, 1);
      }

      // 헐떡임 — 지칠수록 크고 빠르게 (부기와 함께 얼굴이 미세하게 움직인다)
      const t = performance.now() * 0.001;
      const pant = S.exprNow * Math.sin(t * (3.2 + S.exprNow * 3.0)) * width * 0.010;

      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        let x = basePos[i3], y = basePos[i3 + 1], z = basePos[i3 + 2];

        // 1) 표정
        x += exprOffsets[i3] * S.exprNow;
        y += exprOffsets[i3 + 1] * S.exprNow + pant * 0.35;
        z += exprOffsets[i3 + 2] * S.exprNow;

        // 2) 부기 — 법선 방향으로 살짝 부풀린다 (얼굴이 붓는다)
        if (S.swell > 1e-4) {
          const nx = geo.attributes.normal.array[i3];
          const ny = geo.attributes.normal.array[i3 + 1];
          const nz = geo.attributes.normal.array[i3 + 2];
          x += nx * S.swell; y += ny * S.swell; z += nz * S.swell;
        }

        // 3) 피격 자국 — 가우시안 감쇠로 눌린 자국. 스프링 되돌림 포함.
        for (let k = 0; k < S.impacts.length; k++) {
          const im = S.impacts[k];
          const ci = im.idx * 3;
          const dx = basePos[i3] - basePos[ci];
          const dy = basePos[i3 + 1] - basePos[ci + 1];
          const dz = basePos[i3 + 2] - basePos[ci + 2];
          const R = width * 0.34;
          const d2 = (dx * dx + dy * dy + dz * dz) / (R * R);
          if (d2 > 4) continue;
          const falloff = Math.exp(-d2 * 1.6);
          // 0 → 최대로 훅 들어갔다가 감쇠 진동하며 복귀
          const u = im.t / im.life;
          const env = Math.exp(-u * 4.2) * Math.cos(u * Math.PI * 2.4);
          z -= im.amp * falloff * env;          // 안쪽(-z)으로 눌림
          y -= im.amp * falloff * env * 0.25;
        }

        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      }

      geo.attributes.position.needsUpdate = true;
      // 법선은 매 프레임 다시 계산하면 비싸다. 변형이 있을 때만.
      if (S.impacts.length || S.swell > 1e-4 || S.exprNow > 1e-3) geo.computeVertexNormals();

      // 피격 직후 머리가 흔들린다
      mesh.rotation.z = Math.sin(t * 42) * S.shake * 0.09;
      mesh.rotation.x = Math.sin(t * 33) * S.shake * 0.05;

      // 코피 — 서서히 진해지고 아래로 흘러내린다
      bloodMat.opacity += (S.bloodAmt * 0.92 - bloodMat.opacity) * Math.min(1, dt * 1.5);
      blood.visible = bloodMat.opacity > 0.02;
      if (blood.visible) {
        blood.scale.y = 0.55 + S.bloodAmt * 0.95;
        blood.position.y = basePos[IDX.NOSE_BOTTOM * 3 + 1] - width * (0.10 + 0.10 * blood.scale.y);
      }
    }

    function dispose() {
      geo.dispose();
      mat.dispose();
      if (tex) tex.dispose();
      bloodMat.dispose();
      blood.geometry.dispose();
    }

    return { mesh, hit, setHp, update, dispose, state: S, triangleCount: index.length / 3 };
  };

  // ── 직렬화 (네트워크 전송용) ───────────────────────────────────────────
  /**
   * 랜드마크 + 사진을 네트워크로 보낼 수 있는 형태로 만든다.
   * 좌표는 소수 4자리로 자른다 — 468×3 을 그대로 보내면 JSON 이 3배로 부푼다.
   */
  window.serializeFace = function (landmarks, canvas, meta, quality) {
    const lm = new Array(landmarks.length * 3);
    for (let i = 0; i < landmarks.length; i++) {
      lm[i * 3]     = Math.round(landmarks[i].x * 10000) / 10000;
      lm[i * 3 + 1] = Math.round(landmarks[i].y * 10000) / 10000;
      lm[i * 3 + 2] = Math.round(landmarks[i].z * 10000) / 10000;
    }
    return {
      lm,
      tex: canvas.toDataURL('image/jpeg', quality || 0.72),
      aspect: (meta && meta.aspect) || 1,
      crop: (meta && meta.crop) || null,
      imageW: (meta && meta.imageW) || 1,
      imageH: (meta && meta.imageH) || 1,
    };
  };

  /** 수신한 blob 으로 3D 얼굴을 만든다. 텍스처 로드가 끝나야 하므로 Promise. */
  window.createFace3DFromBlob = function (blob, color, width) {
    return new Promise((resolve) => {
      if (!blob || !blob.lm || !blob.tex) { resolve(null); return; }
      const landmarks = [];
      for (let i = 0; i < blob.lm.length; i += 3) {
        landmarks.push({ x: blob.lm[i], y: blob.lm[i + 1], z: blob.lm[i + 2] });
      }
      const mk = (image) => window.createFace3D({
        landmarks, image, color, width,
        aspect: blob.aspect, crop: blob.crop, imageW: blob.imageW, imageH: blob.imageH,
      });
      const img = new Image();
      img.onload = () => resolve(mk(img));
      img.onerror = () => resolve(mk(null));
      img.src = blob.tex;
    });
  };

  window.FACE3D_IDX = IDX;
  window.__faceTrianglesFromEdges = trianglesFromEdges;   // 하니스 검증용
})();
