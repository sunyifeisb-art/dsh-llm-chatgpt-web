/**
 * 流式状态探针：发一条会持续生成较久的提示词，边发边采样页面指示器，
 * 用来搞清 2026-10 改版后「还在生成 / 已完成」怎么判断。
 *   node scripts/probe-stream.mjs
 */

import { ChatGptBrowser } from '../lib/browser.js';
import { createLog } from '../lib/log.js';
import { CdpConnection, httpJson } from '../lib/cdp.js';

const settings = {
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  userDataDir: '~/.dsh/chatgpt-web/chrome-profile',
  debuggingPort: 9333,
  logDir: '~/.dsh/chatgpt-web/logs',
  temporaryChat: true,
  reasoningEffort: 'high',
  webModel: '',
  startupTimeoutMs: 30000,
  composerTimeoutMs: 45000,
  navigateTimeoutMs: 45000,
  responseTimeoutMs: 600000,
  idleFinishMs: 6000,
  pollIntervalMs: 300,
};

const SAMPLER = `(() => {
  const buttons = [...document.querySelectorAll('button,[role="button"]')].map((b) => ({
    label: (b.getAttribute('aria-label') || '').slice(0, 30),
    testid: b.getAttribute('data-testid') || '',
    disabled: b.disabled === true,
    text: (b.textContent || '').trim().slice(0, 20),
  })).filter((b) => b.label || b.testid || b.text);
  const roots = [...document.querySelectorAll('[class*="MarkdownRoot"]')];
  const last = roots.length > 0 ? roots[roots.length - 1] : null;
  const body = (document.body.innerText || '');
  const markers = ['停止', 'Stop', '回答已完成', '正在', '思考', 'Thinking', '生成中'];
  return JSON.stringify({
    streamingMarkers: markers.filter((m) => body.includes(m)),
    markdownCount: roots.length,
    lastLen: last ? (last.innerText || '').length : 0,
    lastTail: last ? (last.innerText || '').slice(-60) : '',
    stopish: buttons.filter((b) => /stop|停止/i.test(b.label + b.testid)),
    sendish: buttons.filter((b) => /send|发送/i.test(b.label + b.testid)).map((b) => b.disabled),
    regenerate: buttons.filter((b) => /regen|重新生成/i.test(b.label + b.testid)).map((b) => b.label),
    copy: buttons.filter((b) => /copy|复制/i.test(b.label + b.testid)).length,
    svgIcons: [...document.querySelectorAll('form button svg, form [data-testid] svg')].length,
  });
})()`;

const log = createLog({ dir: settings.logDir });
const browser = new ChatGptBrowser(settings, log);

const list = await httpJson('http://127.0.0.1:9333/json/list');
const pages = (list ?? []).filter((t) => t.type === 'page' && String(t.url).includes('chatgpt.com'));
if (pages.length === 0) {
  console.error('没有 chatgpt.com 页面');
  process.exit(1);
}
const cdp = await CdpConnection.attach(pages[pages.length - 1].webSocketDebuggerUrl);

const prompt =
  '请从 1 数到 60，每个数字单独一行，逐行慢慢输出，不要省略。';

const iterate = browser.ask(prompt, { timeoutMs: 60000, pollIntervalMs: 200 });
let done = false;
const samples = [];

const sampler = (async () => {
  while (!done) {
    const t = Date.now();
    const res = await cdp.send('Runtime.evaluate', { expression: SAMPLER, returnByValue: true }).catch(() => null);
    const value = res?.result?.value;
    samples.push({ t, value });
    await new Promise((r) => setTimeout(r, 400));
  }
})();

try {
  let last = '';
  for await (const snapshot of iterate) {
    if (snapshot.text !== last) {
      last = snapshot.text;
      console.log(`chars=${last.length} tail=${JSON.stringify(last.slice(-40))}`);
    }
  }
  console.log('--- browser.ask finished at', new Date().toISOString());
} catch (error) {
  console.error('ask failed:', error?.code, error?.message);
} finally {
  done = true;
  await sampler;
  console.log('--- samples ---');
  for (const sample of samples) {
    console.log(new Date(sample.t).toISOString().slice(17, 23), sample.value);
  }
  await cdp.close?.();
  process.exit(0);
}
