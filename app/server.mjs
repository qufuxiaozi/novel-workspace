import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const html = readFileSync(new URL('./index.html', import.meta.url));
const databasePath = process.env.NOVEL_DATABASE || resolve('data/novels.sqlite');
const port = Number(process.env.NOVEL_PORT || 4312);
const origin = 'http://127.0.0.1:' + port;
const modelPresets = {
  'ark-agent':'https://ark.cn-beijing.volces.com/api/plan/v3',
  'ark-platform':'https://ark.cn-beijing.volces.com/api/v3',
  deepseek:'https://api.deepseek.com',
  bailian:'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm:'https://open.bigmodel.cn/api/paas/v4',
  kimi:'https://api.moonshot.cn/v1',
  ollama:'http://127.0.0.1:11434/v1',
  openai:'https://api.openai.com/v1'
};
const loopbackHosts = new Set(['127.0.0.1','localhost','[::1]']);
const envAi = {
  key: process.env.NOVEL_AI_API_KEY?.trim(),
  base: process.env.NOVEL_AI_BASE_URL?.trim(),
  model: process.env.NOVEL_AI_MODEL?.trim()
};
function modelEndpoint(base) {
  const url = new URL(base);
  const local = loopbackHosts.has(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('请输入 HTTPS 模型地址，本机模型可使用 HTTP');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
  if (url.hostname.endsWith('.volces.com') && /^\/api\/coding(?:\/|$)/.test(url.pathname)) {
    throw new Error('Coding Plan 面向支持的编程工具，本应用请选 Agent Plan 或方舟平台 API');
  }
  return url;
}
function protectKey(value, decrypt = false) {
  const method = decrypt ? 'Unprotect' : 'Protect';
  const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result))`;
  const input = decrypt ? value : Buffer.from(value, 'utf8').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'ignore']
  }).trim();
  return decrypt ? Buffer.from(output, 'base64').toString('utf8') : output;
}
async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function generate(request, send, clientSignal) {
  let ai;
  try {
    const stored = readAi();
    ai = stored ? { ...stored, key: stored.encryptedKey ? protectKey(stored.encryptedKey, true) : '' } : envAi;
  } catch {
    return send(503, { error: '当前 Windows 用户无法读取 API Key，请在设置中重新填写' });
  }
  if ((!ai.key && ai.provider !== 'ollama') || !ai.base || !ai.model) {
    return send(503, { error: '请先打开「设置 → AI 模型」配置模型' });
  }
  const input = await readJson(request, 1024 * 1024);
  if (!input || typeof input !== 'object') return send(400, { error: '写作请求格式不正确' });
  const { mode, instruction, outline, selection, notes = '', references = '' } = input;
  const testing = mode === 'connection-test';
  const analysisInstructions = {
    'analyze-chapter':'分析小说章节，分别说明章情节、节奏、核心卖点、转折、章末钩子及可复用的写作方法。避免大段复述原文。',
    'analyze-opening':'结合前三章原文，分析起势、主角与冲突的建立、各章任务、转折和章末钩子。标明涉及的章名。',
    'analyze-book':'依据提供的逐章分析或分组摘要，汇总全书节奏、主要卖点、冲突推进、转折与钩子，标明涉及章节。'
  };
  const isAnalysis = Object.hasOwn(analysisInstructions, mode);
  if (isAnalysis && (typeof input.content !== 'string' || !input.content.trim())) {
    return send(400, { error: '缺少拆书材料' });
  }
  if (!testing && !isAnalysis && (!['chapter', 'rewrite'].includes(mode) ||
      ![instruction, outline, selection, notes, references].every(value => typeof value === 'string') ||
      (mode === 'rewrite' ? !selection.trim() : !instruction.trim() && !outline.trim()))) {
    return send(400, { error: '请填写写作要求或提供本章章纲；重写时请选择正文片段' });
  }
  try {
    const url = modelEndpoint(ai.base);
    if (ai.provider === 'ollama' && !loopbackHosts.has(url.hostname)) return send(503, { error: 'Ollama 本机模式只接受本机地址' });
    const upstream = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([clientSignal,AbortSignal.timeout(120000)]),
      headers: { ...(ai.key ? { Authorization:'Bearer ' + ai.key } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ai.model,
        ...(testing ? { [url.hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens']: 64 } : {}),
        messages: testing ? [{ role: 'user', content: '请回复 OK。' }] : [
          { role: 'system', content: isAnalysis ? analysisInstructions[mode] : mode === 'rewrite'
            ? '你是中文小说编辑。根据作者要求改写选定片段，只返回改写后的正文。'
            : '你是中文小说写作助手。根据作者要求及章节大纲写出本章，只返回正文。' },
          { role: 'user', content: isAnalysis ? input.content : [
            '写作要求\n' + instruction, '章纲\n' + outline, '选定片段\n' + selection,
            ...(notes.trim() ? ['作品设定\n' + notes] : []),
            ...(references.trim() ? ['作者选用的参考素材\n' + references] : [])
          ].join('\n\n') }
        ]
      })
    });
    if (!upstream.ok) {
      const detail = {
        401:'请检查 API Key 是否有效，以及是否与所选接入方式匹配',
        403:'请检查套餐、模型和 API Key 的调用权限',
        404:'请核对模型 ID 与接口地址',
        429:'请检查额度和调用频率'
      }[upstream.status];
      return send(502, { error: '模型服务返回 HTTP ' + upstream.status + (detail ? '。' + detail : '') });
    }
    const result = await upstream.json();
    if (testing && result.choices?.[0]?.message) return send(200, { connected:true });
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return send(502, { error: '模型未返回可用正文' });
    return send(200, { text });
  } catch (error) {
    if (clientSignal.aborted) return;
    return send(502, { error: error.name === 'TimeoutError' ? '模型响应超时，请重试' : '无法获得模型响应，请核对模型地址和网络' });
  }
}
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_values (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
const values = db.prepare('SELECT key, value FROM workspace_values');
const getValue = db.prepare('SELECT value FROM workspace_values WHERE key = ?');
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
}
function formatReport(text) {
  const inline = value => escapeHtml(value).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  const output = [];
  let list, paragraph = [];
  function flush() {
    if (list) { output.push('</' + list + '>'); list = undefined; }
    if (paragraph.length) { output.push('<p>' + paragraph.map(inline).join('<br>') + '</p>'); paragraph = []; }
  }
  for (const line of text.split(/\r\n?|\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1,6);
      output.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
    } else if (item) {
      const type = item[2] ? 'ol' : 'ul';
      if (list !== type) {
        flush();
        output.push(type === 'ol' ? '<ol start="' + Number(item[2]) + '">' : '<ul>');
        list = type;
      }
      output.push('<li>' + inline(item[3]) + '</li>');
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return output.join('\n');
}
function analysisReport(response, query) {
  const books = JSON.parse(getValue.get('analyses')?.value ?? '[]');
  const book = books.find(item => item.id === query.get('book'));
  const chapterIndex = query.get('chapter');
  const chapter = chapterIndex && /^\d+$/.test(chapterIndex) ? book?.chapters?.[Number(chapterIndex)] : undefined;
  const report = {
    chapter:{title:chapter ? chapter.title + ' · 逐章分析' : '', text:chapter?.result},
    opening:{title:'黄金三章深析',text:book?.opening},
    book:{title:'全书报告',text:book?.report}
  };
  const kind = query.get('type');
  const entry = Object.hasOwn(report,kind) ? report[kind] : undefined;
  const title = entry?.text ? entry.title : '找不到报告';
  const body = entry?.text || '这份报告尚未生成，或对应章节已不存在。';
  response.writeHead(entry?.text ? 200 : 404, {
    'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 小说工作台</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f3ec;color:#252923;font:16px/1.65 "Microsoft YaHei",sans-serif}
main{max-width:920px;margin:auto;padding:clamp(18px,5vw,56px)}a{color:#29473b;text-underline-offset:3px}
article{margin-top:20px;padding:clamp(20px,5vw,48px);background:#fcfaf5;border:1px solid #ddd9cd;border-radius:10px}
h1{margin:0;font:700 clamp(26px,5vw,40px)/1.3 SimSun,serif;overflow-wrap:anywhere}
.report-source{margin:8px 0 18px;color:#686c60;overflow-wrap:anywhere}.report-body{overflow-wrap:anywhere;font-size:17px;line-height:1.85;border-top:1px solid #ddd9cd;padding-top:20px}
.report-body p,.report-body ul,.report-body ol{margin:0 0 1em}.report-body ul,.report-body ol{padding-inline-start:1.6em}.report-body li+li{margin-top:.4em}
.report-body h2,.report-body h3,.report-body h4,.report-body h5,.report-body h6{line-height:1.45;margin:1.4em 0 .65em;color:#29473b}.report-body>:first-child{margin-top:0}
</style>
<main><a href="/#analysis">返回竞品拆书</a><article>
<h1>${escapeHtml(title)}</h1><p class="report-source">${escapeHtml(book?.title)}</p>
<div class="report-body">${formatReport(body)}</div>
</article></main></html>`);
}
function readAi() {
  const row = getValue.get('ai-settings');
  return row ? JSON.parse(row.value) : undefined;
}
const write = db.prepare(`
  INSERT INTO workspace_values (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const keys = /^(?:works|idea|sources|clips|materials|materialCategories|analyses|chapters:[\w-]+|plans:[\w-]+)$/;
const server = createServer(async (request, response) => {
  const send = (status, value) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  if (request.headers.host !== '127.0.0.1:' + port) return send(403, { error: '无效的本机地址' });
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(html);
  }
  if (request.method === 'GET' && request.url.startsWith('/analysis-report?')) {
    return analysisReport(response,new URLSearchParams(request.url.split('?')[1]));
  }
  if (request.method === 'GET' && request.url === '/api/workspace') {
    return send(200, Object.fromEntries(values.all().filter(row => keys.test(row.key)).map(row => [row.key, JSON.parse(row.value)])));
  }
  if (request.method === 'GET' && request.url === '/api/ai/settings') {
    const stored = readAi();
    const base = stored?.base ?? envAi.base ?? '';
    const match = Object.keys(modelPresets).find(key => modelPresets[key] === base.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
    const provider = stored?.provider ?? (match === 'ollama' ? 'custom' : match) ?? 'custom';
    return send(200, { base, provider, presets:modelPresets, model: stored?.model ?? envAi.model ?? '',
      configured: Boolean(stored ? stored.encryptedKey || stored.provider === 'ollama' : envAi.key && envAi.base && envAi.model), saved: Boolean(stored) });
  }
  const isSettings = request.method === 'PUT' && request.url === '/api/ai/settings';
  const isGeneration = request.method === 'POST' && request.url === '/api/ai/generate';
  if (!isSettings && !isGeneration && (request.method !== 'PUT' || !request.url.startsWith('/api/value/'))) return send(404, { error: '路径不存在' });
  if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
    return send(403, { error: '无效的写入请求' });
  }
  try {
    if (isGeneration) {
      const controller = new AbortController();
      response.once('close', () => { if (!response.writableFinished) controller.abort(); });
      return await generate(request, send, controller.signal);
    }
    if (isSettings) {
      const input = await readJson(request, 16384);
      if (!input || ![input.base, input.model, input.key].every(value => typeof value === 'string')) {
        return send(400, { error: '模型配置格式不正确' });
      }
      const { model, key } = Object.fromEntries(['model','key'].map(name => [name,input[name].trim()]));
      const provider = input.provider ?? 'custom';
      if (typeof provider !== 'string' || (provider !== 'custom' && !Object.hasOwn(modelPresets,provider))) {
        return send(400, { error: '请选择有效的接入方式' });
      }
      const base = ['custom','ollama','bailian'].includes(provider) ? input.base.trim() : modelPresets[provider];
      if (!model) return send(400, { error: '请填写模型 ID' });
      let endpoint;
      try { endpoint = modelEndpoint(base); }
      catch (error) { return send(400, { error: error instanceof TypeError ? '请输入有效的模型地址' : error.message }); }
      if (provider === 'ollama') {
        if (!loopbackHosts.has(endpoint.hostname)) return send(400, { error: 'Ollama 本机模式只接受本机地址' });
        write.run('ai-settings', JSON.stringify({base,model,provider}));
        return send(200, { configured:true });
      }
      const existing = readAi();
      if (key && process.platform !== 'win32') {
        return send(400, { error: '此系统请使用本机进程环境变量配置云端 Key。' });
      }
      if (!key) {
        let previous;
        try { if (existing) previous = modelEndpoint(existing.base); } catch {}
        if (!existing?.encryptedKey || previous?.href !== endpoint.href) {
          return send(400, { error: '首次保存或更换接入地址时，请填写对应的 API Key' });
        }
      }
      let encryptedKey;
      try { encryptedKey = key ? protectKey(key) : existing.encryptedKey; }
      catch { return send(500, { error: 'Windows 无法加密 API Key，配置未保存' }); }
      write.run('ai-settings', JSON.stringify({base,model,provider,encryptedKey}));
      return send(200, { configured: true });
    }
    const key = decodeURIComponent(request.url.slice('/api/value/'.length));
    if (!keys.test(key)) return send(400, { error: '无效的保存项' });
    const value = await readJson(request, key === 'analyses' ? Infinity : 20 * 1024 * 1024);
    if (key === 'idea' ? typeof value !== 'string' : !Array.isArray(value)) return send(400, { error: '数据格式不正确' });
    write.run(key, JSON.stringify(value));
    return send(200, { saved: true });
  } catch (error) {
    if (error instanceof RangeError) return send(413, { error: '数据超过保存上限' });
    if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: '数据格式不正确' });
    console.error(error);
    return send(500, { error: '本地数据库保存失败' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(origin));
