/**
 * record_replay_video.js — movement_replay.html(3D 아바타 리플레이 페이지)을 헤드리스
 * Chrome으로 실제 재생시키고, CDP Page.startScreencast로 렌더링되는 그대로 화면을 녹화해
 * mp4 파일로 만든다.
 *
 * tests/_cdp.js 는 evaluate()/screenshot() 한 장만 지원해서, 여기서는 스크린캐스트
 * 이벤트 구독이 필요해 직접 WebSocket을 붙인다 (launch 인자는 _cdp.js와 동일하게 맞춤).
 *
 * Usage:
 *   node eval/record_replay_video.js --url http://localhost:8010/movement_replay \
 *     --engine v2 --out eval/output/movement_avatar_v2.mp4
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
function findBrowser() {
  const hit = BROWSERS.find(p => fs.existsSync(p));
  if (!hit) throw new Error('Chrome/Edge를 찾지 못했습니다.');
  return hit;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { url: 'http://localhost:8010/movement_replay', engine: 'v2', out: 'eval/output/movement_avatar.mp4', maxSeconds: 200 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--url') out.url = a[++i];
    else if (a[i] === '--engine') out.engine = a[++i];
    else if (a[i] === '--out') out.out = a[++i];
    else if (a[i] === '--max-seconds') out.maxSeconds = parseFloat(a[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay_frames_'));
  console.log(`프레임 임시 저장 위치: ${frameDir}`);

  const port = 9333 + Math.floor(Math.random() * 500);
  const chromeArgs = [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--ignore-certificate-errors', '--allow-insecure-localhost',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1280,760', '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
  ];
  const proc = spawn(findBrowser(), chromeArgs, { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.length) break;
    } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  if (!targets || !targets.length) { proc.kill(); throw new Error('브라우저 CDP 연결 실패'); }

  const pageTarget = targets.find(t => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  let frameCount = 0;
  let firstTs = null, lastTs = null;
  const frameLog = []; // { file, dt }
  let screencastSessionActive = false;

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Page.screencastFrame') {
      const { data, sessionId, metadata } = m.params;
      frameCount++;
      const ts = metadata && metadata.timestamp ? metadata.timestamp : (Date.now() / 1000);
      if (firstTs === null) firstTs = ts;
      const dt = lastTs === null ? (1 / 30) : Math.max(0.008, ts - lastTs);
      lastTs = ts;
      const file = path.join(frameDir, `f_${String(frameCount).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frameLog.push({ file, dt });
      // 다음 프레임을 계속 받으려면 반드시 ack 해야 한다.
      send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  };

  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: args.url });
  await sleep(3000); // 리소스(랜드마크/리포트 JSON) 로딩 대기

  // 엔진 선택 + 재생 시작 (버튼 클릭 대신 직접 video.play() — 헤드리스에서 더 안정적)
  await send('Runtime.evaluate', {
    expression: `
      (function(){
        const sel = document.getElementById('engine-select');
        sel.value = ${JSON.stringify(args.engine)};
        sel.dispatchEvent(new Event('change'));
        return true;
      })();
    `,
  });
  await sleep(300);

  const durationResult = await send('Runtime.evaluate', {
    expression: `document.getElementById('video-element').duration`,
    returnByValue: true,
  });
  const videoDuration = (durationResult.result && durationResult.result.value) || args.maxSeconds;
  console.log(`영상 길이: ${videoDuration.toFixed(1)}s`);

  // 스크린캐스트 시작 → 재생 시작 (순서 중요: 캐스트를 먼저 열어야 시작 프레임을 놓치지 않는다)
  await send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  screencastSessionActive = true;
  await send('Runtime.evaluate', { expression: `document.getElementById('video-element').play()` });

  const waitSeconds = Math.min(videoDuration + 2, args.maxSeconds);
  console.log(`재생 녹화 중... 약 ${waitSeconds.toFixed(0)}초 대기`);
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < waitSeconds) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression: `document.getElementById('video-element').ended`, returnByValue: true,
    });
    if (r.result && r.result.value === true) break;
  }

  await send('Page.stopScreencast');
  screencastSessionActive = false;
  await sleep(300);
  ws.close();
  proc.kill();

  console.log(`캡처된 프레임 수: ${frameCount}`);
  if (frameCount === 0) throw new Error('프레임이 하나도 캡처되지 않았습니다.');

  // ffmpeg concat demuxer용 리스트 파일 작성 (프레임별 실제 간격 반영)
  const listPath = path.join(frameDir, 'list.txt');
  const lines = [];
  for (const f of frameLog) {
    lines.push(`file '${f.file.replace(/\\/g, '/')}'`);
    lines.push(`duration ${f.dt.toFixed(4)}`);
  }
  // ffmpeg concat 특성상 마지막 파일은 duration 없이 한 번 더 반복해야 프레임이 안 잘린다.
  lines.push(`file '${frameLog[frameLog.length - 1].file.replace(/\\/g, '/')}'`);
  fs.writeFileSync(listPath, lines.join('\n'), 'utf-8');

  console.log('ffmpeg로 영상 인코딩 중...');
  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',  // libx264는 짝수 폭/높이만 허용 — 캡처 해상도가 홀수일 수 있음
    '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'fast',
    outPath,
  ], { stdio: 'inherit' });

  console.log(`완료: ${outPath}`);
  fs.rmSync(frameDir, { recursive: true, force: true });
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
