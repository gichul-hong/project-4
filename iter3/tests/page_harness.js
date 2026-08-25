/**
 * page_harness.js — 실제 브라우저로 페이지를 띄워 런타임 예외를 잡는다.
 *
 * 서버가 떠 있어야 한다:  python run_arena_server.py
 *   cd iter3/tests && node page_harness.js [베이스URL]
 *
 * 이 하니스가 따로 존재하는 이유:
 *   `const fx = window.createHitEffects(scene)` 가 animate() 안의 정면 벡터 `const fx` 에
 *   가려져 `fx.update is not a function` 이 매 프레임 터졌고, 그 지점이 renderer.render() 앞이라
 *   **1인칭 화면만 통째로 검은 화면**이 됐다. 이때 로직 하니스(pose/effects/aim/move)는 전부 통과했다.
 *   페이지를 진짜로 띄워보지 않으면 못 잡는 종류의 버그라 경로를 따로 둔다.
 */
const { open, sleep, isNoise } = require('./_cdp');
const BASE = process.argv[2] || 'https://localhost:8000';

let fail = 0;
const ck = (n, c, x) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? `  (${x})` : ''}`);
  if (!c) fail++;
};

(async () => {
  console.log('--- Fighter 1인칭 페이지 ---');
  const f = await open(`${BASE}/client?id=client_2`, { port: 9341, settle: 8000 });
  const st = await f.evaluate(`(() => {
    const c = document.querySelector('#first-person-ring canvas');
    const box = document.getElementById('first-person-ring');
    return {
      canvas: !!c, w: c ? c.width : 0, h: c ? c.height : 0,
      boxW: box ? box.clientWidth : 0, boxH: box ? box.clientHeight : 0,
      fps: parseInt(document.getElementById('fps-badge').innerText) || 0,
      animError: document.getElementById('anim-error').style.display,
      hud: document.getElementById('move-hud').innerText
    };
  })()`);
  const errs = f.logs.filter(l => l.kind === 'EXCEPTION');
  const targetLine = (String(st.hud).split('\n').find(l => l.startsWith('Target:')) || '').trim();

  ck('렌더 캔버스가 만들어진다', st.canvas);
  ck('캔버스 크기가 0이 아니다', st.w > 0 && st.h > 0, `${st.w}x${st.h}`);
  ck('컨테이너를 가득 채운다', st.w === st.boxW && st.h === st.boxH, `box ${st.boxW}x${st.boxH}`);
  ck('rAF 루프가 실제로 돈다 (FPS > 0)', st.fps > 0, `${st.fps} FPS`);
  ck('렌더 예외 배너가 뜨지 않는다', st.animError !== 'block');
  ck('런타임 예외 0건', errs.length === 0, errs.map(e => e.text).join(' / ') || 'none');
  ck('HUD에 Target 줄이 있다', /Target:/.test(st.hud));
  ck('혼자 접속이어도 타깃을 잡는다', /Target: P\d/.test(st.hud), targetLine);

  const noisy = f.logs.filter(l => !isNoise(l) && /error/i.test(l.kind));
  ck('예상치 못한 에러 로그 없음', noisy.length === 0, noisy.map(l => l.text).join(' / ') || 'none');
  f.close();
  await sleep(700);

  console.log('');
  console.log('--- Host 아레나 페이지 ---');
  const a = await open(`${BASE}/arena`, { port: 9342, settle: 7000, fakeMedia: false });
  const ast = await a.evaluate(`(() => ({
    canvas: !!document.querySelector('#arena-canvas canvas'),
    fps: parseInt(document.getElementById('stat-fps').innerText) || 0,
    clock: document.getElementById('round-clock').innerText,
    modal: document.getElementById('result-modal').style.display
  }))()`);
  const aerrs = a.logs.filter(l => l.kind === 'EXCEPTION');

  ck('렌더 캔버스가 만들어진다', ast.canvas);
  ck('rAF 루프가 실제로 돈다', ast.fps > 0, `${ast.fps} FPS`);
  ck('런타임 예외 0건', aerrs.length === 0, aerrs.map(e => e.text).join(' / ') || 'none');
  ck('시계가 mm:ss 경과 시간 형식', /^\d+:\d\d$/.test(ast.clock), ast.clock);
  ck('시작하자마자 결과창이 뜨지 않는다', ast.modal !== 'flex');
  a.close();

  console.log(fail === 0 ? '\n>>> 전부 통과' : `\n>>> ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('하니스 오류:', e && e.message); process.exit(1); });
