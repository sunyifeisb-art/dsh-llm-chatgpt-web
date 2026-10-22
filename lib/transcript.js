/**
 * DSH 会话 → 一段可粘贴进 ChatGPT 网页输入框的文本；以及回复里工具调用的解析。
 *
 * 硬约束（2026-10 实测后的结论）：
 *   1. 【当前任务】放最前面 —— 万一被截断，模型也不会跑去回答工具清单；
 *   2. 超长文本必须分块写进输入框：一次性 CDP insertText 9 万字符只会进去 1 万
 *      （插件已在 browser.js 里分块，并校验输入框长度）；
 *   3. 即便能长，也要压：网页端没有 function calling，工具越多模型越容易跑偏，
 *      所以工具清单用压缩签名，历史用紧凑记录。
 *
 * 网页版没有 function calling 协议，也没有 messages 数组，所以用一行纯文本协议
 * 表达工具调用：@@TOOL@@ {"name":"..","arguments":{..}}（不用 markdown 围栏，因为
 * DOM innerText 可能丢掉围栏）。
 */

export const TOOL_MARKER = '@@TOOL@@';

/** 总的字符预算（网页端可接受很长，但越短模型越跟得住任务）。 */
const DEFAULT_BUDGET = 48000;

const CAP_TOOL_DESC = 130;
const MAX_TOOL_PARAMS = 6;

/** 按总预算切分配额，换预算时各段等比缩放。 */
function capsFor(budget) {
  return {
    task: Math.max(1200, Math.round(budget * 0.22)),
    toolResult: Math.max(800, Math.round(budget * 0.12)),
    contextMessage: Math.max(200, Math.round(budget * 0.02)),
    toolCallArgs: Math.max(120, Math.round(budget * 0.008)),
    system: Math.max(600, Math.round(budget * 0.05)),
    toolList: Math.max(1200, Math.round(budget * 0.3)),
  };
}

/** 这些工具优先展示（网页版一次只发一段文本，工具越多模型越容易跑偏）。 */
const CORE_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'todo_write',
  'job_output',
  'job_list',
  'job_kill',
];

/** 去掉 DSH 注入的大块噪声（技能目录、system-reminder、压缩摘要标记）。 */
function stripInjected(text) {
  return String(text ?? '')
    .replace(/<available-skills>[\s\S]*?<\/available-skills>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<acp [^>]*>[\s\S]*?<\/acp>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 这条 user 消息是不是 DSH 合成的（不是用户真正说的话）。 */
function isSyntheticUserMessage(raw) {
  const text = String(raw ?? '').trimStart();
  if (text.startsWith('<system-reminder')) return true;
  if (/^Time sampled while preparing turn/m.test(text)) return true;
  return false;
}

function cap(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  const head = Math.max(0, limit - 60);
  return `${value.slice(0, head)}…（省略 ${value.length - head} 字）`;
}

/** 中间的日志类文本：留头留尾，比只留头更有信息量。 */
function capMiddle(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  const half = Math.floor((limit - 60) / 2);
  return `${value.slice(0, half)}…（省略 ${value.length - half * 2} 字）…${value.slice(-half)}`;
}

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool-call');
}

/** 把 JSON Schema 压成 `path:string, mode?:string*` 这种一行签名。 */
function parameterSignature(parameters) {
  const schema = parameters;
  if (schema === null || typeof schema !== 'object') return '';
  const props = schema.properties;
  if (props === null || typeof props !== 'object') return '';
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const parts = [];
  for (const [key, value] of Object.entries(props)) {
    if (parts.length >= MAX_TOOL_PARAMS) {
      parts.push('…');
      break;
    }
    const type = value?.type ?? (Array.isArray(value?.enum) ? 'enum' : 'any');
    const enumHint = Array.isArray(value?.enum) && value.enum.length > 0 && value.enum.length <= 5
      ? `=${value.enum.map((item) => String(item)).join('|')}`
      : '';
    parts.push(`${key}:${type}${enumHint}${required.has(key) ? '' : '?'}`);
  }
  return parts.join(', ');
}

function renderToolList(tools, budget) {
  const entries = [];
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name.length === 0) continue;
    const description = String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, CAP_TOOL_DESC);
    const signature = parameterSignature(tool.parameters ?? {});
    entries.push({
      rank: CORE_TOOLS.includes(tool.name) ? CORE_TOOLS.indexOf(tool.name) : CORE_TOOLS.length + 100,
      line: `- ${tool.name}(${signature})：${description}`,
    });
  }
  entries.sort((left, right) => left.rank - right.rank);

  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const entry of entries) {
    if (used + entry.line.length + 1 > budget) {
      omitted += 1;
      continue;
    }
    used += entry.line.length + 1;
    lines.push(entry.line);
  }
  if (omitted > 0) lines.push(`- 另有 ${omitted} 个工具本次未列出（如确需，请说明用途）。`);
  return lines.join('\n');
}

/** 把「除最后一条任务消息之外」的历史压成紧凑记录，从近到远取，直到用完预算。 */
function renderContext(messages, { skipMessage, skipToolMessage, budget, toolNames, caps }) {
  if (budget <= 0) return '';
  const rendered = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    if (message === skipMessage || message === skipToolMessage) continue;
    const role = message.role;
    const content = message.content;
    const chunks = [];
    if (role === 'system' || role === 'developer') continue;
    if (role === 'user') {
      const raw = blockText(content);
      if (isSyntheticUserMessage(raw)) continue;
      const text = stripInjected(raw);
      if (text.length === 0) continue;
      chunks.push(`用户：${cap(text, caps.contextMessage)}`);
    } else if (role === 'assistant') {
      const text = stripInjected(blockText(content));
      if (text.length > 0) chunks.push(`助手：${cap(text, caps.contextMessage)}`);
      for (const call of toolCallsOf(content)) {
        let args = call.arguments;
        if (typeof args !== 'string') {
          try {
            args = JSON.stringify(args ?? {});
          } catch {
            args = '{}';
          }
        }
        chunks.push(`助手→${call.name}(${cap(args, caps.toolCallArgs)})`);
      }
    } else if (role === 'tool') {
      const name = toolNames.get(message.toolCallId) ?? 'tool';
      const text = stripInjected(blockText(content));
      const flag = message.isError === true ? '失败' : '结果';
      chunks.push(`工具${flag}[${name}]：${capMiddle(text, caps.contextMessage)}`);
    }
    if (chunks.length === 0) continue;
    const block = chunks.join('\n');
    if (used + block.length > budget) break;
    used += block.length + 1;
    rendered.push(block);
  }
  return rendered.reverse().join('\n');
}

/**
 * 把一次调用压成「任务在前的短提示词」。
 * @param {{ system?: string, messages: readonly any[], tools?: readonly any[], toolEmulation?: boolean, maxChars?: number }} input
 * @returns {string}
 */
export function buildPrompt({ system, messages, tools, toolEmulation = true, maxChars = DEFAULT_BUDGET }) {
  const budget = Math.max(2000, Number(maxChars) || DEFAULT_BUDGET);
  const caps = capsFor(budget);
  const list = Array.isArray(messages) ? messages : [];

  const toolNames = new Map();
  for (const message of list) {
    for (const call of toolCallsOf(message?.content)) {
      if (typeof call.id === 'string') toolNames.set(call.id, call.name);
    }
  }

  // 1. 找到「当前任务」：最后一条真正的用户消息；若最后一条是工具结果，则两者都要。
  let lastUserIndex = -1;
  let lastUserText = '';
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const raw = blockText(message.content);
    if (isSyntheticUserMessage(raw)) continue;
    const text = stripInjected(raw);
    if (text.length === 0) continue;
    lastUserIndex = index;
    lastUserText = text;
    break;
  }
  const lastMessage = list.length > 0 ? list[list.length - 1] : undefined;
  const lastIsTool = lastMessage?.role === 'tool';

  let taskBlock;
  let skipToolMessage;
  if (lastIsTool) {
    const name = toolNames.get(lastMessage.toolCallId) ?? 'tool';
    const text = stripInjected(blockText(lastMessage.content));
    const flag = lastMessage.isError === true ? '工具执行失败' : '工具执行结果';
    skipToolMessage = lastMessage;
    taskBlock =
      `【用户任务】\n${cap(lastUserText, caps.task)}\n\n` +
      `【刚刚的${flag}（${name}）】\n${capMiddle(text, caps.toolResult)}\n\n` +
      '请根据这个结果继续推进任务：需要更多信息就继续调用工具，任务做完就直接给出最终答复。';
  } else {
    taskBlock = `【用户任务】\n${cap(lastUserText, caps.task)}`;
  }

  const systemText = cap(stripInjected(system), caps.system);
  const header =
    '你在替我执行一个本地编码任务。我这边有一个执行环境，可以按你的要求调用工具并把结果贴回来。' +
    '请直接推进任务，不要复述下面这些说明。';

  const protocol = toolEmulation && Array.isArray(tools) && tools.length > 0
    ? `【怎么调用工具】
需要执行命令/读写文件时，输出一个 json 代码块，块里只有一个对象，包含 name 和 arguments 两个字段：
\`\`\`json
{"name": "bash", "arguments": {"command": "你要执行的命令"}}
\`\`\`
规则：
- 代码块里必须是完整合法的 JSON，两个字段都不能少；一次可以给多个代码块。
- 只调用工具时，代码块之外不要写别的文字；不需要工具时用中文正常回答。
- 你界面自带的容器/代码解释器/联网工具都不是我这台电脑，不要用，也不要把它们的运行结果写进回复。
- 在收到【工具执行结果】之前，不要写「已执行」「输出是」「共 N 个」这类结论，也不要猜结果。`
    : '';

  const rules =
    '【输出要求】只输出你此刻要对用户说的话（或工具调用行），不要复述 prompt，不要加「用户：」「助手：」前缀，不要解释这份说明。';

  const fixed = [header, systemText.length > 0 ? `【补充指令】\n${systemText}` : '', taskBlock, protocol, rules]
    .filter((part) => part.length > 0)
    .join('\n\n');

  let remaining = budget - fixed.length - 2;
  let toolList = '';
  if (protocol.length > 0) {
    const toolBudget = Math.max(600, Math.min(caps.toolList, Math.floor(remaining * 0.6)));
    toolList = renderToolList(tools, toolBudget);
    remaining -= toolList.length + 20;
  }

  const context = renderContext(list, {
    skipMessage: lastUserIndex >= 0 ? list[lastUserIndex] : undefined,
    skipToolMessage,
    budget: Math.max(0, remaining - 60),
    toolNames,
    caps,
  });

  const parts = [header];
  if (systemText.length > 0) parts.push(`【补充指令】\n${systemText}`);
  parts.push(taskBlock);
  if (protocol.length > 0) parts.push(protocol);
  if (toolList.length > 0) parts.push(`【可用工具】\n${toolList}`);
  if (context.length > 0) parts.push(`【最近记录（从旧到新）】\n${context}`);
  parts.push(rules);

  let prompt = parts.join('\n\n');
  if (prompt.length > budget) {
    // 兜底：先砍最近记录，再砍工具清单，最后砍任务正文，保证协议与任务仍在最前面。
    const overflow = prompt.length - budget;
    if (context.length >= overflow) {
      parts.splice(parts.indexOf(`【最近记录（从旧到新）】\n${context}`), 1);
    } else {
      parts.splice(parts.indexOf(`【可用工具】\n${toolList}`), 1);
    }
    prompt = parts.join('\n\n');
  }
  if (prompt.length > budget) prompt = cap(prompt, budget);
  return prompt;
}

function safeJson(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 从网页回复里拆出「可见正文」和「工具调用」。
 * 容错：marker 不一定在行首、可能被反引号/代码围栏包住、可能跨行。
 * @returns {{ text: string, toolCalls: { name: string, arguments: string }[], malformed: number }}
 */
export function parseReply(raw) {
  const source = String(raw ?? '');
  const toolCalls = [];
  let malformed = 0;
  let text = source;

  // 1) 优先按「json 代码块」解析（当前协议）：```json {..} ```，一个块一个调用。
  //    只认带 json/tool 语言标记的块，避免把正文里的普通代码块误当工具调用。
  //    但 ChatGPT 网页把代码块渲染成纯文本时，语言标记会掉，只剩下正文里的
  //    「JSON」小标题 + 裸 JSON 对象 —— 这种情况在下面第 2 步兜住。
  const fencePattern = /```(?:json|tool|tool_call)\s*\n([\s\S]*?)```/g;
  const spans = [];
  for (;;) {
    const match = fencePattern.exec(text);
    if (match === null) break;
    const body = match[1].trim();
    const parsed = tryParseToolCall(body);
    if (parsed !== null) {
      toolCalls.push(parsed);
      spans.push([match.index, match.index + match[0].length]);
    }
  }

  // 1b) 兜底：没有围栏标记的裸 JSON 对象（前面常带一个 "JSON" 小标题）。
  if (toolCalls.length === 0 && /["']?name["']?\s*:/.test(text)) {
    const barePattern = /\{\s*"name"\s*:[\s\S]*?\}\s*\}/g;
    for (;;) {
      const match = barePattern.exec(text);
      if (match === null) break;
      const parsed = tryParseToolCall(match[0]);
      if (parsed === null) continue;
      toolCalls.push(parsed);
      text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    }
  }

  // 2) 兼容旧协议：行内 @@TOOL@@ 加 JSON。
  let index = text.indexOf(TOOL_MARKER);
  while (index !== -1) {
    const after = text.slice(index + TOOL_MARKER.length);
    const brace = after.indexOf('{');
    if (brace === -1 || brace > 400) {
      malformed += 1;
      text = text.slice(0, index) + text.slice(index + TOOL_MARKER.length);
      index = text.indexOf(TOOL_MARKER);
      continue;
    }
    const candidate = after.slice(brace);
    const jsonEnd = findJsonEnd(candidate);
    const parsed = jsonEnd === -1 ? null : tryParseToolCall(candidate.slice(0, jsonEnd + 1));
    if (parsed !== null) {
      toolCalls.push(parsed);
      const from = index;
      const to = index + TOOL_MARKER.length + brace + jsonEnd + 1;
      text = text.slice(0, from) + text.slice(to);
    } else {
      malformed += 1;
      text = text.slice(0, index) + text.slice(index + TOOL_MARKER.length);
    }
    index = text.indexOf(TOOL_MARKER);
  }

  // 3) 把已消费的代码块从正文里摘掉（从后往前，避免下标漂移）。
  for (const [from, to] of spans.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, from) + text.slice(to);
  }

  // 4) 正文里残留的围栏标记、"""JSON" 之类前缀清理掉。
  let visible = text
    .replace(/```[a-zA-Z0-9+#._-]*/g, '')
    .replace(/^\s*(?:JSON|json)\s*:?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: visible, toolCalls, malformed };
}

/** 尝试把一个 JSON 文本当成工具调用解析；不是合法调用就返回 null。 */
function tryParseToolCall(candidate) {
  const trimmed = String(candidate ?? '').trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  const end = findJsonEnd(trimmed.slice(start));
  if (end === -1) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed.slice(start, start + end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (name.length === 0) return null;
  const args = parsed.arguments ?? parsed.args ?? {};
  return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

/** 找到第一个「配平」的 JSON 对象结尾下标；找不到返回 -1。 */
function findJsonEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 粗估 token（CJK 按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token）。 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (value.length === 0) return 0;
  let cjk = 0;
  for (const char of value) {
    if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)) cjk += 1;
  }
  const rest = value.length - cjk;
  return cjk + Math.ceil(rest / 4);
}
