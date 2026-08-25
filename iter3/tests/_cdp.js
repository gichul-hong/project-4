/**
 * _cdp.js — 헤드리스 Chrome/Edge 를 띄우고 CDP 로 붙는 최소 헬퍼.
 *
 * 앞의 하니스들(pose/effects/aim/move)은 THREE 스텁 위에서 순수 로직만 본다.
 * 그것만으로는 "페이지가 실제로 그려지는가"를 못 잡는다 — 실제로 `fx` 이름 충돌로
 * animate()가 매 프레임 예외를 던져 1인칭 화면이 통째로 검은 화면이 된 적이 있는데,
 * 스텁 하니스는 전부 통과했었다. 그래서 진짜 브라우저로 띄우는 경로를 따로 둔다.
 *
 * 외부 의존성 없음 — Node 22의 내장 fetch/WebSocket 만 쓴다.
 */
const { spawn } = require('child_process');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  const fs = require('fs');
  const hit = BROWSERS.find(p => fs.existsSync(p));
  if (!hit) throw new Error('Chrome/Edge 를 찾지 못했습니다. BROWSERS 경로를 확인하세요.');
  return hit;
}

/**
 * 헤드리스 브라우저를 띄우고 CDP 세션을 연다.
 * @returns {{ evaluate, logs, close }}
 *   evaluate(expr) — 페이지 안에서 식을 평가해 값을 반환 (예외는 { ERROR } 로)
 *   logs           — 수집된 콘솔/예외 배열 (참조를 그대로 들고 있으면 계속 쌓인다)
 */
async function open(url, { port = 9333, fakeMedia = true, settle = 6000 } = {}) {
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`,
    '--ignore-certificate-errors', '--allow-insecure-localhost',
    // WebGL 을 소프트웨어로 — CI/원격 데스크톱에도 GPU가 없을 수 있다
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1280,800', '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
  ];
  if (fakeMedia) args.splice(3, 0, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');

  const proc = spawn(findBrowser(), args, { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.length) break;
    } catch (e) { /* 아직 안 떴다 */ }
    await sleep(300);
  }
  if (!targets || !targets.length) { proc.kill(); throw new Error('브라우저 CDP 연결 실패'); }

  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      logs.push({ kind: 'EXCEPTION', text: String(desc).split('\n').slice(0, 3).join(' | ') });
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
      logs.push({ kind: m.params.type.toUpperCase(), text: String(t).slice(0, 300) });
    } else if (m.method === 'Log.entryAdded') {
      logs.push({ kind: 'LOG:' + m.params.entry.level, text: String(m.params.entry.text).slice(0, 300) });
    }
  };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(settle);

  return {
    logs,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        return { ERROR: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
      }
      return r.result.value;
    },
    close() { try { ws.close(); } catch (e) {} proc.kill(); },
  };
}

/** 무시해도 되는 잡음 (자체서명 인증서 경고, favicon 404, WebGL 드라이버 메시지 등) */
function isNoise(l) {
  return /valid SSL certificate|favicon|GL Driver Message|gl_context|Successfully created a WebGL|OpenGL error checking|swiftshader|slot_in_use/i.test(l.text);
}

module.exports = { open, sleep, isNoise, findBrowser };
