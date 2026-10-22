/** 开发期：在插件 Chrome 的当前页面执行一段 JS。node scripts/dom-eval.mjs '<expression>' */

import { CdpConnection, httpJson } from '../lib/cdp.js';

const expression = process.argv.slice(2).join(' ');
if (expression.length === 0) {
  console.error('usage: node scripts/dom-eval.mjs \'<js expression>\'');
  process.exit(2);
}

const targets = await httpJson('http://127.0.0.1:9333/json/list', { timeoutMs: 3000 });
const page = targets.find((target) => target.type === 'page');
const connection = await CdpConnection.attach(page.webSocketDebuggerUrl);
await connection.send('Runtime.enable', {});
const value = await connection.evaluate(expression, { timeoutMs: 20000 });
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
connection.close();
