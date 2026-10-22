/**
 * 开发期探针（不依赖 DSH 运行时，直接用 node 跑）：
 *   node scripts/dev-probe.mjs status           # 启浏览器 + 打开对话页 + 打印状态 + 截图
 *   node scripts/dev-probe.mjs login            # 打开登录页（人工登录一次）
 *   node scripts/dev-probe.mjs ask "你好"        # 完整发一条并读回复（需要已登录）
 *
 * 这个脚本和插件共用同一套 lib/，用来在没有登录态时先验证浏览器/选择器链路。
 */

import { ChatGptBrowser } from '../lib/browser.js';
import { createLog } from '../lib/log.js';

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

const log = createLog({ dir: settings.logDir });
const browser = new ChatGptBrowser(settings, log);
const command = process.argv[2] ?? 'status';

async function main() {
  if (command === 'login') {
    await browser.ensureChrome();
    await browser.openLogin();
    console.log('已打开 ChatGPT 登录页，请在 Chrome 窗口里登录。');
    return;
  }

  if (command === 'ask') {
    const prompt = process.argv.slice(3).join(' ') || '用一句话回答：你是谁？';
    let last = '';
    for await (const snapshot of browser.ask(prompt, { timeoutMs: settings.responseTimeoutMs, pollIntervalMs: settings.pollIntervalMs })) {
      last = snapshot.text;
    }
    console.log('--- 回复 ---');
    console.log(last);
    return;
  }

  await browser.ensureChrome();
  const status = await browser.openChat();
  console.log('status =', JSON.stringify(status, null, 2));
  await browser.screenshot('probe');
  console.log('log =', log.file);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('probe failed:', error?.code ?? '', error?.message ?? error);
    process.exit(1);
  });
