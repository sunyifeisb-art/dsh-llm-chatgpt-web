/**
 * DOM 取证：连到插件 Chrome 的当前页面，把消息区结构打出来。
 *   node scripts/dom-inspect.mjs
 */

import { CdpConnection, httpJson } from '../lib/cdp.js';

const list = await httpJson('http://127.0.0.1:9333/json/list');
const pages = (list ?? []).filter((target) => target.type === 'page' && String(target.url).includes('chatgpt.com'));
const page = pages[pages.length - 1];
if (!page) {
  console.error('没有 chatgpt.com 页面');
  process.exit(1);
}
const cdp = await CdpConnection.attach(page.webSocketDebuggerUrl);

const expression = `(() => {
  const out = { url: location.href, title: document.title.slice(0, 80) };
  out.userMessageCount = document.querySelectorAll('[class*="user-message"]').length;
  out.markdownRootCount = document.querySelectorAll('[class*="MarkdownRoot"]').length;
  out.markdownTexts = [...document.querySelectorAll('[class*="MarkdownRoot"]')].map((n) => (n.innerText || '').slice(0, 500));
  out.userTexts = [...document.querySelectorAll('[class*="user-message"]')].map((n) => (n.innerText || '').slice(0, 120));
  const article = [...document.querySelectorAll('article')];
  out.articleCount = article.length;
  out.lastArticleText = article.length > 0 ? (article[article.length - 1].innerText || '').slice(0, 600) : '';
  out.composerText = (() => {
    const el = document.querySelector('#prompt-textarea,[data-testid="composer"] [contenteditable="true"],form [contenteditable="true"],div[contenteditable="true"][role="textbox"]');
    return el ? (el.innerText || el.textContent || '').slice(0, 200) : null;
  })();
  const turnCandidates = {};
  for (const attr of ['data-testid','data-turn','data-message-author-role','data-message-id']) {
    turnCandidates[attr] = [...new Set([...document.querySelectorAll('[' + attr + ']')].map((n) => n.getAttribute(attr)).filter(Boolean))].slice(0, 12);
  }
  out.turnCandidates = turnCandidates;
  return JSON.stringify(out, null, 2);
})()`;

const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
console.log(result?.result?.value ?? JSON.stringify(result).slice(0, 2000));
await cdp.close?.();
process.exit(0);
