import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.NOVEL_PORT || 4312);
const host = '127.0.0.1';
const url = 'http://' + host + ':' + port + '/';

async function portInUse() {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(750, () => { socket.destroy(); resolve(false); });
  });
}

function openBrowser() {
  const windows = process.platform === 'win32';
  const command = windows ? join(process.env.SystemRoot || 'C:\\Windows','System32','rundll32.exe') : '/usr/bin/open';
  const args = windows ? ['url.dll,FileProtocolHandler', url] : [url];
  const browser = spawn(command, args, { stdio:'ignore', windowsHide:true });
  const fallback = () => console.log('请在浏览器打开 ' + url);
  browser.once('error', fallback);
  browser.once('exit', code => { if (code) fallback(); });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('请安装 Node.js 24 或更新版本。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NOVEL_PORT 必须是有效端口。');
  if (await portInUse()) throw new Error('端口 ' + port + ' 已有服务。请关闭占用该端口的程序，或设置 NOVEL_PORT 后重试。');
  const root = fileURLToPath(new URL('../',import.meta.url));
  const child = spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))], {
    cwd:root, stdio:'inherit', windowsHide:true
  });
  const ended = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code,signal) => resolve({ code,signal }));
  });
  let stopped = false;
  const stop = () => { stopped = true; child.kill(); };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await Promise.race([ended,delay(250)]);
      if (stopped) return;
      if (state) throw state.error ?? new Error('本机服务启动失败，请查看上方错误。');
      try {
        const response = await fetch(url,{signal:AbortSignal.timeout(500)});
        if (!response.ok) continue;
      } catch { continue; }
      if (stopped) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      console.log('写作台已启动。请保持此窗口开启，按 Ctrl+C 停止。');
      openBrowser();
      const exit = await ended;
      if (exit.error) throw exit.error;
      if (exit.code && !exit.signal) process.exitCode = exit.code;
      return;
    }
    stop();
    throw new Error('本机服务未能在 15 秒内启动。');
  } finally {
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
