# dsh-llm-chatgpt-web

[English](#english) · [简体中文](#简体中文)

---

## English

A **ChatGPT Web model provider for DeepSeek Harness**. It adds a model route named `chatgpt-web` and answers model calls by driving **your own logged-in chatgpt.com session** in a local Chrome — so inference is paid from the **ChatGPT web quota**, not from the OpenAI API and **not from your Codex quota**.

- ✅ Spends the ChatGPT **web** plan quota (the same pool you use chatting on chatgpt.com)
- ❌ Does **not** use `~/.codex/auth.json`, Codex OAuth, or Codex quota
- ❌ No API key, no proxy server, no account sharing

### Why a browser and not plain HTTP

ChatGPT's web backend (`/backend-api/f/conversation`) requires a per-request Sentinel/PoW token plus Cloudflare clearance. Those cannot be forged reliably outside a real browser session. So this plugin drives a real Chromium-family browser over the DevTools Protocol (zero dependencies — Node's built-in `WebSocket`) and reads the answer from the page.

### Requirements

- A Chromium-family browser (Chrome, Edge, Chromium)
- DeepSeek Harness 0.2.x
- A ChatGPT account, signed in **once** inside the plugin's own browser profile

### Install

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-llm-chatgpt-web
# or, inside the Harness: plugin_manager install_bundle <absolute path>
```

The bundle inserts one row:

```yaml
- id: llm-chatgpt-web
  name: dsh-llm-chatgpt-web
  config: {}
```

### First run: sign in once

1. Pick **ChatGPT Web** in the model selector and send anything.
2. The plugin opens a dedicated Chrome window on the ChatGPT login page and reports that web sign-in is still missing.
3. Sign in inside **that** window. The session is stored in the plugin's own profile (`~/.dsh/chatgpt-web/chrome-profile`), not in your daily browser.
4. Send again.

The dedicated browser starts on demand **in the background** (macOS: `open -g -j`) and is **re-launched automatically** if you close it, without stealing focus from the window you are working in. The one exception is a sign-in prompt: the plugin then moves the window on screen and activates it, because you cannot type into a login page you cannot see.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `chatgpt-web` | Route id used by the model selector |
| `displayName` | `ChatGPT 网页版` | Label shown in DSH |
| `transport` | `web` | `fake` = offline self-test stream |
| `chromePath` | Google Chrome (macOS path) | Browser executable |
| `userDataDir` | `~/.dsh/chatgpt-web/chrome-profile` | Dedicated browser profile (login lives here) |
| `debuggingPort` | `9333` | CDP port for the dedicated browser |
| `windowMode` | `hidden` | `visible` / `hidden` (window moved off-screen, launched in the background) / `headless` (blocked by ChatGPT — not recommended) |
| `temporaryChat` | `true` | Use a temporary chat each call, so nothing is written to your ChatGPT history |
| `reasoningEffort` | `high` | Aligns the web "thinking effort" slider before every call (`low` / `medium` / `high`) |
| `webModel` | empty | Optionally force a web model such as `GPT-6`; empty keeps the page's current pick |
| `maxPromptChars` | `60000` | Prompt budget in characters |
| `emulateTools` | `true` | Emulate function calling with a text protocol (see below) |
| `responseTimeoutMs` | `600000` | Max wait for one reply |

### Tool calling

The web UI has no function-calling API. The plugin asks the model for a fenced JSON block:

```json
{"name": "bash", "arguments": {"command": "ls"}}
```

and translates it into a real DSH `tool-call`; the tool result is pasted back into the next turn. The prompt explicitly forbids the model's own container/code-interpreter from being used, and a reply that claims it ran something without a tool call is rejected and retried.

### Known limitations

- **Serial**: one browser tab, so model calls queue.
- **Every turn re-sends the task + tools + recent history** (temporary chat means no server-side carry-over). Each step takes roughly 10–40 s with `reasoningEffort=high`.
- **Text only**: images are not forwarded.
- **Depends on chatgpt.com DOM**: when OpenAI ships a redesign, selectors may need updating. Failures save a screenshot to `~/.dsh/chatgpt-web/logs/screenshots/`.
- **Not a security boundary**: the plugin runs with your local user permissions and your own ChatGPT session. Review the source before installing.

### Troubleshooting

- Logs: `~/.dsh/chatgpt-web/logs/chatgpt-web-YYYY-MM-DD.log`
- Last prompt sent: `~/.dsh/chatgpt-web/logs/debug/last-prompt.txt`
- Unit tests: `node scripts/test-transcript.mjs`

### License

MIT.

---

## 简体中文

把 **ChatGPT 网页端** 接成 DeepSeek Harness 的模型路由（路由 id：`chatgpt-web`）。选它之后，DSH 每次模型调用都会用**你本机已登录的 chatgpt.com 会话**、在本地 Chrome 里完成，因此消耗的是 **ChatGPT 网页额度**——不是 OpenAI API 额度，**也不是 Codex 额度**。

- ✅ 花 ChatGPT 网页版套餐额度（和在网页上聊天同一个池子）
- ❌ 不读 `~/.codex/auth.json`、不走 Codex OAuth、不花 Codex 额度
- ❌ 不需要 API key、不需要中转服务器、不共享账号

### 为什么必须是浏览器

ChatGPT 网页后端（`/backend-api/f/conversation`）要逐请求变化的 Sentinel/PoW 令牌和 Cloudflare 放行，离开真实浏览器会话伪造不出来。所以插件用 DevTools 协议驱动一个真实 Chromium 浏览器（零依赖，只用 Node 内置 `WebSocket`），从页面里读回复。

### 安装

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-llm-chatgpt-web
```

### 首次使用：登录一次

1. 模型选择器里选 **ChatGPT 网页版**，随便发一句。
2. 插件会打开一个专用 Chrome 窗口，停在登录页。
3. 在**那个**窗口里登录（账号密码或 Google 都行），登录态存在插件自己的 profile 里。
4. 回来再发一次。

浏览器是**后台按需启动**的（macOS 用 `open -g -j`），不会抢你正在用的窗口的焦点；你手动关掉它也会自动重新拉起。唯一例外是**需要登录**：这时插件会把窗口挪回屏幕内并激活，否则你看不见登录页。

### 已知限制

- 单浏览器标签，调用串行排队。
- 每轮都要重新贴「任务 + 工具 + 最近记录」（用临时对话，不污染历史），`reasoningEffort=high` 时一步通常 10–40 秒。
- 暂不支持图片输入。
- 依赖 chatgpt.com 的 DOM，改版可能要跟进选择器；失败会自动截图到 `~/.dsh/chatgpt-web/logs/screenshots/`。
- 不是安全沙箱：插件用你的本地用户权限和你自己的 ChatGPT 会话，装前请读源码。

### 许可

MIT。
