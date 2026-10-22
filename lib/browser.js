/**
 * 浏览器层：启动一个独占的 Chrome（自己的 user-data-dir），用 CDP 驱动
 * chatgpt.com 网页端：打开临时对话 → 输入提示词 → 点发送 → 轮询 DOM 拿回复。
 *
 * 为什么走浏览器而不是 HTTP：ChatGPT 网页后端的 /backend-api/f/conversation 需要
 * Cloudflare 与 sentinel/PoW 令牌，纯 HTTP 无法稳定伪造；网页额度只在“真实浏览器
 * 里的网页会话”这一条路上。这个文件就是那条路。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CdpConnection, CdpError, httpJson } from './cdp.js';

export class BrowserError extends Error {
  constructor(message, code = 'BROWSER_ERROR') {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

const CHAT_URL = 'https://chatgpt.com/';
const LOGIN_URL = 'https://chatgpt.com/auth/login';
const TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';

// 2026-10 的 chatgpt.com 改版后不再有 data-message-author-role / article，
// 助手正文渲染在 [class*="MarkdownRoot"] 里，发送键是 button[aria-label="发送"]，
// 生成中会出现「停止」按钮，结束后出现「重新生成回复」。下面同时保留旧选择器。
const SEND_BUTTON_SELECTOR = [
  'button[aria-label="发送"]',
  'button[aria-label="Send prompt"]',
  '[data-testid="send-button"]',
  '[data-testid="composer-send-button"]',
  'form button[type="submit"]',
].join(',');

const STOP_BUTTON_SELECTOR = [
  '[aria-label*="停止"]',
  '[aria-label*="Stop"]',
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
].join(',');

const COMPOSER_SELECTOR = [
  '#prompt-textarea',
  '[data-testid="composer"] [contenteditable="true"]',
  'form [contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
].join(',');

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

/** 页面状态探测（在页面里执行，返回 JSON）。 */
function pageStatus() {
  const text = document.body ? document.body.innerText : '';
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]',
  );
  const sendButton = document.querySelector(
    '[data-testid="send-button"],[data-testid="composer-send-button"],button[aria-label="Send prompt"],button[aria-label="发送"]',
  );
  const stopButton =
    document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"]') ??
    [...document.querySelectorAll('button[aria-label]')].find((node) =>
      /^(停止|停止生成|stop|stop streaming|stop generating)$/i.test((node.getAttribute('aria-label') || '').trim()),
    ) ??
    null;
  const userNodes = [...document.querySelectorAll('[class*="user-message"]')];
  const lastUser = userNodes.length > 0 ? userNodes[userNodes.length - 1] : null;
  const markdownRoots = [...document.querySelectorAll('[class*="MarkdownRoot"]')].filter(
    (node) =>
      lastUser === null ||
      (lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  const lastText = markdownRoots
    .map((node) => node.innerText || '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
  const streaming =
    stopButton !== null ||
    document.querySelector('.result-streaming') !== null ||
    document.querySelector('[data-is-streaming="true"]') !== null;
  const hasRegenerate = document.querySelector('[aria-label*="重新生成"],[aria-label*="Regenerate"]') !== null;
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    hasComposer: composer !== null,
    hasLoginCta: [...document.querySelectorAll('a,button')].some((node) =>
      /^(log in|sign up|登录|注册)$/i.test((node.textContent || '').trim()),
    ),
    onLoginPath: /\/auth(\/|$)/.test(location.pathname),
    cloudflare: /just a moment|checking your browser|verify you are human|正在验证|请稍候/i.test(text),
    assistantCount: markdownRoots.length,
    userCount: userNodes.length,
    lastText,
    streaming,
    hasRegenerate,
    snippet: text.replace(/\s+/g, ' ').slice(0, 300),
  };
}

function pageExtract() {
  const userNodes = [...document.querySelectorAll('[class*="user-message"]')];
  const lastUser = userNodes.length > 0 ? userNodes[userNodes.length - 1] : null;
  const nodes = [...document.querySelectorAll('[class*="MarkdownRoot"]')].filter(
    (node) => lastUser === null || (lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  if (nodes.length === 0) return null;
  const node = nodes[nodes.length - 1];
  const root = node;
  const clone = root.cloneNode(true);
  for (const pre of clone.querySelectorAll('pre')) {
    const code = pre.innerText || pre.textContent || '';
    const lang = pre.querySelector('code')?.className?.match(/language-([\w-]+)/)?.[1] ?? '';
    pre.replaceWith(document.createTextNode('\n```' + lang + '\n' + code + '\n```\n'));
  }
  for (const item of clone.querySelectorAll('li')) {
    item.prepend(document.createTextNode('- '));
  }
  for (const heading of clone.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    heading.prepend(document.createTextNode('#'.repeat(Number(heading.tagName.slice(1))) + ' '));
  }
  const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/** 打开模型面板，并切到「思考强度」那一屏（有滑块的那屏）。 */
function pageOpenEffortView() {
  if (document.querySelector('[role="slider"]') !== null) return { open: true, already: true };
  const button = [...document.querySelectorAll('button[aria-label]')].find((node) =>
    /选择 ChatGPT 模型|choose.*model|model picker/i.test((node.getAttribute('aria-label') || '').trim()),
  );
  if (button === undefined) return { open: false, reason: 'button-missing' };
  button.click();
  const row = [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) =>
      (node.getAttribute('aria-label') || '') === '选择模型' ||
      /^(Low|Medium|High|Extra High|低|中|高)/.test((node.innerText || '').trim()),
  );
  if (row === undefined) return { open: false, reason: 'effort-row-missing' };
  row.click();
  return { open: true, already: false };
}

/** 发送键是否可点（React 状态真的收下了文本才会变蓝）。找不到按钮时 found=false。 */
function pageSendState() {
  const candidates = [...document.querySelectorAll('[data-testid="send-button"],[data-testid="composer-send-button"],button[aria-label="Send prompt"],button[aria-label="发送"],button[aria-label*="发送"]')];
  const visible = candidates.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const pool = visible.length > 0 ? visible : candidates;
  const enabled = pool.find((node) => node.disabled !== true);
  const chosen = enabled ?? pool[0];
  if (chosen === undefined) return { found: false, disabled: null, count: candidates.length };
  return { found: true, disabled: chosen.disabled === true, count: candidates.length };
}

/** 读当前思考强度滑块状态（0=Low 1=Medium 2=High）。 */
function pageEffortState() {
  const slider = document.querySelector('[role="slider"]');
  const menu = document.querySelector('[role="menu"]');
  const labelNode = document.querySelector('[class*="ViewToggleEffortLabel"]');
  return {
    menuOpen: menu !== null,
    value: slider === null ? null : Number(slider.getAttribute('aria-valuenow')),
    max: slider === null ? null : Number(slider.getAttribute('aria-valuemax')),
    label: labelNode === null ? '' : (labelNode.textContent || '').trim(),
    text: menu === null ? '' : (menu.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  };
}

/** 把滑块聚焦（键盘调节前必须先聚焦）。 */
function pageFocusEffortSlider() {
  const slider = document.querySelector('[role="slider"]');
  if (slider === null) return false;
  slider.focus();
  return true;
}

/** 选网页端的模型（GPT-6 / GPT-5.6 Sol …）。 */
function pageClickModelOption(name) {
  const options = [...document.querySelectorAll('[role="menuitemradio"]')];
  const target = options.find((node) => (node.innerText || '').trim().toLowerCase() === String(name).trim().toLowerCase());
  if (target === undefined) return { clicked: false, options: options.map((node) => (node.innerText || '').trim()) };
  if (target.getAttribute('aria-checked') === 'true') return { clicked: true, already: true };
  target.click();
  return { clicked: true, already: false };
}

/** 是否在临时聊天里（URL 带 temporary-chat=true，或页面有临时聊天提示条）。 */
function pageTemporaryState() {
  const text = document.body ? document.body.innerText : '';
  return {
    byUrl: /[?&]temporary-chat=true/.test(location.href),
    byBanner: /临时聊天|temporary chat/i.test(text),
    onLoginPath: /\/auth(\/|$)/.test(location.pathname),
  };
}

/** 在侧栏里点「临时聊天」开关（URL 参数失效时的兜底）。 */
function pageToggleTemporaryChat() {
  const candidates = [...document.querySelectorAll('button,a,[role="button"]')];
  const target = candidates.find((node) => {
    const label = `${node.getAttribute('aria-label') || ''} ${node.textContent || ''}`.trim();
    return /^(临时聊天|temporary chat)$/i.test(label);
  });
  if (target === undefined) return false;
  target.click();
  return true;
}

function pageDismiss() {
  const labels = ['got it', 'okay', 'ok', '知道了', '好', '关闭', 'dismiss', 'stay logged out', 'continue'];
  let clicked = 0;
  for (const node of document.querySelectorAll('button,[role="button"]')) {
    const label = (node.textContent || '').trim().toLowerCase();
    if (label.length > 0 && label.length < 20 && labels.includes(label)) {
      try {
        node.click();
        clicked += 1;
      } catch {
        /* 忽略 */
      }
    }
  }
  return clicked;
}

function pageComposerPoint() {
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]',
  );
  if (composer === null) return null;
  composer.focus();
  try {
    composer.click();
  } catch {
    /* 忽略 */
  }
  const box = composer.getBoundingClientRect();
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function pageClickSend() {
  const candidates = [...document.querySelectorAll('[data-testid="send-button"],[data-testid="composer-send-button"],button[aria-label="Send prompt"],button[aria-label="发送"],button[aria-label*="发送"]')];
  const visible = candidates.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const pool = visible.length > 0 ? visible : candidates;
  const button = pool.find((node) => node.disabled !== true);
  if (button !== undefined) {
    try {
      button.click();
      return 'click';
    } catch {
      /* 落到下面 */
    }
  }
  return null;
}

function pageComposerText() {
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]',
  );
  if (composer === null) return '';
  return (composer.innerText || composer.textContent || '').trim();
}

function pageClickStop() {
  const button =
    document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"]') ??
    [...document.querySelectorAll('button[aria-label]')].find((node) =>
      /^(停止|停止生成|stop|stop streaming|stop generating)$/i.test((node.getAttribute('aria-label') || '').trim()),
    ) ??
    null;
  if (button !== null) {
    try {
      button.click();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBrokenReply(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return true;
  if (/^@@TOOL@@\s*$/.test(trimmed)) return true;
  if (trimmed.includes('@@TOOL@@') && !/"name"\s*:/.test(trimmed)) return true;
  return false;
}

/**
 * 网页回复里「只有正文、没有任何工具调用」。这类回复在需要动手的任务里几乎都是编造
 * （模型拿它自带的容器/代码解释器跑了一遍，或者干脆猜了个结果）。判定从严：
 * 任务要求动手时，只要没有 @@TOOL@@ 就当作坏回复重发。
 */
function looksLikeFabricatedAnswer(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return true;
  if (trimmed.includes('@@TOOL@@')) return false;
  return /(已执行|已运行|执行结果|命令输出|输出为|输出是|结果为|共\s*\d+\s*个|运行了|跑了一下|我(?:已经)?(?:用|通过).{0,8}(?:bash|shell|容器|终端))/i.test(
    trimmed,
  );
}

export class ChatGptBrowser {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
    this.chromePromise = null;
    this.connection = null;
    this.targetId = null;
    this.lastNavigation = 0;
    this.conversationUrl = null;
  }

  get profileDir() {
    return expandHome(this.settings.userDataDir);
  }

  get port() {
    return this.settings.debuggingPort;
  }

  async #waitForChrome(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const version = await httpJson(`http://127.0.0.1:${this.port}/json/version`, { timeoutMs: 1500 });
        if (typeof version?.webSocketDebuggerUrl === 'string') return version;
      } catch (error) {
        lastError = error;
      }
      await sleep(400);
    }
    throw new BrowserError(
      `Chrome 调试端口 ${this.port} 在 ${timeoutMs}ms 内没有就绪` +
        (lastError ? `（最后一次错误：${lastError.message}）` : ''),
      'BROWSER_START_FAILED',
    );
  }

  async #launchChrome() {
    const profileDir = this.profileDir;
    fs.mkdirSync(profileDir, { recursive: true });
    const mode = String(this.settings.windowMode ?? 'visible').toLowerCase();
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--window-size=1360,900',
      '--lang=zh-CN',
      '--remote-allow-origins=*',
    ];
    if (mode === 'headless') {
      // 无窗口：不弹浏览器，但 Cloudflare 更容易挑战，适合已经稳定登录之后用。
      args.push('--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio');
    } else if (mode === 'hidden') {
      // 有头但挪到屏幕外：保持 Cloudflare 通过率，又不打扰桌面。
      args.push('--window-position=-32000,-32000');
    }
    args.push('about:blank');
    this.log.info(`launching chrome: ${this.settings.chromePath} ${args.join(' ')}`);

    // 关键：不要抢焦点。
    // 直接 spawn 可执行文件时，Chromium 会把自己提升到前台并把激活应用到最上层，
    // 用户正在别的窗口里打字就会被强行打断。macOS 上交给 `open -g -n -a <app>`
    // （-g = 不切到前台，-n = 新实例，--args 传参），Linux/Windows 用 detached spawn
    // 并尽量让窗口不激活。
    const child = await this.#spawnBrowserDetached(args);
    child?.on?.('error', (error) => {
      this.log.error(`chrome spawn error: ${error instanceof Error ? error.message : String(error)}`);
    });
    child?.unref?.();
    return this.#waitForChrome(this.settings.startupTimeoutMs);
  }

  /**
   * 后台启动浏览器，尽量不改变前台窗口。
   * 返回可 unref 的句柄（macOS 走 `open` 时没有子进程，返回 null）。
   */
  async #spawnBrowserDetached(args) {
    if (process.platform === 'darwin' && /\/MacOS\//.test(this.settings.chromePath)) {
      // 从 .../Foo.app/Contents/MacOS/Foo 反推回 .app 包路径
      const appBundle = this.settings.chromePath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
      if (/\.app$/.test(appBundle)) {
        // -g 只是「不主动激活」，macOS 仍可能把新窗口带到前面；-j 才是真正的后台/隐藏启动。
        // 两个一起用，实测前台应用保持不变（DeepSeek Harness），Chrome 仍正常监听调试端口。
        const openArgs = ['-g', '-j', '-n', '-a', appBundle, '--args', ...args];
        this.log.info(`using open -g -j (background launch, no focus steal): open ${openArgs.join(' ')}`);
        const child = spawn('open', openArgs, { detached: true, stdio: 'ignore' });
        // open 只是投递请求，等到调试端口就绪由 #waitForChrome 负责
        await new Promise((resolve) => {
          child.once('exit', () => resolve(undefined));
          child.once('error', () => resolve(undefined));
          setTimeout(resolve, 1500);
        });
        return null;
      }
    }
    if (process.platform === 'win32') {
      return spawn(this.settings.chromePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    // Linux：detached + 独立会话，窗口仍可能被 WM 激活，但不会阻塞调用方。
    return spawn(this.settings.chromePath, args, { detached: true, stdio: 'ignore' });
  }

  /**
   * 登录态快照/回填。
   *
   * 起因：用户反馈「经常要重新登录」。查下来插件 profile 的 Cookies 库里**没有**
   * `__Secure-next-auth.session-token`（只剩 csrf / oai-sc 这些辅助项），说明登录
   * 本身的 cookie 在会话过程中被网页端清掉或没落盘，而每次调用又都新开临时对话，
   * 于是下一次就又变成未登录。
   *
   * 做法：一旦观察到已登录，就把 chatgpt.com 的 cookie 存成一份快照；下次启动时
   * 如果发现没有 session-token，就先把快照回填进去再访问页面。
   */
  #cookieSnapshotPath() {
    return path.join(expandHome(this.settings.userDataDir), '..', 'login-state.json');
  }

  async #readCookieJar() {
    const connection = await this.ensurePage();
    const result = await connection.send('Network.getAllCookies', {}).catch(async () => {
      await connection.send('Network.enable', {});
      return connection.send('Network.getAllCookies', {});
    });
    return Array.isArray(result?.cookies) ? result.cookies : [];
  }

  /** 已登录就把 cookie 存一份；没有 session-token 就不存（存了也没用）。 */
  async #saveLoginSnapshot() {
    try {
      const cookies = await this.#readCookieJar();
      const session = cookies.find((c) => /session-token|oai-sc|auth-info/.test(c.name));
      if (session === undefined) return false;
      const file = this.#cookieSnapshotPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const keep = cookies
        .filter((c) => /(^|\.)chatgpt\.com$/.test(c.domain) || /(^|\.)openai\.com$/.test(c.domain) || /auth\.openai\.com$/.test(c.domain))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires,
        }));
      fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }, null, 2));
      this.log.info(`login snapshot saved (${keep.length} cookies) -> ${file}`);
      return true;
    } catch (error) {
      this.log.warn(`save login snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 页面显示已登录、但 cookie 库缺 session-token 时，把快照里的 cookie 回填。 */
  async #restoreLoginSnapshotIfNeeded() {
    try {
      const file = this.#cookieSnapshotPath();
      if (!fs.existsSync(file)) return false;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];
      if (cookies.length === 0) return false;
      const jar = await this.#readCookieJar();
      const hasSession = jar.some((c) => /session-token/.test(c.name));
      this.log.info(`restore check: snapshot=${cookies.length} cookies, jar=${jar.length}, hasSession=${hasSession}`);
      if (hasSession) return false;
      const connection = await this.ensurePage();
      let restored = 0;
      for (const cookie of cookies) {
        try {
          await connection.send('Network.setCookie', {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            secure: cookie.secure !== false,
            httpOnly: cookie.httpOnly === true,
            sameSite: cookie.sameSite,
            ...(typeof cookie.expires === 'number' && cookie.expires > 0 ? { expires: cookie.expires } : {}),
          });
          restored += 1;
        } catch {
          /* 单个 cookie 失败不影响其它 */
        }
      }
      this.log.info(`restored ${restored}/${cookies.length} cookies from login snapshot`);
      return restored > 0;
    } catch (error) {
      this.log.warn(`restore login snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * 保证浏览器在跑。
   *
   * 关键点：**每次都探活**。之前这里只要成功一次就把 Promise 缓存住，
   * 用户手动关掉 Chrome 之后，插件仍以为它活着，直接去连调试端口 →
   * 抛出裸的 `fetch failed`（上层显示成 UNKNOWN）。现在端口不通就清掉旧状态、
   * 重新拉起浏览器再继续。
   */
  async ensureChrome() {
    try {
      await httpJson(`http://127.0.0.1:${this.port}/json/version`, { timeoutMs: 1500 });
      if (this.chromePromise === null) this.chromePromise = Promise.resolve();
      return this.chromePromise;
    } catch {
      /* 端口不通：继续往下重启 */
    }

    const wasStarted = this.chromePromise !== null;
    this.connection = null; // 旧 CDP 连接已随浏览器一起失效
    this.chromePromise = null;
    this.log.warn(
      wasStarted
        ? `chrome debug port ${this.port} is gone (browser closed?), relaunching`
        : `chrome not running on port ${this.port}, launching`,
    );
    this.chromePromise = this.#launchChrome().catch((error) => {
      this.chromePromise = null;
      throw error;
    });
    return this.chromePromise;
  }

  async #listTargets() {
    try {
      const targets = await httpJson(`http://127.0.0.1:${this.port}/json/list`, { timeoutMs: 3000 });
      return Array.isArray(targets) ? targets : [];
    } catch (error) {
      throw new BrowserError(
        `Chrome 调试端口 ${this.port} 不可用：${error instanceof Error ? error.message : String(error)}`,
        'CHROME_UNAVAILABLE',
      );
    }
  }

  /** 连不上浏览器时重启一次再试（用户手动关掉 Chrome 是常见情况）。 */
  async ensurePage() {
    try {
      return await this.#ensurePageOnce();
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'AUTH_REQUIRED') throw error;
      this.log.warn(
        `attach/launch failed (${error instanceof Error ? error.message : String(error)}), ` +
          'resetting browser state and retrying once',
      );
      this.chromePromise = null;
      this.connection = null;
      await sleep(600);
      return this.#ensurePageOnce();
    }
  }

  async #ensurePageOnce() {
    await this.ensureChrome();
    if (this.connection !== null && !this.connection.closed) return this.connection;

    let targets = await this.#listTargets();
    let page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
    if (page === undefined) {
      try {
        page = await httpJson(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT', timeoutMs: 5000 });
      } catch (error) {
        throw new BrowserError(`无法新建 Chrome 标签页：${error.message}`, 'BROWSER_PAGE_FAILED');
      }
      await sleep(300);
    }
    if (page === undefined || typeof page.webSocketDebuggerUrl !== 'string') {
      throw new BrowserError('Chrome 没有可用的 page target', 'BROWSER_PAGE_FAILED');
    }

    const connection = await CdpConnection.attach(page.webSocketDebuggerUrl);
    this.connection = connection;
    this.targetId = page.id;
    await connection.send('Page.enable', {});
    await connection.send('Runtime.enable', {});
    this.log.info(`attached to page target ${page.id} (${page.url})`);
    return connection;
  }

  async status() {
    const connection = await this.ensurePage();
    return connection.evaluate(`(${pageStatus.toString()})()`);
  }

  async #navigate(url) {
    const connection = await this.ensurePage();
    const current = await connection.evaluate('location.href').catch(() => '');
    if (typeof current === 'string' && current.startsWith(url) && Date.now() - this.lastNavigation < 3000) {
      return;
    }
    this.log.info(`navigate: ${url}`);
    await connection.send('Page.navigate', { url });
    this.lastNavigation = Date.now();
    const deadline = Date.now() + this.settings.navigateTimeoutMs;
    while (Date.now() < deadline) {
      const readyState = await connection.evaluate('document.readyState').catch(() => 'loading');
      if (readyState === 'complete' || readyState === 'interactive') break;
      await sleep(250);
    }
    await sleep(400);
  }

  /** 打开（或复用）一个干净对话页，并等到输入框可用。 */
  async openChat({ reuse = false } = {}) {
    await this.#restoreLoginSnapshotIfNeeded().catch(() => false);
    const url = this.settings.temporaryChat ? TEMP_CHAT_URL : CHAT_URL;

    // reuse=true：同一轮对话里继续说话。网页端自己记着上下文，重开新对话会把
    // 上下文丢掉（这正是之前「每发一条消息就开一个新对话」的问题）。
    if (reuse) {
      const current = await this.status().catch(() => null);
      const sameConversation =
        this.conversationUrl !== null &&
        typeof current?.url === 'string' &&
        current.url.startsWith(this.conversationUrl);
      if (current?.hasComposer === true && sameConversation) {
        this.log.info(`reusing current conversation (url=${current.url})`);
        return current;
      }
    }

    await this.#navigate(url);
    await this.ensurePage().then((connection) => connection.evaluate(`(${pageDismiss.toString()})()`).catch(() => 0));
    const deadline = Date.now() + this.settings.composerTimeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.status();
      if (last.hasComposer) {
        // 记下这条对话的地址：发送后 URL 会变成 /c/<id>，用它判断「还是同一条对话」。
        this.conversationUrl = String(last.url).split('?')[0].replace(/\/$/, '') || null;
        this.log.info(`composer ready (url=${last.url})`);
        return last;
      }
      if (last.onLoginPath || last.hasLoginCta) {
        this.log.warn(`login required (url=${last.url}, loginCta=${last.hasLoginCta})`);
        return last;
      }
      await sleep(500);
    }
    this.log.warn(`composer not ready: ${JSON.stringify(last)}`);
    return last ?? { hasComposer: false, url, lastText: '', snippet: '' };
  }

  /** 打开登录页（有窗口的 Chrome，用户手动登录一次）。 */
  /** 把窗口移回屏幕内（hidden 模式下需要用户手动登录时用）。 */
  /**
   * 需要人工登录时，把浏览器窗口挪回屏幕内**并带到前台**。
   *
   * 平时所有调用都走 `open -g -j` 后台启动，不抢焦点、不弹窗；只有登录这种必须人
   * 操作的场景才主动激活窗口，否则用户根本看不见登录页。
   */
  async #revealWindow() {
    const mode = String(this.settings.windowMode ?? 'visible').toLowerCase();
    if (mode === 'headless') {
      this.log.warn('headless 模式无法显示登录窗口：需要登录时请把 windowMode 改成 visible');
      return;
    }
    try {
      const connection = await this.ensurePage();
      const { windowId } = await connection.send('Browser.getWindowForTarget', {});
      await connection.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 120, top: 90, width: 1280, height: 900, windowState: 'normal' },
      });
      this.log.info('window moved back on screen for login');
    } catch (error) {
      this.log.warn(`reveal window failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 把浏览器激活到前台（登录必须让人看见；这一步是刻意的，只在登录路径上做）。
    try {
      const appBundle = process.platform === 'darwin'
        ? this.settings.chromePath.replace(/\/Contents\/MacOS\/[^/]+$/, '')
        : '';
      if (process.platform === 'darwin' && /\.app$/.test(appBundle)) {
        spawn('open', ['-a', appBundle], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'win32') {
        this.log.warn('Windows 下请手动切到浏览器窗口完成登录');
      }
      this.log.info('browser activated for login');
    } catch (error) {
      this.log.warn(`activate browser failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async openLogin() {
    await this.#navigate(LOGIN_URL);
    await this.#revealWindow();
    this.log.info('login page opened');
  }

  async #pressKey(key) {
    const connection = await this.ensurePage();
    const table = {
      ArrowRight: { code: 'ArrowRight', vk: 39 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      Home: { code: 'Home', vk: 36 },
      End: { code: 'End', vk: 35 },
      Escape: { code: 'Escape', vk: 27 },
    };
    const entry = table[key];
    if (entry === undefined) return;
    await connection.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: entry.code,
      windowsVirtualKeyCode: entry.vk,
      nativeVirtualKeyCode: entry.vk,
    });
    await connection.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: entry.code,
      windowsVirtualKeyCode: entry.vk,
      nativeVirtualKeyCode: entry.vk,
    });
  }

  /**
   * 把网页端的「思考强度」固定成配置值（默认 high），可选地固定模型。
   * 网页端会记住上次选择，但换 profile / 更新后可能回到默认，所以每次调用前都对齐一次。
   */
  /** 等页面上一次生成彻底结束（停止键消失），否则切模型/发消息都会互相打架。 */
  async #waitIdle(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let logged = false;
    while (Date.now() < deadline) {
      const state = await this.status().catch(() => null);
      if (state === null || state.streaming !== true) return;
      if (!logged) {
        this.log.warn('page still generating, waiting for it to settle before next prompt');
        logged = true;
      }
      await sleep(500);
    }
    this.log.warn('page did not settle in time, proceeding anyway');
  }

  async #applyPreferences() {
    const connection = await this.ensurePage();
    const effort = String(this.settings.reasoningEffort ?? '').toLowerCase();
    const levels = { low: 0, medium: 1, high: 2, extrahigh: 2, minimal: 0 };
    const target = Object.prototype.hasOwnProperty.call(levels, effort) ? levels[effort] : null;
    const model = String(this.settings.webModel ?? '').trim();
    if (target === null && model.length === 0) return;

    // 新开的临时聊天里，模型按钮比输入框晚渲染几百毫秒，重试几次再判失败
    let opened = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      opened = await connection.evaluate(`(${pageOpenEffortView.toString()})()`);
      if (opened?.open === true) break;
      await sleep(500);
    }
    if (opened?.open !== true) {
      this.log.warn(`preferences skipped: ${opened?.reason ?? 'unknown'}`);
      return;
    }
    await sleep(600);

    let state = await connection.evaluate(`(${pageEffortState.toString()})()`);
    if (target !== null && typeof state?.value === 'number' && state.value !== target) {
      const focused = await connection.evaluate(`(${pageFocusEffortSlider.toString()})()`);
      if (focused === true) {
        // 先到一端再逐格移动，避免依赖当前值
        await this.#pressKey('Home');
        await sleep(150);
        for (let step = 0; step < target; step += 1) {
          await this.#pressKey('ArrowRight');
          await sleep(120);
        }
        state = await connection.evaluate(`(${pageEffortState.toString()})()`);
      }
    }
    if (target !== null) {
      const actual = typeof state?.value === 'number' ? state.value : null;
      if (actual === target) this.log.info(`reasoning effort = ${state.label || actual}`);
      else this.log.warn(`reasoning effort not applied (want=${target}, got=${actual}, label=${state?.label ?? ''})`);
    }

    if (model.length > 0) {
      const picked = await connection.evaluate(`(${pageClickModelOption.toString()})(${JSON.stringify(model)})`);
      if (picked?.clicked === true) this.log.info(`web model = ${model}`);
      else this.log.warn(`web model not found: ${model} (options=${JSON.stringify(picked?.options ?? [])})`);
      await sleep(300);
    }

    await this.#pressKey('Escape');
    await sleep(200);
    await this.#pressKey('Escape');
    await sleep(200);
  }

  /** 确认当前在临时聊天里；不是的话尝试切过去（会话不写进 ChatGPT 历史）。 */
  async #ensureTemporaryChat() {
    if (this.settings.temporaryChat !== true) return;
    const connection = await this.ensurePage();
    let state = await connection.evaluate(`(${pageTemporaryState.toString()})()`);
    if (state?.byUrl === true || state?.byBanner === true) return;
    const toggled = await connection.evaluate(`(${pageToggleTemporaryChat.toString()})()`);
    this.log.warn(`temporary chat not detected, toggle ${toggled === true ? 'clicked' : 'button missing'}`);
    await sleep(800);
    state = await connection.evaluate(`(${pageTemporaryState.toString()})()`);
    if (state?.byUrl !== true && state?.byBanner !== true) {
      this.log.warn('temporary chat still not confirmed; continuing anyway');
    }
  }

  async #focusComposer() {
    const connection = await this.ensurePage();
    const point = await connection.evaluate(`(${pageComposerPoint.toString()})()`);
    if (point === null) throw new BrowserError('找不到输入框（#prompt-textarea）', 'COMPOSER_MISSING');
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(120);
  }

  /** 清空输入框（避免重复插入：insertText 成功但 React 渲染慢时旧逻辑会再插一遍）。 */
  async #clearComposer() {
    const connection = await this.ensurePage();
    const current = await connection.evaluate(`(${pageComposerText.toString()})()`);
    if (typeof current !== 'string' || current.trim().length === 0) return true;
    await connection.evaluate(`(() => {
      const el = document.querySelector('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]');
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      return true;
    })()`);
    await sleep(200);
    return true;
  }

  /**
   * 轮询确认「文本进了输入框 + 发送键可点」。
   *
   * 2026-10 的页面里 Input.insertText 能让 ProseMirror 显示文字，但有时不会触发 React 的
   * onChange，于是发送键一直是灰的 —— 此时点发送/回车都不会发出东西。必须两条都满足才算就绪。
   */
  async #composerReady(prompt, timeoutMs = 5000) {
    const connection = await this.ensurePage();
    const compact = prompt.replace(/\s+/g, '');
    const head = compact.slice(0, 30);
    const tail = compact.slice(-40);
    // 必须几乎全量写进去：长提示词被编辑器/React 截断是真实踩过的坑。
    const expected = compact.length - Math.max(20, Math.round(compact.length * 0.02));
    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
      const current = await connection.evaluate(`(${pageComposerText.toString()})()`);
      const send = await connection.evaluate(`(${pageSendState.toString()})()`);
      lastState = { composerLen: typeof current === 'string' ? current.length : -1, send };
      if (typeof current === 'string') {
        const nowCompact = current.replace(/\s+/g, '');
        const hasText = nowCompact.includes(head) && (compact.length < 80 || nowCompact.includes(tail)) && nowCompact.length >= expected;
        const sendReady = send?.found !== true || send.disabled === false;
        if (hasText && sendReady) return true;
      }
      await sleep(250);
    }
    this.log.warn(`composer not ready: ${JSON.stringify(lastState)}`);
    return false;
  }

  /** 分块插入：一次性 CDP insertText 超长文本会被截断（实测 9 万字符只剩 1 万）。 */
  async #insertChunkedCdp(connection, prompt) {
    const size = 4000;
    for (let i = 0; i < prompt.length; i += size) {
      await connection.send('Input.insertText', { text: prompt.slice(i, i + size) }, { timeoutMs: 30000 });
      await sleep(15);
    }
  }

  async #insertPrompt(prompt) {
    const connection = await this.ensurePage();
    await this.#clearComposer();
    // 1) 首选 CDP insertText（分块；快，且换行不会被当成提交）
    await this.#insertChunkedCdp(connection, prompt);
    if (await this.#composerReady(prompt, 5000)) return;

    // 2) React 没收到状态：用 execCommand 走真实输入事件（会触发 onChange）
    this.log.warn('insertText did not enter React state, falling back to execCommand insertText');
    await this.#clearComposer();
    const size = 4000;
    for (let i = 0; i < prompt.length; i += size) {
      await connection.evaluate(
        `(() => {
          const el = document.querySelector('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]');
          if (!el) return false;
          el.focus();
          document.execCommand('insertText', false, ${JSON.stringify(prompt.slice(i, i + size))});
          return true;
        })()`,
      );
      await sleep(30);
    }
    if (await this.#composerReady(prompt, 8000)) return;

    // 3) 最后一招：beforeinput/input 事件 + 控件文本
    this.log.warn('execCommand failed, forcing textContent + input events');
    await this.#clearComposer();
    await connection.evaluate(
      `(() => {
        const el = document.querySelector('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]');
        if (!el) return false;
        el.focus();
        const data = ${JSON.stringify(prompt)};
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true }));
        el.textContent = data;
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data, bubbles: true }));
        return true;
      })()`,
    );
    if (await this.#composerReady(prompt, 5000)) return;
    throw new BrowserError('提示词没能写进输入框（React 状态未更新），请稍后重试', 'COMPOSER_INPUT_FAILED');
  }

  /** 点发送键：等它从灰变蓝再点（React 状态没吃下文本时它是灰的），最多试 3 次。 */
  async #send() {
    const connection = await this.ensurePage();
    const deadline = Date.now() + 10000;
    let attempts = 0;
    while (Date.now() < deadline) {
      const state = await connection.evaluate(`(${pageSendState.toString()})()`);
      if (state?.found === true && state.disabled === false) {
        const clicked = await connection.evaluate(`(${pageClickSend.toString()})()`);
        if (clicked === 'click') {
          attempts += 1;
          await sleep(600);
          const left = await connection.evaluate(`(${pageComposerText.toString()})()`);
          if (typeof left !== 'string' || left.trim().length === 0) return true;
          if (attempts >= 3) return true; // 点过几次仍未清空，交给上层校验判断是否真的发出
          await sleep(400);
          continue;
        }
      }
      await sleep(250);
    }
    const finalState = await connection.evaluate(`(${pageSendState.toString()})()`).catch(() => null);
    this.log.warn(`send button never became clickable: ${JSON.stringify(finalState)}`);
    return false;
  }

  async screenshot(reason) {
    try {
      const connection = await this.ensurePage();
      const shot = await connection.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 10000 });
      const dir = path.join(expandHome(this.settings.logDir), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${reason.replace(/[^\w-]+/g, '_').slice(0, 40)}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      this.log.warn(`screenshot saved: ${file}`);
      return file;
    } catch (error) {
      this.log.warn(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 发一条提示词，异步产出「累计文本」快照。
   * 调用方负责和上一次快照做 diff。
   */
  /**
   * 对外的 ask：如果网页给出的回复是「空的/只有一个 @@TOOL@@ 标记」（模型被思考长度打断，
   * 或前端渲染还没跟上），自动重发一次并附一句纠正说明，避免把半个工具调用交给上层。
   */
  async *ask(prompt, options = {}) {
    let attempt = 0;
    let suffix = '';
    // 第一轮之后都复用当前对话；重试时才允许重新开一个干净的。
    let reuse = options.reuseConversation === true;
    for (;;) {
      let last = '';
      try {
        for await (const snapshot of this.#askOnce(prompt + suffix, { ...options, reuse })) {
          last = snapshot.text;
          yield snapshot;
        }
      } catch (error) {
        // 卡死/空转这类可重试错误：换一轮再来，最多两次。
        const code = error instanceof BrowserError ? error.code : '';
        const retryable = code === 'EMPTY_RETRY' || code === 'TIMEOUT';
        if (retryable && attempt < 2) {
          attempt += 1;
          this.log.warn(`${code} (attempt ${attempt}/2): 换一轮重新发送`);
          suffix = '\n\n（提醒：上一轮网页端没有任何有效回复。请按上面的协议重新输出。）';
          reuse = false;
          continue;
        }
        throw error;
      }
      const broken = isBrokenReply(last);
      // 需要动手的任务里，模型若绕过协议、直接给「已执行/输出是…」的答复，
      // 那是我这台机器上根本没跑过东西的编造，必须重发。
      const fabricated = !broken && options.requireToolCall === true && looksLikeFabricatedAnswer(last);
      if (attempt >= 2 || (!broken && !fabricated)) return;
      attempt += 1;
      this.log.warn(
        `${fabricated ? 'fabricated reply' : 'broken reply'} (attempt ${attempt}/2): ` +
          `${JSON.stringify(String(last).slice(0, 80))} -> resending`,
      );
      suffix = fabricated
        ? '\n\n（提醒：你上一条没有真正调用工具，就写了执行结果——我这边什么都没跑。' +
          '现在只输出一行 @@TOOL@@ 加合法 JSON 参数，然后停下等我把结果贴回来，不要写任何结论。）'
        : '\n\n（提醒：你上一条回复被截断或格式坏了。请重新完整输出：要么单独一行 @@TOOL@@ 加合法 JSON 参数，要么直接给出最终中文答复。）';
    }
  }

  async *#askOnce(prompt, { signal, timeoutMs, pollIntervalMs, reuse } = {}) {
    await this.ensureChrome();
    let status = await this.openChat({ reuse: reuse === true });
    if (!status.hasComposer && status.onLoginPath !== true) {
      // SPA 首帧经常先渲染「登录」按钮再换成已登录界面，给一次缓冲再判一次。
      await sleep(2500);
      status = await this.status().catch(() => status);
    }
    if (!status.hasComposer) {
      if (status.cloudflare) {
        throw new BrowserError(
          'ChatGPT 页面卡在 Cloudflare 人机验证。请确认代理（Shadowrocket / Clash）能正常访问 chatgpt.com，然后在弹出的浏览器窗口里完成验证后重试。',
          'CLOUDFLARE_BLOCKED',
        );
      }
      await this.openLogin();
      throw new BrowserError(
        'ChatGPT 网页端尚未登录。已为你打开登录窗口：在弹出的 Chrome 窗口里登录 ChatGPT 后，回到 DSH 再发送一次即可（登录状态会保存在插件自己的浏览器配置里）。',
        'AUTH_REQUIRED',
      );
    }

    await this.#saveLoginSnapshot().catch(() => false);
    await this.#ensureTemporaryChat();
    await this.#waitIdle();
    await this.#applyPreferences();
    await this.#focusComposer();
    const beforeSend = await this.status().catch(() => null);
    const usersBefore = beforeSend?.userCount ?? 0;
    await this.#insertPrompt(prompt);
    let sendOk = await this.#send();

    // 校验真的发出去了：页面上真的多了一条用户消息（或已进入流式）。
    // 只看「输入框是否清空」不够——空输入框也会被当成发送成功。
    const stillEmpty = async () =>
      this.ensurePage()
        .then((connection) => connection.evaluate(`(${pageComposerText.toString()})()`))
        .then((text) => typeof text !== 'string' || text.trim().length === 0)
        .catch(() => false);
    const sendDeadline = Date.now() + 10000;
    let sent = false;
    while (Date.now() < sendDeadline) {
      const check = await this.status();
      if (check.streaming === true || (check.userCount ?? 0) > usersBefore) {
        sent = true;
        break;
      }
      await sleep(300);
    }
    if (!sent && sendOk !== false) {
      this.log.warn('send did not register a new user message, retrying once');
      sendOk = await this.#send();
      await sleep(1500);
      const check = await this.status();
      sent = check.streaming === true || (check.userCount ?? 0) > usersBefore;
    }
    if (!sent && sendOk === true && (await stillEmpty())) {
      // 输入框确实被清空了却没出现新消息：说明页面把这条消息吞了，重插一次再发。
      this.log.warn('composer cleared but no user message appeared, re-inserting prompt');
      await this.#insertPrompt(prompt);
      sendOk = await this.#send();
      await sleep(1500);
      const check = await this.status();
      sent = check.streaming === true || (check.userCount ?? 0) > usersBefore;
    }
    if (!sent && sendOk === false) {
      await this.screenshot('send-failed');
      throw new BrowserError(
        '提示词写进了网页输入框，但发送键一直是灰的（ChatGPT 前端没接受这次输入）。已截图留档，请稍后重试；若反复出现，告诉我在网页端手动发一次是否正常。',
        'SEND_FAILED',
      );
    }
    this.log.info(`prompt sent (chars=${prompt.length})`);

    const startedAt = Date.now();
    let lastText = '';
    let stable = 0;
    let lastChangeAt = Date.now();
    let sawFirstToken = false;
    let polls = 0;
    // 2026-10 实测：流式输出过程中，前端会周期性把那条消息的节点整体拆掉重建，
    // 于是会出现「正文瞬间变空 + 停止键同时消失」的空窗（约 1~2 秒），随后正文
    // 才真正渲染出来。任何单次采样都不能当成「生成结束」的证据。
    let emptySamples = 0;

    for (;;) {
      if (signal?.aborted === true) {
        await this.ensurePage()
          .then((connection) => connection.evaluate(`(${pageClickStop.toString()})()`))
          .catch(() => false);
        throw new BrowserError('请求已取消', 'ABORTED');
      }
      await sleep(pollIntervalMs);
      polls += 1;
      const state = await this.status();

      // 没有可见正文 ≠ 没有回复：High 思考强度下可能长时间只有停止键、不吐正文。
      // 所以只有在「既没正文、也没在生成」持续超时后才判定失败。
      const idleTooLong = Date.now() - startedAt > this.settings.noResponseTimeoutMs;
      if (state.assistantCount === 0 && state.streaming !== true && idleTooLong) {
        await this.screenshot('no-reply');
        throw new BrowserError(
          `发送后 ${Math.round(this.settings.noResponseTimeoutMs / 1000)} 秒没有出现回复（页面提示：${state.snippet || '无'}）。可能被限流、需要人机验证，或输入过长。`,
          'NO_RESPONSE',
        );
      }

      const text = typeof state.lastText === 'string' ? state.lastText : '';
      if (text.length > 0 && !sawFirstToken) {
        sawFirstToken = true;
        this.log.info(`first token after ${Date.now() - startedAt}ms`);
      }
      if (text !== lastText) {
        lastText = text;
        stable = 0;
        lastChangeAt = Date.now();
        emptySamples = 0;
        yield { text };
      } else if (text.length > 0) {
        emptySamples = 0;
        stable += 1;
        const idleMs = Date.now() - lastChangeAt;
        const streaming = state.streaming === true;
        // 完成判据必须同时满足三条：停止键真的没了、重新生成按钮真的出现（生成结束才渲染）、
        // 文本已稳定若干个采样。缺任何一条都继续等——宁可慢，也不要交出半个工具调用。
        const settled =
          !streaming && state.hasRegenerate === true && stable >= 5 && idleMs >= 2500;
        // 兜底：某些 UI 版本没有「重新生成」按钮，只能靠「停止键消失 + 长时间不动」。
        const idleEnough = !streaming && idleMs >= Math.max(this.settings.idleFinishMs, 15000);
        // 最后兜底：停止键一直挂着但文本 90 秒完全不动，才认为真的结束了。
        const hardIdle = idleMs >= 90000;
        if (settled || idleEnough || hardIdle) {
          this.log.info(
            `reply finished after ${Date.now() - startedAt}ms (polls=${polls}, chars=${text.length}, ` +
              `settled=${settled}, idle=${idleEnough}, hard=${hardIdle}, ` +
              `toolbar=${state.hasRegenerate === true}, idleMs=${idleMs})`,
          );
          const limit = /(you've reached|you have reached|usage limit|limit reached|too many messages|你已(?:达到|用完)|次数已用完|消息上限)/i.exec(text);
          if (limit !== null) {
            throw new BrowserError(`ChatGPT 网页额度受限：${text.slice(0, 200)}`, 'QUOTA');
          }
          if (/(something went wrong|network error|an error occurred|发生错误)/i.test(text) && text.length < 300) {
            throw new BrowserError(`ChatGPT 网页端返回错误：${text.slice(0, 200)}`, 'UPSTREAM_ERROR');
          }
          return;
        }
      } else {
        // 空窗：不推进 stable，也不判结束；只有连续空太久且早就有过正文，才当成异常。
        emptySamples += 1;
        // 只在 20/60/120 次这几档记一笔，避免把日志刷爆
        if ([20, 60, 120].includes(emptySamples) && lastText.length === 0) {
          this.log.warn(`正文连续为空 ${emptySamples} 次采样（polls=${polls}），继续等待`);
        }
        // 长时间完全没有正文、也没有生成动作：说明这一轮真的卡死了，早点报错重试，
        // 而不是干等到 600 秒的 responseTimeout。
        if (emptySamples >= 240 && state.streaming !== true) {
          await this.screenshot('stalled-empty');
          throw new BrowserError(
            '这一轮 ChatGPT 网页端没有吐任何正文（一直在空转）。已自动重试；若持续失败建议在网页端手动发一次看是否正常。',
            'EMPTY_RETRY',
          );
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        await this.screenshot('timeout');
        throw new BrowserError(`等待回复超时（${Math.round(timeoutMs / 1000)}s）`, 'TIMEOUT');
      }
    }
  }

  async dispose() {
    if (this.connection !== null) {
      this.connection.close();
      this.connection = null;
    }
  }
}

export { CdpError };
