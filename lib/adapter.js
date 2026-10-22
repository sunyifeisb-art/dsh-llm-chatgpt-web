/**
 * LlmAdapter 实现：把 DSH 的一次模型调用翻译成「在 ChatGPT 网页里发一条消息」。
 *
 * 流式约定（来自 @deepseek-ai/dsh-llm）：
 *   block-start → *-delta → block-end ... → usage → finish（恰好一次，且在最后）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';

import { BrowserError, ChatGptBrowser } from './browser.js';
import { TOOL_MARKER, buildPrompt, estimateTokens, parseReply } from './transcript.js';
import { expandHome } from './log.js';

const AUTH_CODES = new Set(['AUTH_REQUIRED']);

function mapError(error) {
  if (error instanceof LlmError) return error;
  const code = error instanceof BrowserError ? error.code : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  if (AUTH_CODES.has(code)) return new LlmError(message, 'MISSING_CREDENTIAL');
  if (code === 'CLOUDFLARE_BLOCKED') return new LlmError(message, 'AUTH');
  if (code === 'QUOTA') return new LlmError(message, 'QUOTA');
  if (code === 'ABORTED') return new LlmError(message, 'ABORTED');
  if (code === 'CHROME_UNAVAILABLE' || code === 'BROWSER_START_FAILED' || code === 'BROWSER_PAGE_FAILED') {
    return new LlmError(
      `连不上插件专用的 Chrome（${message}）。插件会自己重新拉起浏览器，稍等几秒再发一次即可；` +
        '如果反复失败，检查 chromePath 是否有效、调试端口是否被别的程序占用。',
      'UNKNOWN',
    );
  }
  return new LlmError(message, 'UNKNOWN');
}

/** 找出 marker 所在行的起点；没有则 -1。 */
function markerIndex(text) {
  const at = text.indexOf(`\n${TOOL_MARKER}`);
  if (at !== -1) return at + 1;
  if (text.startsWith(TOOL_MARKER)) return 0;
  return -1;
}

/**
 * 找出「工具调用块」在文本里的起点：json 代码围栏、或裸的 {"name": …}、
 * 或模型自己加的 "JSON" 小标题。从这一点往后都不该作为正文吐给用户，
 * 否则用户会看到一坨 JSON。
 */
function toolBlockStart(text) {
  const candidates = [];
  for (const token of ['```json', '```tool', '```tool_call', TOOL_MARKER]) {
    const at = text.indexOf(token);
    if (at !== -1) candidates.push(at);
  }
  const bare = /(?:^|\n)[ \t]*(?:JSON[ \t]*(?:\n|$)|\{[\s]*["']?name["']?[\s]*:)/i.exec(text);
  if (bare !== null) candidates.push(bare.index + (bare[0].startsWith('\n') ? 1 : 0));
  if (candidates.length === 0) return -1;
  return Math.min(...candidates);
}

/**
 * 当前这次快照里，最多可以安全地吐到第几个字符（不吐出行首可能的 marker 前缀）。
 */
function emittableLength(text) {
  const lastBreak = text.lastIndexOf('\n');
  const lastLine = text.slice(lastBreak + 1).trimStart();
  if (lastLine.length === 0) return text.length;
  if (TOOL_MARKER.startsWith(lastLine) || lastLine.startsWith('@')) {
    return lastBreak === -1 ? 0 : lastBreak;
  }
  return text.length;
}

function uniqueId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class ChatGptWebAdapter extends LlmAdapter {
  constructor(settings, log) {
    super();
    this.settings = settings;
    this.log = log;
    this.browser = new ChatGptBrowser(settings, log);
    this.#lockTail = Promise.resolve();
  }

  #lockTail;

  /** 网页版只有一个浏览器标签，必须串行。 */
  #acquire() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.#lockTail;
    this.#lockTail = previous.then(() => gate);
    return previous.then(() => release);
  }

  providerInfo(provider) {
    return { id: provider, name: this.settings.displayName };
  }

  async listModels(provider) {
    return this.settings.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      description: '通过浏览器驱动 ChatGPT 网页端（消耗网页额度，不是 API/Codex 额度）',
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider, model) {
    const found = this.settings.models.find((entry) => entry.id === model);
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      context: { contextWindow: this.settings.contextWindow },
      defaultMaxTokens: this.settings.defaultMaxTokens,
    };
  }

  async *stream(options) {
    if (this.settings.transport === 'fake') {
      yield* this.#streamFake(options);
      return;
    }
    yield* this.#streamWeb(options);
  }

  // -- 假流式：装好插件后不登录也能验证「选择器可见 + 流式结构正确」 -------------

  async *#streamFake(options) {
    const userText = (options.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''))
      .join(' ');
    const reply =
      `【自检模式】chatgpt-web（${options.model}）已安装成功。` +
      `收到 ${options.messages?.length ?? 0} 条消息、${(options.tools ?? []).length} 个工具、` +
      `${options.system ? '有' : '无'}系统提示。` +
      (userText ? `你最后说的是：${userText.slice(0, 80)}。` : '') +
      '切换到 transport=web 并登录 ChatGPT 后，这条回复就会来自真实网页端。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let i = 0; i < reply.length; i += 8) {
      yield { type: 'text-delta', index: 0, text: reply.slice(i, i + 8) };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    const inputTokens = estimateTokens(String(options.system ?? '') + userText);
    const outputTokens = estimateTokens(reply);
    yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  // -- 真实实现：浏览器 + 网页端 -------------------------------------------------

  async *#streamWeb(options) {
    const prompt = buildPrompt({
      system: options.system,
      messages: options.messages ?? [],
      tools: options.tools,
      toolEmulation: this.settings.emulateTools,
      maxChars: this.settings.maxPromptChars,
    });
    this.log.info(
      `stream start model=${options.model} messages=${options.messages?.length ?? 0} ` +
        `tools=${options.tools?.length ?? 0} promptChars=${prompt.length}`,
    );
    if (this.settings.debugPrompt !== false) {
      try {
        const dir = join(expandHome(this.settings.logDir), 'debug');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'last-prompt.txt'), prompt, 'utf8');
      } catch (error) {
        this.log.warn(`prompt dump failed: ${error?.message ?? error}`);
      }
    }

    const release = await this.#acquire();
    let startedText = false;
    let streamed = '';
    let lastText = '';
    let aborted = false;

    try {
      const iterator = this.browser.ask(prompt, {
        signal: options.signal,
        timeoutMs: this.settings.responseTimeoutMs,
        pollIntervalMs: this.settings.pollIntervalMs,
        // 只有「最后一轮是用户任务」时才强制工具调用；工具结果已经回来时，
        // 模型本来就该直接给结论，不能再按「编造」去重发。
        requireToolCall:
          this.settings.emulateTools === true &&
          Array.isArray(options.tools) &&
          options.tools.length > 0 &&
          (options.messages ?? []).at?.(-1)?.role === 'user',
      });

      for await (const snapshot of iterator) {
        lastText = snapshot.text;
        const blockAt = toolBlockStart(lastText);
        const toolAt = blockAt >= 0 ? blockAt : markerIndex(lastText);
        const limit = toolAt >= 0 ? toolAt : emittableLength(lastText);
        if (limit > streamed.length) {
          const piece = lastText.slice(streamed.length, limit);
          streamed = lastText.slice(0, limit);
          if (piece.length > 0) {
            if (!startedText) {
              startedText = true;
              yield { type: 'block-start', index: 0, blockType: 'text' };
            }
            yield { type: 'text-delta', index: 0, text: piece };
          }
        }
      }
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.code === 'ABORTED') {
        aborted = true;
        this.log.info('stream aborted by caller');
      } else {
        this.log.error(`stream failed: ${mapped.code} ${mapped.message}`);
        if (startedText) {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: streamed } };
        }
        yield { type: 'usage', usage: { inputTokens: estimateTokens(prompt), outputTokens: 0, totalTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'error', failure: { message: mapped.message, code: mapped.code } } };
        throw mapped;
      }
    } finally {
      release();
    }

    if (aborted) {
      if (startedText) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamed } };
      yield { type: 'usage', usage: { inputTokens: estimateTokens(prompt), outputTokens: 0, totalTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by caller', code: 'ABORTED' } } };
      return;
    }

    const parsed = parseReply(lastText);
    const visible = parsed.text;
    this.log.info(
      `reply preview: ${JSON.stringify(lastText.slice(0, 300))} ` +
        `(toolCalls=${parsed.toolCalls.length}, malformed=${parsed.malformed ?? 0})`,
    );
    if ((parsed.malformed ?? 0) > 0) {
      this.log.warn(`工具调用格式不完整（${parsed.malformed} 处），已从正文里剔除`);
    }
    if (visible.startsWith(streamed)) {
      const rest = visible.slice(streamed.length);
      if (rest.length > 0) {
        if (!startedText) {
          startedText = true;
          yield { type: 'block-start', index: 0, blockType: 'text' };
        }
        yield { type: 'text-delta', index: 0, text: rest };
      }
      streamed = visible;
    } else if (visible.length > streamed.length) {
      // 理论上不该发生（只会在解析裁剪位置异常时），直接把剩余部分补上。
      const rest = visible.slice(Math.min(streamed.length, visible.length));
      if (!startedText) {
        startedText = true;
        yield { type: 'block-start', index: 0, blockType: 'text' };
      }
      if (rest.length > 0) yield { type: 'text-delta', index: 0, text: rest };
      streamed = visible;
    }

    if (startedText) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: visible } };
    }

    let index = startedText ? 1 : 0;
    for (const call of parsed.toolCalls) {
      const id = uniqueId('call');
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } };
      index += 1;
    }

    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(lastText);
    yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };

    if (parsed.toolCalls.length > 0) {
      this.log.info(`stream finish: tool-calls=${parsed.toolCalls.length}`);
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (visible.trim().length === 0) {
      const error = new LlmError('ChatGPT 网页端没有返回可见内容', 'EMPTY_RESPONSE');
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error.message, code: error.code } } };
      throw error;
    }
    this.log.info(`stream finish: stop chars=${visible.length}`);
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  async dispose() {
    await this.browser.dispose();
  }
}
