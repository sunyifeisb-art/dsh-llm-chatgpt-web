/**
 * 真实链路自测（需要已登录的插件 Chrome 正在运行；不会启动新浏览器）：
 *   node scripts/test-prompt-live.mjs
 *
 * 用「像 DSH 真实会话那样脏」的 messages 走一遍 buildPrompt → 浏览器发送 → parseReply，
 * 验证两件事：
 *   1) 海量 system-reminder / 技能目录不会再淹掉用户任务（回复应当直接答任务）；
 *   2) 模型能按 @@TOOL@@ 协议产出工具调用。
 */

import { ChatGptBrowser } from '../lib/browser.js';
import { createLog } from '../lib/log.js';
import { TOOL_MARKER, buildPrompt, parseReply } from '../lib/transcript.js';

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
  noResponseTimeoutMs: 120000,
  pollIntervalMs: 300,
};

const settingsExtra = { ...settings, maxPromptChars: 8000 };

function noisyMessages(task) {
  const catalog = Array.from({ length: 60 }, (_, i) => `- 技能${i}：这是第 ${i} 个技能的说明，用于演示体积很大的技能目录。`).join('\n');
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n<available-skills>\n${catalog}\n</available-skills>\n</system-reminder>` }],
    },
    { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 3: 2026-10-21T23:40:00+08:00\nBrowser time zone for this request: Asia/Shanghai.' }] },
    { role: 'assistant', content: [{ type: 'text', text: '这是上一轮助手的回复。' }] },
    { role: 'user', content: [{ type: 'text', text: task }] },
  ];
}

const tools = [
  {
    name: 'bash',
    description: '运行 shell 命令并返回 stdout/stderr。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

const log = createLog({ dir: settings.logDir });
const browser = new ChatGptBrowser(settings, log);

async function ask(prompt) {
  let last = '';
  for await (const snapshot of browser.ask(prompt, { timeoutMs: settings.responseTimeoutMs, pollIntervalMs: settings.pollIntervalMs })) {
    last = snapshot.text;
  }
  return last;
}

async function main() {
  // 1) 普通回答：任务不能被技能目录淹没
  const task1 = '现在只回答一件小事：把下面三个数加起来，只输出结果数字：17、25、8。';
  const prompt1 = buildPrompt({ system: '你是助手。', messages: noisyMessages(task1), tools, toolEmulation: true, maxChars: settingsExtra.maxPromptChars });
  console.log(`[1] promptChars=${prompt1.length}`);
  const reply1 = await ask(prompt1);
  const parsed1 = parseReply(reply1);
  console.log('[1] reply =', JSON.stringify(reply1.slice(0, 400)));
  console.log('[1] toolCalls =', parsed1.toolCalls.length);

  // 2) 工具调用协议
  const task2 = '用 bash 工具执行 `echo hello-from-web`，拿到结果后再告诉我。现在先发出工具调用。';
  const prompt2 = buildPrompt({ system: '你是助手。', messages: noisyMessages(task2), tools, toolEmulation: true, maxChars: settingsExtra.maxPromptChars });
  console.log(`[2] promptChars=${prompt2.length}`);
  const reply2 = await ask(prompt2);
  const parsed2 = parseReply(reply2);
  console.log('[2] reply =', JSON.stringify(reply2.slice(0, 400)));
  console.log('[2] toolCalls =', JSON.stringify(parsed2.toolCalls));

  // 3) 截断边界：直接发一条 ~8500 字符的原始提示词，验证网页端不会把它截断
  const filler = '背景占位说明。'.repeat(900);
  const raw = `以下是背景资料，全部读完但先不要回答：\n${filler}\n\n背景资料结束。请只回答一行：结尾标记是 TAIL-12345。`;
  console.log(`[3] raw promptChars=${raw.length}`);
  const reply3 = await ask(raw);
  const userLen = await browser
    .ensurePage()
    .then((connection) =>
      connection.evaluate(
        `(() => { const nodes = [...document.querySelectorAll('[class*="user-message"]')]; const last = nodes[nodes.length - 1]; return last ? (last.innerText || '').length : -1; })()`,
      ),
    )
    .catch(() => -1);
  console.log(`[3] reply = ${JSON.stringify(reply3.slice(0, 200))}`);
  console.log(`[3] page user-message chars=${userLen} (rawChars=${raw.length})`);
  const notTruncated = Math.abs(userLen - raw.length) < raw.length * 0.05 && /TAIL-12345/.test(reply3);

  const ok =
    /50/.test(parsed1.text) &&
    parsed2.toolCalls.length === 1 &&
    parsed2.toolCalls[0].name === 'bash' &&
    prompt1.length <= 8000 &&
    prompt2.length <= 8000 &&
    notTruncated;
  console.log(ok ? 'LIVE OK ✓' : 'LIVE CHECK FAILED ✗');
  if (!ok) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('live probe failed:', error?.code ?? '', error?.message ?? error);
    process.exit(1);
  });
