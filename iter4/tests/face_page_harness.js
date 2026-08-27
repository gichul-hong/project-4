/**
 * face_page_harness.js — 3D 얼굴이 실제 페이지에서 "보이는가"를 확인한다.
 *
 * 서버가 떠 있어야 한다:  python run_arena_server.py
 *   cd iter3/tests && node face_page_harness.js [베이스URL]
 *
 * 로직 하니스로는 못 잡는 두 가지를 본다.
 *   1) host(arena) 화면이 얼굴 패킷을 받아 실제로 아바타에 적용하는가
 *   2) 적용된 얼굴이 두개골 구에 파묻히지 않는가 — 실제 Face Mesh 토폴로지·비율 기준으로
 *
 * 실제로 겪은 버그: 얼굴이 구 안쪽에 배치돼 host·1인칭 양쪽에서 아무것도 보이지 않았다.
 */
const { open, sleep } = require('./_cdp');
// 머리 반지름은 humanoid.js 에서 읽는다 — 비율을 바꿔도 테스트가 따라오도록
const HEAD_R = Number(
  require('fs').readFileSync(require('path').join(__dirname, '../server/static/humanoid.js'), 'utf8')
    .match(/const HEAD_R = ([\d.]+)/)[1]);
const BASE = process.argv[2] || 'https://localhost:8000';   // 다른 하니스와 동일하게

let fail = 0;
const ck = (n, c, x) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? `  (${x})` : ''}`);
  if (!c) fail++;
};

/** 페이지 안에서 사람 얼굴 비슷한 468 랜드마크를 만들어 face blob 을 구성한다. */
const MAKE_BLOB = `(() => {
  const N = 468, AR = 480 / 360;
  const lm = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const ring = Math.sqrt(t);                 // 중앙이 촘촘한 분포
    const ang = Math.PI * (1 + Math.sqrt(5)) * i;
    const X = Math.cos(ang) * ring * 0.13;
    const Y = Math.sin(ang) * ring * 0.17;
    const Z = (0.055 * Math.cos(ring * Math.PI * 0.72) - 0.026);
    lm[i] = { x: 0.5 + X / AR, y: 0.5 - Y, z: Z / AR };
  }
  lm[234] = { x: 0.5 - 0.13 / AR, y: 0.5, z: 0 };     // 좌 광대
  lm[454] = { x: 0.5 + 0.13 / AR, y: 0.5, z: 0 };     // 우 광대
  lm[1]   = { x: 0.5, y: 0.505, z: -0.055 / AR };     // 코끝 (앞으로)
  lm[152] = { x: 0.5, y: 0.5 + 0.17, z: 0 };          // 턱
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c89a6b'; g.fillRect(0, 0, 64, 64);
  return window.serializeFace(lm, c, {
    aspect: AR, imageW: 480, imageH: 360,
    crop: { x0: 100, y0: 40, w: 220, h: 220 },
  }, 0.7);
})()`;

/** 얼굴 정점이 두개골 타원체 밖에 있는지 세는 코드 (페이지 안에서 실행) */
const CHECK_BURIED = (meshExpr) => `(() => {
  const h = ${meshExpr};
  const f = h && h.getFace && h.getFace();
  if (!f) return { applied: false };
  const pos = f.mesh.geometry.attributes.position.array;
  const dz = f.mesh.position.z;
  const fk = f.mesh.scale.x;                       // 머리 크기에 맞춘 스케일
  const R = ${HEAD_R}, sx = h.head.scale.x, sy = h.head.scale.y, sz = h.head.scale.z;
  let inside = 0, worst = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] * fk, y = pos[i + 1] * fk, z = pos[i + 2] * fk + dz;
    const e = (x/(R*sx))**2 + (y/(R*sy))**2 + (z/(R*sz))**2;
    if (e < 1) inside++;
    if (e < worst) worst = e;
  }
  return {
    applied: true, inside, worst, faceZ: dz,
    tris: f.triangleCount,
    fullHead: !!f.isFullHead,
    headVisible: h.head.visible,
    faceInScene: !!f.mesh.parent,
    faceVisible: f.mesh.visible !== false,
    skull: [sx, sy, sz],
  };
})()`;

(async () => {
  // ── Host (arena) ─────────────────────────────────────────────
  console.log('--- Host 관제 화면 ---');
  const a = await open(`${BASE}/arena`, { port: 9371, settle: 8000, fakeMedia: false });

  ck('face3d.js 가 로드된다', (await a.evaluate(`typeof window.createFace3D`)) === 'function');
  ck('Face Mesh 토폴로지가 있다', (await a.evaluate(
    `(typeof FACEMESH_TESSELATION !== 'undefined') ? FACEMESH_TESSELATION.length : 0`)) > 0);

  // 서버가 보낸 것처럼 얼굴 패킷을 주입한다
  await a.evaluate(`window.__blob = ${MAKE_BLOB}; socket.onmessage({ data: JSON.stringify({
    type: 'face_update', client_id: 'client_1', face: window.__blob }) }); true`);
  await sleep(1500);

  const hostRes = await a.evaluate(CHECK_BURIED(`fighterMeshes['client_1']`));
  ck('host 가 얼굴 패킷을 받아 아바타에 적용한다', hostRes.applied === true,
     hostRes.applied ? `${hostRes.tris} 삼각형` : '적용 안 됨');
  if (hostRes.applied) {
    ck('얼굴 메쉬가 씬에 붙어 있다', hostRes.faceInScene && hostRes.faceVisible);
    ck('얼굴 삼각형이 canonical 값 이상 (두개골 포함)', hostRes.tris > 852, `${hostRes.tris}`);
    if (hostRes.fullHead) {
      // 닫힌 머리에서는 구를 숨기므로 "구에 파묻힌다"는 개념 자체가 없다.
      // 대신 아래 '닫힌 머리' 절에서 깊이·정점 수를 본다.
      ck('닫힌 머리이므로 구 머리를 숨긴다', hostRes.headVisible === false);
    } else {
      ck('(폴백) 두개골 구에 파묻히지 않는다', hostRes.inside === 0,
         `${hostRes.inside}개 박힘 · 최소비율 ${hostRes.worst.toFixed(2)}`);
      ck('(폴백) 두개골 구는 남아 있다', hostRes.headVisible === true);
    }
  }

  console.log('');
  console.log('--- 닫힌 머리 (앞·옆·뒤 어디서 봐도 사람) ---');
  const head = await a.evaluate(`(() => {
    const h = fighterMeshes['client_1'];
    const f = h.getFace();
    if (!f) return { none: true };
    const pos = f.mesh.geometry.attributes.position.array;
    let zMin = Infinity, zMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 2] < zMin) zMin = pos[i + 2];
      if (pos[i + 2] > zMax) zMax = pos[i + 2];
      if (pos[i] < xMin) xMin = pos[i];
      if (pos[i] > xMax) xMax = pos[i];
    }
    return {
      isFullHead: f.isFullHead,
      tris: f.triangleCount,
      depth: zMax - zMin, width: xMax - xMin,
      skullHidden: h.head.visible === false,
      jawHidden: h.jaw ? h.jaw.visible === false : null,
      side: f.mesh.material.side,
      verts: pos.length / 3,
    };
  })()`);
  ck('뒤통수까지 닫힌 머리로 만들어진다', head.isFullHead === true);
  ck('얼굴(468)보다 정점이 많다 (두개골이 붙었다)', head.verts > 468, `${head.verts}개`);
  ck('머리 깊이가 폭의 절반 이상 (판자가 아니다)', head.depth > head.width * 0.5,
     `깊이 ${head.depth.toFixed(2)} / 폭 ${head.width.toFixed(2)}`);
  ck('구 머리를 숨긴다 (겹치지 않는다)', head.skullHidden === true);
  ck('턱 덩어리도 숨긴다', head.jawHidden === true);
  ck('앞면만 렌더한다 (안쪽이 비치지 않게)', head.side === 0, `side=${head.side}`);

  // ── 두개골: 바깥을 향하는가 · 사람 비율인가 ────────────────────────
  //
  // 실제로 겪은 버그: 두개골 삼각형 468개 중 450개가 **안쪽**을 향했고,
  // 재질이 FrontSide 라 뒤통수가 통째로 안 그려졌다. 뒤통수가 없었던 게 아니라
  // 있는데 투명했다. fixWinding 이 법선의 **z 성분**으로 판단하는데 뒤통수는
  // 법선이 -z 라 그 기준을 쓰면 반드시 뒤집힌다.
  //
  // 또 FACE_OVAL 의 맨 위는 이마 **헤어라인**이라, 뒤로만 쓸어 넘기면 정수리가
  // 통째로 없는 납작한 머리가 된다(높이/폭 0.97 — 사람은 약 1.25).
  const SKULL = `(() => {
    const N = 468, AR = 480 / 360;
    const lm = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, r = 0.16 + 0.05 * Math.sin(i * 2.7);
      lm[i] = { x: 0.5 + Math.cos(a) * r * 0.78, y: 0.5 + Math.sin(a) * r, z: -0.05 * Math.cos(a) };
    }
    const OV = (typeof FACEMESH_FACE_OVAL !== 'undefined') ? FACEMESH_FACE_OVAL : null;
    if (OV) {
      const seen = new Set();
      OV.forEach(e => { seen.add(e[0]); seen.add(e[1]); });
      const ids = [...seen];
      ids.forEach((id, k) => {
        const a = k / ids.length * Math.PI * 2;
        lm[id] = { x: 0.5 + Math.cos(a) * 0.20, y: 0.5 + Math.sin(a) * 0.26, z: 0.02 };
      });
    }
    const f = window.createFace3D({ landmarks: lm, image: null, width: 2.6, aspect: AR });
    if (!f) return JSON.stringify({ err: 'null' });

    const g = f.mesh.geometry;
    const pos = g.attributes.position.array;
    const idx = g.index.array || g.index;
    const nv = pos.length / 3;

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < nv; i++) { cx += pos[i*3]; cy += pos[i*3+1]; cz += pos[i*3+2]; }
    cx /= nv; cy /= nv; cz /= nv;

    // 두개골 삼각형 = 세 정점이 모두 얼굴(468) 뒤에 추가된 것
    let cranOut = 0, cranIn = 0, degen = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const i = idx[t], j = idx[t+1], k = idx[t+2];
      if (i < N || j < N || k < N) continue;
      const ax = pos[i*3], ay = pos[i*3+1], az = pos[i*3+2];
      const bx = pos[j*3], by = pos[j*3+1], bz = pos[j*3+2];
      const kx = pos[k*3], ky = pos[k*3+1], kz = pos[k*3+2];
      const ux = bx-ax, uy = by-ay, uz = bz-az;
      const vx = kx-ax, vy = ky-ay, vz = kz-az;
      const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      if (Math.hypot(nx, ny, nz) < 1e-9) { degen++; continue; }
      const gx = (ax+bx+kx)/3 - cx, gy = (ay+by+ky)/3 - cy, gz = (az+bz+kz)/3 - cz;
      if (nx*gx + ny*gy + nz*gz > 0) cranOut++; else cranIn++;
    }

    let zMin = 1e9, zMax = -1e9, yMin = 1e9, yMax = -1e9;
    for (let i = 0; i < nv; i++) {
      const z = pos[i*3+2], y = pos[i*3+1];
      if (z < zMin) zMin = z; if (z > zMax) zMax = z;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = f.bounds.xMax - f.bounds.xMin;

    // 정수리가 뒤통수 극점보다 앞에 있는가 (뒤로 뾰족한 원뿔이 아닌가)
    let topY = -1e9, topZ = 0, backZ = 1e9;
    for (let i = 0; i < nv; i++) {
      if (pos[i*3+1] > topY) { topY = pos[i*3+1]; topZ = pos[i*3+2]; }
      if (pos[i*3+2] < backZ) backZ = pos[i*3+2];
    }

    return JSON.stringify({
      cranOut, cranIn, degen,
      depthRatio: +((zMax - zMin) / w).toFixed(2),
      heightRatio: +((yMax - yMin) / w).toFixed(2),
      crownAheadOfBack: +(topZ - backZ).toFixed(2),
      faceBounds: !!f.faceBounds,
      faceShorter: f.faceBounds ? (f.faceBounds.yMax - f.faceBounds.yMin) < (yMax - yMin) : false,
    });
  })()`;

  const sk = JSON.parse(await a.evaluate(SKULL));
  ck('두개골 삼각형이 전부 바깥을 향한다 (뒤통수가 투명하지 않다)',
     sk.cranIn === 0 && sk.cranOut > 100, `바깥 ${sk.cranOut} / 안쪽 ${sk.cranIn}`);
  ck('면적 0 인 삼각형이 없다 (링이 극점으로 붕괴하지 않는다)',
     sk.degen === 0, `${sk.degen}개`);
  ck('머리 깊이가 폭과 비슷하다 (판자가 아니다)',
     sk.depthRatio >= 0.85, `깊이/폭 ${sk.depthRatio}`);
  ck('정수리가 있다 (납작하지 않다)',
     sk.heightRatio >= 1.15, `높이/폭 ${sk.heightRatio}`);
  ck('정수리가 뒤통수보다 앞에 있다 (뒤로 뾰족하지 않다)',
     sk.crownAheadOfBack > 0.2, `${sk.crownAheadOfBack}`);
  ck('얼굴만의 바운딩을 따로 제공한다 (정렬 기준)',
     sk.faceBounds && sk.faceShorter);

  // ── 3장 촬영 (정면 + 좌우 옆모습) ──────────────────────────────────
  //
  // 정면 1장이면 뒤통수·관자놀이에 붙일 픽셀이 아예 없어 이마 위 머리카락을 늘여 붙이게 되고,
  // 그래서 모자를 쓴 것처럼 보인다. 옆모습에는 그 픽셀이 실제로 찍혀 있다.
  //
  // 여기서는 옆모습 랜드마크를 **정면을 좌우로 회전시킨 것**으로 합성해,
  // 두개골 UV 가 실제로 옆면 칸(아틀라스의 오른쪽 절반)을 물는지 확인한다.
  const MULTIVIEW = `(() => {
    const N = 468, AR = 480 / 360;
    // 정면 랜드마크
    const front = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, r = 0.16 + 0.05 * Math.sin(i * 2.7);
      front[i] = { x: 0.5 + Math.cos(a) * r * 0.78, y: 0.5 + Math.sin(a) * r, z: -0.05 * Math.cos(a) };
    }
    const OV = (typeof FACEMESH_FACE_OVAL !== 'undefined') ? FACEMESH_FACE_OVAL : null;
    if (OV) {
      const seen = new Set();
      OV.forEach(e => { seen.add(e[0]); seen.add(e[1]); });
      [...seen].forEach((id, k, arr) => {
        const a = k / arr.length * Math.PI * 2;
        front[id] = { x: 0.5 + Math.cos(a) * 0.20, y: 0.5 + Math.sin(a) * 0.26, z: 0.02 };
      });
    }
    /** 정면을 y축으로 ang 만큼 돌린 "옆모습" 랜드마크 */
    function turned(ang) {
      const c = Math.cos(ang), s = Math.sin(ang);
      return front.map(q => {
        const x = q.x - 0.5, z = q.z;
        return { x: 0.5 + (x * c + z * s), y: q.y, z: (-x * s + z * c) };
      });
    }
    const negLm = turned(-0.9), posLm = turned(0.9);

    const atlas = {
      front:   { x: 0,    y: 0,   w: 0.5,  h: 1    },
      sideNeg: { x: 0.5,  y: 0,   w: 0.25, h: 0.5  },
      sidePos: { x: 0.5,  y: 0.5, w: 0.25, h: 0.5  },
    };
    const full = { x0: 0, y0: 0, w: 1, h: 1 };
    const f = window.createFace3D({
      landmarks: front, uvLandmarks: front, image: null, width: 2.6, aspect: AR,
      crop: full, imageW: 1, imageH: 1,
      atlas,
      sideViews: {
        neg: { lm: negLm, crop: full, imageW: 1, imageH: 1 },
        pos: { lm: posLm, crop: full, imageW: 1, imageH: 1 },
      },
    });
    if (!f) return JSON.stringify({ err: 'null' });

    const g = f.mesh.geometry;
    const uv = g.attributes.uv.array;
    const nv = g.attributes.position.array.length / 3;

    // 앞면 정점의 UV 는 front 칸(u < 0.5) 안에 있어야 한다
    let faceIn = 0, faceOut = 0;
    for (let i = 0; i < N; i++) {
      if (uv[i*2] <= 0.5 + 1e-6) faceIn++; else faceOut++;
    }
    // 두개골 정점 중 옆면 칸(u > 0.5)을 무는 것이 얼마나 되나
    let cranSide = 0, cranFront = 0;
    for (let i = N; i < nv; i++) {
      if (uv[i*2] > 0.5) cranSide++; else cranFront++;
    }
    // UV 가 전부 [0,1] 안인가 (밖이면 텍스처가 반복돼 얼룩이 된다)
    let outOfRange = 0;
    for (let i = 0; i < nv; i++) {
      const u = uv[i*2], v = uv[i*2+1];
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) outOfRange++;
    }
    return JSON.stringify({ faceIn, faceOut, cranSide, cranFront, outOfRange, nv });
  })()`;

  const mv = JSON.parse(await a.evaluate(MULTIVIEW));
  ck('3장 촬영에서도 얼굴이 만들어진다', !mv.err, mv.err || `정점 ${mv.nv}`);
  ck('앞면 UV 가 아틀라스 front 칸 안에 있다', mv.faceOut === 0,
     `안 ${mv.faceIn} / 밖 ${mv.faceOut}`);
  // 옆사진이 실제로 담고 있는 범위(SIDE_MAX_T)까지만 쓴다 — 그보다 뒤는 어느 사진에도
  // 없으므로 머리카락색으로 채운다. 그래서 "대부분"이 아니라 "관자놀이·귀 밴드"만 옆면이다.
  ck('두개골 앞쪽 밴드가 옆모습 픽셀을 쓴다',
     mv.cranSide >= 30, `옆면 ${mv.cranSide} / 앞면 ${mv.cranFront}`);
  ck('UV 가 텍스처 밖으로 나가지 않는다', mv.outOfRange === 0, `${mv.outOfRange}개`);

  // face_bulk (나중에 접속한 host 가 기존 얼굴들을 한 번에 받는 경로)
  await a.evaluate(`socket.onmessage({ data: JSON.stringify({
    type: 'face_bulk', faces: { client_3: window.__blob } }) }); true`);
  await sleep(1200);
  const bulk = await a.evaluate(CHECK_BURIED(`fighterMeshes['client_3']`));
  ck('face_bulk 로 받은 얼굴도 적용된다', bulk.applied === true);

  // HP 를 낮추면 얼굴 표정이 따라가는가
  const expr = await a.evaluate(`(() => {
    const f = fighterMeshes['client_1'].getFace();
    if (!f) return null;
    const before = f.state.bloodAmt;
    socket.onmessage({ data: JSON.stringify({ fighters: {
      client_1: { name:'x', hp: 12, world_x:-12, world_z:0, yaw:0 },
      client_2: { name:'x', hp: 100, world_x:12, world_z:0, yaw:0 },
      client_3: { name:'x', hp: 100, world_x:0, world_z:-12, yaw:0 },
      client_4: { name:'x', hp: 100, world_x:0, world_z:12, yaw:0 } } }) });
    return { before, after: f.state.bloodAmt, hp: f.state.hp };
  })()`);
  ck('HP 가 얼굴에 전달된다 (코피)',
     expr && expr.after > 0.8 && expr.before === 0,
     expr ? `bloodAmt ${expr.before} → ${Number(expr.after).toFixed(2)}` : '얼굴 없음');

  const aerrs = a.logs.filter(l => l.kind === 'EXCEPTION');
  ck('런타임 예외 0건', aerrs.length === 0, aerrs.map(e => e.text).join(' | ') || 'none');
  a.close();
  await sleep(700);

  // ── Fighter (1인칭) ──────────────────────────────────────────
  console.log('');
  console.log('--- Fighter 1인칭 화면 ---');
  const f = await open(`${BASE}/client?id=client_2`, { port: 9372, settle: 9000 });

  await f.evaluate(`window.__blob = ${MAKE_BLOB}; socket.onmessage({ data: JSON.stringify({
    type: 'face_update', client_id: 'client_1', face: window.__blob }) }); true`);
  await sleep(1500);

  const cliRes = await f.evaluate(CHECK_BURIED(`opponentMeshes['client_1']`));
  ck('상대 아바타에 얼굴이 적용된다', cliRes.applied === true,
     cliRes.applied ? `${cliRes.tris} 삼각형` : '적용 안 됨');
  if (cliRes.applied) {
    if (cliRes.fullHead) {
      ck('1인칭에서도 닫힌 머리로 적용된다', cliRes.headVisible === false);
    } else {
      ck('(폴백) 두개골 구에 파묻히지 않는다', cliRes.inside === 0,
         `${cliRes.inside}개 박힘 · 최소비율 ${cliRes.worst.toFixed(2)}`);
      ck('(폴백) 얼굴이 두개골 앞쪽에 놓인다', cliRes.faceZ > 0, cliRes.faceZ.toFixed(2));
    }
  }

  const ferrs = f.logs.filter(l => l.kind === 'EXCEPTION');
  ck('런타임 예외 0건', ferrs.length === 0, ferrs.map(e => e.text).join(' | ') || 'none');
  f.close();

  console.log(fail === 0 ? '\n>>> 전부 통과' : `\n>>> ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('하니스 오류:', e && e.message); process.exit(1); });
