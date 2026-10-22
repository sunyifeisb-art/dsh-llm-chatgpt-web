/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 只用 Node 内置能力：fetch 拿 /json/* 列表，全局 WebSocket（Node >= 22）拿 CDP 通道。
 * 不引第三方依赖，避免 profile 里 pnpm/npm 缓存权限问题。
 */

export class CdpError extends Error {
  constructor(message, code = 'CDP_ERROR') {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

/** GET/PUT 一个返回 JSON 的 HTTP 端点（CDP 的 /json/version、/json/list、/json/new）。 */
export async function httpJson(url, { method = 'GET', timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new CdpError(`HTTP ${response.status} from ${url}`, 'CDP_HTTP');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class CdpConnection {
  /**
   * @param {string} wsUrl 目标页的 webSocketDebuggerUrl
   */
  static async attach(wsUrl, { timeoutMs = 10000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('CDP websocket open timeout', 'CDP_TIMEOUT')), timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (event) => {
          clearTimeout(timer);
          reject(new CdpError(`CDP websocket error: ${event?.message ?? 'unknown'}`, 'CDP_WS'));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws);
  }

  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('message', (event) => this.#handleMessage(event.data));
    ws.addEventListener('close', () => this.#handleClose());
  }

  get closed() {
    return this.#closed;
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CdpError(`${message.error.message} (${message.error.code ?? 'error'})`, 'CDP_METHOD'));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') {
      const listeners = this.#listeners.get(message.method);
      if (listeners === undefined) return;
      for (const listener of [...listeners]) {
        try {
          listener(message.params ?? {});
        } catch {
          /* 监听器异常不影响通道 */
        }
      }
    }
  }

  #handleClose() {
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError('CDP connection closed', 'CDP_CLOSED'));
    }
    this.#pending.clear();
  }

  on(method, listener) {
    let listeners = this.#listeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  send(method, params = {}, { timeoutMs = 20000 } = {}) {
    if (this.#closed) return Promise.reject(new CdpError('CDP connection closed', 'CDP_CLOSED'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`CDP command timeout: ${method}`, 'CDP_TIMEOUT'));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(`CDP send failed: ${error instanceof Error ? error.message : String(error)}`, 'CDP_WS'));
      }
    });
  }

  /**
   * 在页面上下文求值，返回 JSON 可序列化的值。
   * 页面里的异常会被翻译成 CdpError，方便上层统一处理。
   */
  async evaluate(expression, { timeoutMs = 15000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true, includeCommandLineAPI: false },
      { timeoutMs },
    );
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const text =
        detail?.exception?.description ?? detail?.exception?.value ?? detail?.text ?? 'unknown page exception';
      throw new CdpError(`page evaluate failed: ${String(text).split('\n')[0]}`, 'CDP_EVALUATE');
    }
    const remote = result.result ?? {};
    if (remote.subtype === 'error') {
      throw new CdpError(`page evaluate failed: ${remote.description ?? 'error'}`, 'CDP_EVALUATE');
    }
    return remote.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}
