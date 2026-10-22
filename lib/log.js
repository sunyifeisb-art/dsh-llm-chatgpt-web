/**
 * 文件日志。
 *
 * 为什么不用 ctx.logger：插件跑在 DSH 主进程里，主进程日志窗口很难看到；
 * 把关键步骤写进独立文件，排障时可以直接 tail，用户也能把文件发给维护者。
 * 只用 fs.appendFileSync，不删除、不轮转（按天分文件）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function stamp() {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

export function createLog({ dir, enabled = true, label = 'chatgpt-web' } = {}) {
  const logDir = expandHome(dir ?? '~/.dsh/chatgpt-web/logs');
  let ready = false;

  const resolveFile = () => {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(logDir, `${label}-${day}.log`);
  };

  const write = (level, message) => {
    if (!enabled) return;
    const line = `${stamp()} [${level}] ${message}\n`;
    try {
      if (!ready) {
        fs.mkdirSync(logDir, { recursive: true });
        ready = true;
      }
      fs.appendFileSync(resolveFile(), line, 'utf8');
    } catch {
      ready = false;
    }
  };

  return {
    get file() {
      try {
        return resolveFile();
      } catch {
        return '';
      }
    },
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}
