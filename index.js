/**
 * dsh-llm-chatgpt-web — 把 ChatGPT 网页端接成 DeepSeek Harness 的一个模型路由。
 *
 * 关键点：
 *   - 走的是 ChatGPT 网页会话（网页额度），不是 OpenAI API key，也不是 Codex 额度；
 *   - 实现方式是本地起一个独占的 Chrome，用 CDP 打开 chatgpt.com、输入、发送、读回复；
 *   - 首次使用需要在这个浏览器窗口里登录一次 ChatGPT，登录态保存在插件自己的 profile 里；
 *   - 网页版没有 function calling，插件用一行 @@TOOL@@ 文本协议模拟工具调用。
 */

import z from '@deepseek-ai/schemastery';

import { ChatGptWebAdapter } from './lib/adapter.js';
import { createLog } from './lib/log.js';

export const name = 'llm-chatgpt-web';
export const inject = ['llm'];

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const Config = z.object({
  provider: z.string().default('chatgpt-web'),
  displayName: z.string().default('ChatGPT 网页版'),
  /** web = 真实浏览器驱动；fake = 不联网的自检流 */
  transport: z.string().default('web'),
  chromePath: z.string().default(DEFAULT_CHROME),
  userDataDir: z.string().default('~/.dsh/chatgpt-web/chrome-profile'),
  debuggingPort: z.number().default(9333),
  /** 浏览器窗口形态：visible=正常窗口；hidden=窗口移到屏幕外；headless=完全无窗口 */
  windowMode: z.string().default('hidden'),
  logDir: z.string().default('~/.dsh/chatgpt-web/logs'),
  temporaryChat: z.boolean().default(true),
  /** 每次调用前把网页端「思考强度」对齐到这个档位：low / medium / high（默认 high） */
  reasoningEffort: z.string().default('high'),
  /** 每次调用前把网页端模型切换到这个（例如 GPT-6 / GPT-5.6 Sol）；空串表示保持页面上的选择 */
  webModel: z.string().default(''),
  contextWindow: z.number().default(128000),
  defaultMaxTokens: z.number().default(8192),
  /** 提示词预算（字符）。实测 16 万字符都能整段送达；默认给 6 万，够放工具+历史 */
  maxPromptChars: z.number().default(60000),
  emulateTools: z.boolean().default(true),
  pollIntervalMs: z.number().default(250),
  responseTimeoutMs: z.number().default(600000),
  /** 文本连续多久没变化就认为回复结束（兜底 streaming 探测失效） */
  idleFinishMs: z.number().default(6000),
  /** 发送后「既没有正文也没有在生成」多久算彻底失败（High 思考强度可能很慢） */
  noResponseTimeoutMs: z.number().default(120000),
  composerTimeoutMs: z.number().default(60000),
  navigateTimeoutMs: z.number().default(45000),
  startupTimeoutMs: z.number().default(30000),
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
      }),
    )
    .default([{ id: 'chatgpt-web', name: 'ChatGPT 网页（网页额度）' }]),
});

function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

function readConfig(config) {
  const field = (key, fallback) => {
    const raw = config?.[key];
    if (raw === undefined) return fallback;
    const value = unwrap(raw);
    return value === undefined ? fallback : value;
  };

  const list = field('models', []);
  const models = (Array.isArray(list) ? list : [])
    .map((entry) => {
      const id = String(unwrap(entry?.id ?? entry));
      const rawName = unwrap(entry?.name);
      return { id, name: typeof rawName === 'string' && rawName.length > 0 ? rawName : id };
    })
    .filter((entry) => entry.id.length > 0);

  return {
    provider: String(field('provider', 'chatgpt-web')),
    displayName: String(field('displayName', 'ChatGPT 网页版')),
    transport: String(field('transport', 'web')),
    chromePath: String(field('chromePath', DEFAULT_CHROME)),
    userDataDir: String(field('userDataDir', '~/.dsh/chatgpt-web/chrome-profile')),
    debuggingPort: Number(field('debuggingPort', 9333)),
    windowMode: String(field('windowMode', 'hidden')),
    logDir: String(field('logDir', '~/.dsh/chatgpt-web/logs')),
    temporaryChat: Boolean(field('temporaryChat', true)),
    reasoningEffort: String(field('reasoningEffort', 'high')),
    webModel: String(field('webModel', '')).trim(),
    contextWindow: Number(field('contextWindow', 128000)),
    defaultMaxTokens: Number(field('defaultMaxTokens', 8192)),
    maxPromptChars: Number(field('maxPromptChars', 60000)),
    emulateTools: Boolean(field('emulateTools', true)),
    pollIntervalMs: Number(field('pollIntervalMs', 250)),
    responseTimeoutMs: Number(field('responseTimeoutMs', 600000)),
    idleFinishMs: Number(field('idleFinishMs', 6000)),
    noResponseTimeoutMs: Number(field('noResponseTimeoutMs', 120000)),
    composerTimeoutMs: Number(field('composerTimeoutMs', 60000)),
    navigateTimeoutMs: Number(field('navigateTimeoutMs', 45000)),
    startupTimeoutMs: Number(field('startupTimeoutMs', 30000)),
    models: models.length > 0 ? models : [{ id: 'chatgpt-web', name: 'ChatGPT 网页（网页额度）' }],
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const settings = readConfig(config);
  const log = createLog({ dir: settings.logDir });
  log.info(`dsh-llm-chatgpt-web 0.1.2 loaded (temporaryChat=${settings.temporaryChat}, reasoningEffort=${settings.reasoningEffort}, webModel=${settings.webModel || '-'})`);
  const entryId = ctx.fiber?.entry?.options?.id ?? name;
  const adapter = new ChatGptWebAdapter(settings, log);

  log.info(`plugin loaded: provider=${settings.provider} transport=${settings.transport} entry=${entryId} build=2026-10-21T23:35`);

  ctx.llm.registerAdapter([settings.provider], adapter);
  ctx.llm.registerConfigurableProviders([
    {
      provider: settings.provider,
      displayName: settings.displayName,
      settingsNs: entryId,
      settingsPath: [],
      declared: true,
    },
  ]);

  ctx.logger?.info?.(
    `${name}: registered provider "${settings.provider}" with ${settings.models.length} model(s) (transport=${settings.transport})`,
  );

  ctx.effect(() => () => {
    adapter.dispose().catch(() => {});
  });
}

export { ChatGptWebAdapter, readConfig };
