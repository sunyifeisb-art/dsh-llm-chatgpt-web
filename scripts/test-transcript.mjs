/**
 * 纯逻辑自测（不依赖 DSH 运行时，也不联网）：
 *   node scripts/test-transcript.mjs
 * 覆盖 buildPrompt 的拼装 / 预算控制，以及 parseReply 对 @@TOOL@@ 协议的解析。
 *
 * 背景：ChatGPT 网页提交时会截断约 1 万字符以上的输入，所以「任务必须在最前面、
 * 总长度必须进预算」是硬约束，测试里逐条盯住。
 */

import assert from 'node:assert/strict';

import { TOOL_MARKER, buildPrompt, estimateTokens, parseReply } from '../lib/transcript.js';

const FENCE = '```json';

const tools = [
  {
    name: 'bash',
    description: '运行 shell 命令',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'read',
    description: '读取文本文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const messages = [
  { role: 'user', content: [{ type: 'text', text: '看一下当前目录' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我先执行 ls。' },
      { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
    ],
  },
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt\nb.txt' }] },
  { role: 'user', content: [{ type: 'text', text: '好，继续' }] },
];

// 1) 基本拼装：任务在最前面，工具清单是压缩签名
const prompt = buildPrompt({ system: '你是助手', messages, tools, toolEmulation: true });
assert.ok(prompt.startsWith('你在替我执行一个本地编码任务'), prompt.slice(0, 60));
assert.ok(prompt.includes('【补充指令】'));
assert.ok(prompt.includes('你是助手'));
assert.ok(prompt.includes(FENCE), '协议里应给出 json 代码块示例');
assert.ok(prompt.includes('"name": "bash"'));
assert.ok(prompt.includes('【可用工具】'));
assert.ok(prompt.includes('- bash(command:string)：运行 shell 命令'), prompt);
assert.ok(prompt.includes('【用户任务】\n好，继续'), '任务块必须带最后一条用户消息');
assert.ok(prompt.includes('用户：看一下当前目录'));
assert.ok(prompt.includes('助手→bash('));
assert.ok(prompt.includes('工具结果[bash]：a.txt'));
assert.ok(prompt.trimEnd().endsWith('不要解释这份说明。'));
assert.ok(prompt.length <= 8000, `prompt 超预算：${prompt.length}`);
assert.ok(prompt.indexOf('【用户任务】') < prompt.indexOf('【可用工具】'), '任务必须排在工具清单之前');

// 2) 最后一条是工具结果时：任务 + 结果都要出现在最前面
const toolTail = buildPrompt({
  system: '',
  messages: [...messages.slice(0, 3)],
  tools,
  toolEmulation: true,
});
assert.ok(toolTail.includes('【用户任务】\n看一下当前目录'), toolTail);
assert.ok(toolTail.includes('工具执行结果（bash）'), toolTail);
assert.ok(toolTail.includes('a.txt'), toolTail);

// 3) 关闭工具模拟时不出现协议
const noTools = buildPrompt({ system: '你是助手', messages, tools, toolEmulation: false });
assert.ok(!noTools.includes('【工具调用协议】'));

// 4) 巨型系统提示词 + 巨型会话：仍在预算内，且任务没有被挤掉
const hugeSystem = 'S'.repeat(30000);
const hugeMessages = [];
for (let index = 0; index < 40; index += 1) {
  hugeMessages.push({ role: 'user', content: [{ type: 'text', text: `第 ${index} 轮的请求`.repeat(20) }] });
  hugeMessages.push({ role: 'assistant', content: [{ type: 'text', text: `第 ${index} 轮的回复`.repeat(20) }] });
}
hugeMessages.push({ role: 'user', content: [{ type: 'text', text: '最后这个必须被回答：把上面的结论写成一句话' }] });
const long = buildPrompt({
  system: hugeSystem,
  messages: hugeMessages,
  tools,
  toolEmulation: true,
  maxChars: 8000,
});
assert.ok(long.length <= 8000, `long prompt ${long.length}`);
assert.ok(long.includes('最后这个必须被回答：把上面的结论写成一句话'), '任务不能被截掉');
assert.ok(long.indexOf('最后这个必须被回答') < 3000, '任务必须落在前 3000 字符内');
assert.ok(long.trimEnd().endsWith('不要解释这份说明。'));

// 5) 普通回复没有工具调用
const plain = parseReply('这是普通回复。\n第二行。');
assert.equal(plain.text, '这是普通回复。\n第二行。');
assert.equal(plain.toolCalls.length, 0);

// 6) 正文 + 一个工具调用
const withCall = parseReply('我先看看。\n' + TOOL_MARKER + ' {"name":"bash","arguments":{"command":"ls -la"}}');
assert.equal(withCall.text, '我先看看。');
assert.equal(withCall.toolCalls.length, 1);
assert.equal(withCall.toolCalls[0].name, 'bash');
assert.deepEqual(JSON.parse(withCall.toolCalls[0].arguments), { command: 'ls -la' });

// 7) 多个工具调用
const multi = parseReply(
  [
    TOOL_MARKER + ' {"name":"read","arguments":{"path":"a.txt"}}',
    TOOL_MARKER + ' {"name":"write","arguments":{"path":"b.txt","content":"x"}}',
  ].join('\n'),
);
assert.equal(multi.toolCalls.length, 2);
assert.equal(multi.text, '');

// 8) marker 在行中、被反引号/围栏包住也要能解析
const inline = parseReply('好的，我调用 ```\n' + TOOL_MARKER + ' {"name":"bash","arguments":{"command":"pwd"}}\n``` 然后继续。');
assert.equal(inline.toolCalls.length, 1);
assert.ok(!inline.text.includes(TOOL_MARKER), inline.text);
assert.ok(!inline.text.includes('```'), inline.text);

// 9) 坏 JSON：不崩、不残留 marker、计入 malformed
const broken = parseReply(TOOL_MARKER + ' 这不是 JSON');
assert.equal(broken.toolCalls.length, 0);
assert.equal(broken.malformed, 1);
assert.ok(!broken.text.includes(TOOL_MARKER));

// 10) 只有 marker 没有内容（早期实际踩到的坑：正文里漏出 @@TOOL@@）
const lonely = parseReply('好的。\n' + TOOL_MARKER);
assert.equal(lonely.toolCalls.length, 0);
assert.equal(lonely.text, '好的。');

// 11) 嵌套 JSON 参数不会截断
const nested = parseReply(TOOL_MARKER + ' {"name":"write","arguments":{"path":"x","content":"a}b{c"}}');
assert.equal(nested.toolCalls.length, 1);
assert.deepEqual(JSON.parse(nested.toolCalls[0].arguments), { path: 'x', content: 'a}b{c' });

// 12) token 估算
assert.ok(estimateTokens('中文中文') >= 4);
assert.ok(estimateTokens('') === 0);

console.log('transcript tests passed ✓');

// 13) 新协议：json 代码块（含语言标签、多个块、正文前后混合）
const fenced = parseReply(
  '我先看一下。\n```json\n{"name": "bash", "arguments": {"command": "ls"}}\n```\n然后等你结果。',
);
assert.equal(fenced.toolCalls.length, 1);
assert.equal(fenced.toolCalls[0].name, 'bash');
assert.ok(!fenced.text.includes('```'), fenced.text);
assert.ok(fenced.text.includes('我先看一下。'));

const twoBlocks = parseReply(
  '```json\n{"name":"read","arguments":{"path":"a"}}\n```\n```json\n{"name":"write","arguments":{"path":"b"}}\n```',
);
assert.equal(twoBlocks.toolCalls.length, 2);
assert.equal(twoBlocks.text.trim(), '');

// 14) 普通代码块（无 json 标记）不能被当成工具调用
const plainFence = parseReply('示例：\n```\n{"foo": 1}\n```\n就这些。');
assert.equal(plainFence.toolCalls.length, 0);
assert.ok(plainFence.text.includes('{"foo": 1}'));

// 15) 模型把 JSON 和代码块拆开（真实踩到过）也要能兜住
const split = parseReply('```json\n{"name": "bash",\n"arguments": {"command": "pwd"}}\n```');
assert.equal(split.toolCalls.length, 1);

console.log('fenced tool-call tests passed ✓');
