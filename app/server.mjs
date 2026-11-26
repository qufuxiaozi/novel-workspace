import { createServer, get as httpGet } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';

const html = readFileSync(new URL('./index.html', import.meta.url));
const appVersion = '0.1.2';
const backgroundFiles = new Map([
  'airy-ivory','airy-mist','antique-letter','antique-bamboo',
  'forest-light','forest-sage','ink-cloud','ink-mountain'
].map(name => [
  '/backgrounds/' + name + '.webp',
  readFileSync(new URL('./backgrounds/' + name + '.webp', import.meta.url))
]));
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
async function readBuffer(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function decodeBookBuffer(buffer) {
  if (buffer[0] === 255 && buffer[1] === 254) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 254 && buffer[1] === 255) return new TextDecoder('utf-16be').decode(buffer);
  try { return new TextDecoder('utf-8',{ fatal:true }).decode(buffer); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}
function zipEntries(buffer) {
  let end = -1;
  const stop = Math.max(0,buffer.length - 65557);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('无法识别压缩文件结构');
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let totalSize = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) {
      throw new Error('压缩文件目录损坏');
    }
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46,position + 46 + nameLength).toString('utf8').replaceAll('\\','/');
    position += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('压缩文件条目损坏');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error('压缩文件内容不完整');
    const compressed = buffer.subarray(dataStart,dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed);
    else continue;
    totalSize += content.length;
    if (totalSize > 128 * 1024 * 1024) throw new Error('压缩文件解压后过大');
    entries.set(name,content);
  }
  return entries;
}
function zipResolve(base,href) {
  const clean = decodeURIComponent(href.split('#')[0]).replaceAll('\\','/');
  return posix.normalize(posix.join(posix.dirname(base),clean)).replace(/^\/+/,'');
}
function xmlToText(value) {
  return decodeHtml(String(value ?? '')
    .replace(/<w:tab\b[^>]*\/?>/gi,'\t')
    .replace(/<w:br\b[^>]*\/?>/gi,'\n')
    .replace(/<\/w:p>/gi,'\n')
    .replace(/<[^>]+>/g,''))
    .replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function htmlToNovelText(source,fallbackTitle = '') {
  const clean = String(source ?? '')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<!--[\s\S]*?-->/g,' ');
  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = htmlText(titleMatch?.[1] ?? '') || fallbackTitle;
  const body = clean.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? clean.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? clean;
  const text = decodeHtml(body
    .replace(/<br\b[^>]*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|section|article|main|h[1-6]|li|blockquote|tr|dd|dt)>/gi,'\n')
    .replace(/<[^>]+>/g,''))
    .replace(/\u00a0/g,' ')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  return { title:title || '在线小说', text };
}
function parseRtf(buffer) {
  let value = decodeBookBuffer(buffer)
    .replace(/\\u(-?\d+)\??/g,(_,number) => String.fromCharCode((Number(number) + 65536) % 65536))
    .replace(/(?:\\'[0-9a-f]{2})+/gi,sequence => decodeBookBuffer(Buffer.from(
      [...sequence.matchAll(/\\'([0-9a-f]{2})/gi)].map(match => Number.parseInt(match[1],16))
    )));
  return value
    .replace(/\\par[d]?/gi,'\n')
    .replace(/\\tab/gi,'\t')
    .replace(/\\[a-z]+-?\d* ?/gi,'')
    .replace(/[{}]/g,'')
    .replace(/\r/g,'')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
function parseEpub(buffer,filename) {
  const entries = zipEntries(buffer);
  const container = entries.get('META-INF/container.xml')?.toString('utf8') ?? '';
  const rootPath = container.match(/<rootfile\b[^>]*full-path="([^"]+)"/i)?.[1];
  const opfPath = rootPath ? decodeHtml(rootPath) : [...entries.keys()].find(name => name.toLowerCase().endsWith('.opf'));
  const opf = opfPath ? entries.get(opfPath)?.toString('utf8') ?? '' : '';
  const title = htmlText(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '')
    || filename.replace(/\.epub$/i,'') || 'EPUB 小说';
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b([^>]+)>/gi)) {
    const attributes = match[1];
    const id = attributes.match(/\bid="([^"]+)"/i)?.[1];
    const href = attributes.match(/\bhref="([^"]+)"/i)?.[1];
    if (id && href) manifest.set(id,decodeHtml(href));
  }
  let paths = [];
  for (const match of opf.matchAll(/<itemref\b([^>]+)>/gi)) {
    const idref = match[1].match(/\bidref="([^"]+)"/i)?.[1];
    const href = manifest.get(idref);
    if (href) paths.push(opfPath ? zipResolve(opfPath,href) : href);
  }
  if (!paths.length) paths = [...entries.keys()].filter(name => /\.(?:x?html?|htm)$/i.test(name)).sort();
  const sections = paths.map(path => {
    const content = entries.get(path);
    return content ? htmlToNovelText(content.toString('utf8')).text : '';
  }).filter(Boolean);
  return { title,text:sections.join('\n\n').trim(),format:'EPUB' };
}
function parseDocx(buffer,filename) {
  const entries = zipEntries(buffer);
  const documentXml = entries.get('word/document.xml');
  if (!documentXml) throw new Error('DOCX 中找不到正文');
  return {
    title:filename.replace(/\.docx$/i,'') || 'Word 小说',
    text:xmlToText(documentXml.toString('utf8')),
    format:'DOCX'
  };
}
function decodeBookFile(buffer,filename) {
  const extension = extname(filename).toLowerCase();
  if (!buffer.length) throw new Error('文件为空');
  if (extension === '.epub') return parseEpub(buffer,filename);
  if (extension === '.docx') return parseDocx(buffer,filename);
  if (['.html','.htm','.xhtml'].includes(extension)) {
    const parsed = htmlToNovelText(decodeBookBuffer(buffer),filename.replace(/\.[^.]+$/,''));
    return { ...parsed,format:'HTML' };
  }
  if (extension === '.rtf') return { title:filename.replace(/\.rtf$/i,''),text:parseRtf(buffer),format:'RTF' };
  if (['.txt','.md','.markdown','.text'].includes(extension)) {
    return { title:filename.replace(/\.[^.]+$/,'') || '未命名小说',text:decodeBookBuffer(buffer),format:extension.slice(1).toUpperCase() || 'TXT' };
  }
  const text = decodeBookBuffer(buffer);
  const binaryRatio = [...buffer.subarray(0,Math.min(buffer.length,4096))].filter(byte => byte === 0).length / Math.min(buffer.length,4096);
  if (binaryRatio > 0.02) throw new Error('暂不支持这个文件格式，请使用 TXT、Markdown、HTML、EPUB、DOCX 或 RTF');
  return { title:filename.replace(/\.[^.]+$/,'') || '未命名小说',text,format:'文本' };
}
function validateImportUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('请输入有效的在线小说网址'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('在线导入只支持公开的 HTTP 或 HTTPS 地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const version = isIP(hostname);
  const privateV4 = version === 4 && (
    hostname === '0.0.0.0' || hostname.startsWith('10.') || hostname.startsWith('127.') ||
    hostname.startsWith('169.254.') || hostname.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  );
  const privateV6 = version === 6 && (
    hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')
  );
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      hostname.endsWith('.internal') || privateV4 || privateV6) {
    throw new Error('在线导入不接受本机或内网地址');
  }
  return url;
}
async function importOnlineNovel(value) {
  const { target,buffer,contentType } = await requestImportUrl(value);
  const pathname = decodeURIComponent(target.pathname);
  const extension = extname(pathname).toLowerCase();
  if (contentType.includes('html') || ['', '.html', '.htm', '.xhtml'].includes(extension)) {
    const parsed = htmlToNovelText(decodeBookBuffer(buffer),target.hostname);
    return { ...parsed,format:'在线网页',sourceUrl:target.href };
  }
  const parsed = decodeBookFile(buffer,pathname.split('/').pop() || 'online-novel.txt');
  return { ...parsed,sourceUrl:target.href };
}
function requestImportUrl(value,redirects = 0) {
  const target = validateImportUrl(value);
  return new Promise((resolve,reject) => {
    const get = target.protocol === 'https:' ? httpsGet : httpGet;
    const request = get({
      protocol:target.protocol,
      hostname:target.hostname,
      port:target.port || undefined,
      path:target.pathname + target.search,
      insecureHTTPParser:true,
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml,text/plain,application/epub+zip,application/octet-stream',
        'Accept-Language':'zh-CN,zh;q=0.9',
        'Accept-Encoding':'identity'
      }
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location || redirects >= 4) {
          reject(new Error('网址重定向次数过多'));
          return;
        }
        resolve(requestImportUrl(new URL(location,target).href,redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('小说网址返回 HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data',chunk => {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) {
          request.destroy(new Error('在线小说内容超过 128 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end',() => resolve({
        target,
        buffer:Buffer.concat(chunks),
        contentType:String(response.headers['content-type'] ?? '').toLowerCase()
      }));
    });
    request.setTimeout(30000,() => request.destroy(new Error('小说网址响应超时')));
    request.on('error',reject);
  });
}

const rankingBoards = {
  'qimao-boy-hot': {
    title:'七猫小说 · 男频大热榜',
    subtitle:'基于七猫男频作品昨日热度排行',
    url:'https://www.qimao.com/paihang/boy/hot/date/',
    source:'七猫小说',
    parser:'ranking',
    allowedHosts:['www.qimao.com']
  },
  'qimao-girl-hot': {
    title:'七猫小说 · 女频大热榜',
    subtitle:'基于七猫女频作品昨日热度排行',
    url:'https://www.qimao.com/paihang/girl/hot/date/',
    source:'七猫小说',
    parser:'ranking',
    allowedHosts:['www.qimao.com']
  },
  'qimao-fantasy': {
    title:'七猫小说 · 玄幻',
    subtitle:'七猫玄幻奇幻分类按点击热度展示',
    url:'https://www.qimao.com/shuku/a-202-a-a-a-a-a-click-1/',
    source:'七猫小说',
    parser:'category',
    allowedHosts:['www.qimao.com']
  },
  'qimao-wuxia': {
    title:'七猫小说 · 武侠',
    subtitle:'七猫武侠仙侠分类按点击热度展示',
    url:'https://www.qimao.com/shuku/a-205-a-a-a-a-a-click-1/',
    source:'七猫小说',
    parser:'category',
    allowedHosts:['www.qimao.com']
  },
  'fanqie-male': {
    title:'番茄小说 · 男频热榜',
    subtitle:'番茄小说男频都市热榜',
    url:'https://fanqienovel.com/api/rank/category/list?app_id=1967&rank_list_type=3&offset=0&limit=20&category_id=261&rank_version=&gender=1&rankMold=2',
    source:'番茄小说',
    parser:'fanqie',
    allowedHosts:['fanqienovel.com'],
    pageUrl:'https://fanqienovel.com/rank',
    pageAllowedHosts:['fanqienovel.com']
  },
  'fanqie-female': {
    title:'番茄小说 · 女频热榜',
    subtitle:'番茄小说女频热门作品',
    url:'https://fanqienovel.com/api/rank/category/list?app_id=1967&rank_list_type=3&offset=0&limit=20&category_id=1139&rank_version=&gender=0&rankMold=2',
    source:'番茄小说',
    parser:'fanqie',
    allowedHosts:['fanqienovel.com'],
    pageUrl:'https://fanqienovel.com/rank',
    pageAllowedHosts:['fanqienovel.com']
  },
  'qidian-yuepiao': {
    title:'起点读书 · 男频月票榜',
    subtitle:'起点男频作品月度月票排行',
    url:'https://m.qidian.com/rank/yuepiao/?chn=10',
    source:'起点读书',
    parser:'qidian',
    allowedHosts:['m.qidian.com']
  },
  'qidian-hotsales': {
    title:'起点读书 · 男频热销榜',
    subtitle:'起点男频作品近期热销排行',
    url:'https://m.qidian.com/rank/hotsales/?chn=10',
    source:'起点读书',
    parser:'qidian',
    allowedHosts:['m.qidian.com']
  },
  'zhulang-weekly': {
    title:'逐浪小说 · 周点击榜',
    subtitle:'逐浪全站作品本周点击排行',
    url:'https://www.zhulang.com/rank/visit/class/all/type/1.html',
    source:'逐浪小说',
    parser:'zhulang',
    allowedHosts:['www.zhulang.com']
  },
  'zhulang-monthly': {
    title:'逐浪小说 · 月点击榜',
    subtitle:'逐浪全站作品本月点击排行',
    url:'https://www.zhulang.com/rank/visit/class/all/type/2.html',
    source:'逐浪小说',
    parser:'zhulang',
    allowedHosts:['www.zhulang.com']
  },
  'zhulang-total': {
    title:'逐浪小说 · 总点击榜',
    subtitle:'逐浪全站作品累计点击排行',
    url:'https://www.zhulang.com/rank/visit/class/all/type/3.html',
    source:'逐浪小说',
    parser:'zhulang',
    allowedHosts:['www.zhulang.com']
  },
  'feilu-popular': {
    title:'飞卢小说 · 热门榜',
    subtitle:'飞卢近期热门小说推荐',
    url:'https://b.faloo.com/Re_38_1.html',
    source:'飞卢小说',
    parser:'feilu',
    encoding:'gb18030',
    allowedHosts:['b.faloo.com']
  },
  'feilu-biaoxin': {
    title:'飞卢小说 · 标新榜',
    subtitle:'飞卢 VIP 小说月票排行',
    url:'https://b.faloo.com/y_0_0_0_0_3_15_1.html',
    source:'飞卢小说',
    parser:'feilu',
    encoding:'gb18030',
    allowedHosts:['b.faloo.com']
  },
  'feilu-total': {
    title:'飞卢小说 · 总榜',
    subtitle:'飞卢全站作品月点击排行',
    url:'https://b.faloo.com/y_0_0_0_0_0_2_1.html',
    source:'飞卢小说',
    parser:'feilu',
    encoding:'gb18030',
    allowedHosts:['b.faloo.com']
  },
  'feilu-favorite': {
    title:'飞卢小说 · 收藏榜',
    subtitle:'飞卢全站作品收藏排行',
    url:'https://b.faloo.com/y_0_0_0_0_0_7_1.html',
    source:'飞卢小说',
    parser:'feilu',
    encoding:'gb18030',
    allowedHosts:['b.faloo.com']
  },
  'feilu-flower': {
    title:'飞卢小说 · 鲜花榜',
    subtitle:'飞卢全站作品周鲜花排行',
    url:'https://b.faloo.com/y_0_0_0_0_0_4_1.html',
    source:'飞卢小说',
    parser:'feilu',
    encoding:'gb18030',
    allowedHosts:['b.faloo.com']
  },
  'shuqi-male-click': {
    title:'书旗小说 · 男频点击榜',
    subtitle:'书旗男频作品周点击排行',
    url:'https://www.shuqi.com/rank',
    source:'书旗小说',
    parser:'shuqi',
    section:'男频点击榜',
    allowedHosts:['www.shuqi.com']
  },
  'shuqi-female-click': {
    title:'书旗小说 · 女频点击榜',
    subtitle:'书旗女频作品周点击排行',
    url:'https://www.shuqi.com/rank',
    source:'书旗小说',
    parser:'shuqi',
    section:'女频点击榜',
    allowedHosts:['www.shuqi.com']
  },
  'shuqi-male-favorite': {
    title:'书旗小说 · 男频收藏榜',
    subtitle:'书旗男频作品周收藏排行',
    url:'https://www.shuqi.com/rank',
    source:'书旗小说',
    parser:'shuqi',
    section:'男频收藏榜',
    allowedHosts:['www.shuqi.com']
  },
  'shuqi-female-favorite': {
    title:'书旗小说 · 女频收藏榜',
    subtitle:'书旗女频作品周收藏排行',
    url:'https://www.shuqi.com/rank',
    source:'书旗小说',
    parser:'shuqi',
    section:'女频收藏榜',
    allowedHosts:['www.shuqi.com']
  }
};
const rankingCacheTtl = 10 * 60 * 1000;
const rankingCache = new Map();

function publicPage(url, redirects = 3, allowedHosts = [], encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowedHosts.includes(target.hostname)) {
      reject(new Error('不支持的榜单来源'));
      return;
    }
    const request = httpsGet({
      hostname:target.hostname,
      path:target.pathname + target.search,
      insecureHTTPParser:true,
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml',
        'Accept-Language':'zh-CN,zh;q=0.9',
        'Accept-Encoding':'identity'
      }
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (!redirects) reject(new Error('榜单地址重定向次数过多'));
        else resolve(publicPage(new URL(response.headers.location,target), redirects - 1, allowedHosts, encoding));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('榜单来源返回 HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) {
          request.destroy(new Error('榜单页面超过读取上限'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(new TextDecoder(encoding).decode(Buffer.concat(chunks))));
    });
    request.setTimeout(15000, () => request.destroy(new Error('榜单来源响应超时')));
    request.on('error', reject);
  });
}

function decodeHtml(value) {
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10;
      const number = Number.parseInt(code.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}
function htmlText(value) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
}
function qimaoUrl(value) {
  try { return new URL(decodeHtml(value),'https://www.qimao.com').href; }
  catch { return 'https://www.qimao.com/'; }
}
function parseQimaoRanking(html) {
  const blocks = html.match(/<li class="rank-list-item"[\s\S]*?<\/li>/g) ?? [];
  return blocks.map((block, index) => {
    const titleTag = block.match(/<a[^>]*class="s-book-title"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    const titleHref = titleTag.match(/href="([^"]+)"/)?.[1] ?? '';
    const title = htmlText(titleTag);
    const authorTag = block.match(/<a[^>]*href="[^"]*\/zuozhe\/[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    const info = block.match(/<span class="s-book-info[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '';
    const categories = [...info.matchAll(/<a[^>]*href="[^"]*\/shuku\/a-[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(match => htmlText(match[1])).filter(Boolean);
    const status = htmlText(info.match(/<em[^>]*>(连载中|已完结|暂停更新|完结)<\/em>/)?.[1] ?? '');
    const words = htmlText(info.match(/<em[^>]*>([\d.]+\s*万字)<\/em>/)?.[1] ?? '');
    const intro = htmlText(block.match(/<span class="s-book-intro[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
    const cover = block.match(/<img[^>]*src="([^"]+)"/)?.[1] ?? '';
    const heat = htmlText(block.match(/<span class="rank-change-num[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '')
      .replace(/[\uE000-\uF8FF]/g,'').replace(/\s+/g,'');
    const updated = htmlText(block.match(/<span class="s-book-update[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
    const rank = Number(block.match(/<span class="rank-number[^"]*"[^>]*>\s*(\d+)\s*<\/span>/)?.[1]) || index + 1;
    return { rank, title, author:htmlText(authorTag), categories, status, words, intro,
      cover:qimaoUrl(cover), url:qimaoUrl(titleHref), heat, updated };
  }).filter(item => item.title);
}

function javascriptStringField(block, key) {
  const match = block.match(new RegExp('(?:^|,)' + key + ':("(?:\\\\.|[^"\\\\])*")'));
  if (!match) return '';
  try { return JSON.parse(match[1]); }
  catch { return match[1].slice(1,-1).replace(/\\u002F/g,'/'); }
}
function objectBlocks(value) {
  const blocks = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (!depth) start = index;
      depth++;
    } else if (char === '}' && depth) {
      depth--;
      if (!depth && start >= 0) {
        blocks.push(value.slice(start,index + 1));
        start = -1;
      }
    }
  }
  return blocks;
}
function parseQimaoCategory(html) {
  const start = html.indexOf('bookList:[');
  const end = html.indexOf('],pageConfig:',start);
  if (start < 0 || end < 0) return [];
  return objectBlocks(html.slice(start + 'bookList:['.length,end)).map((block,index) => {
    const bookId = block.match(/book_id:"?(\d+)"?/)?.[1] ?? '';
    const title = javascriptStringField(block,'title');
    const readUrl = javascriptStringField(block,'read_url') || (bookId ? 'https://www.qimao.com/shuku/' + bookId + '/' : '');
    const categories = [
      javascriptStringField(block,'category1_name'),
      javascriptStringField(block,'category2_name')
    ].filter(Boolean);
    const status = javascriptStringField(block,'is_over_txt') ||
      (block.match(/is_over_txt:(?:true|"([^"]+)")/)?.[1] ?? '');
    return {
      rank:index + 1,
      title,
      author:javascriptStringField(block,'author'),
      categories,
      status,
      words:javascriptStringField(block,'words_num'),
      intro:javascriptStringField(block,'intro'),
      cover:qimaoUrl(javascriptStringField(block,'image_link')),
      url:qimaoUrl(readUrl),
      heat:'',
      updated:javascriptStringField(block,'update_time_txt'),
      latestChapter:javascriptStringField(block,'latest_chapter_title')
    };
  }).filter(item => item.title);
}

function qidianUrl(value) {
  try { return new URL(decodeHtml(value),'https://m.qidian.com').href; }
  catch { return 'https://m.qidian.com/'; }
}
function parseQidianRanking(html) {
  const anchors = html.match(/<a\s+href="(?:\/\/m\.qidian\.com)?\/book\/\d+\/"[^>]*class="_bookItem_[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  return anchors.map((anchor,index) => {
    const url = qidianUrl(anchor.match(/href="([^"]+)"/)?.[1] ?? '');
    const title = htmlText(anchor.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '')
      .replace(/最新章节在线阅读$/,'');
    const subtitle = htmlText(anchor.match(/<p class="_subTitle_[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
    const details = subtitle.split(/\s*[·•]\s*/).filter(Boolean);
    const rank = Number(htmlText(anchor.match(/<div class="_ranking_[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '')) || index + 1;
    const cover = anchor.match(/<img[^>]*(?:data-src|src)="([^"]+)"/)?.[1] ?? '';
    const heat = htmlText(anchor.match(/<div class="_bookTitleR_[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
    return {
      rank,
      title,
      author:details[0] || '',
      categories:details.slice(1,-1),
      status:'',
      words:details.at(-1)?.match(/^[\d.]+\s*万字$/)?.[0] || '',
      intro:htmlText(anchor.match(/<p class="_bookDesc_[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''),
      cover:qidianUrl(cover),
      url,
      heat,
      updated:'',
      latestChapter:''
    };
  }).filter(item => item.title);
}

function zhulangUrl(value) {
  try { return new URL(decodeHtml(value),'https://www.zhulang.com').href; }
  catch { return 'https://www.zhulang.com/'; }
}
function parseZhulangRanking(html) {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  return rows.map((row,index) => {
    const rank = Number(htmlText(row.match(/<strong class="orange">\s*(\d+)\.\s*<\/strong>/)?.[1] ?? '')) || index + 1;
    const bookAnchor = row.match(/<td>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = htmlText(bookAnchor?.[2] ?? '');
    if (!title) return undefined;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
    const categoryText = htmlText(cells[1] ?? '');
    const latest = htmlText(row.match(/<span class="gray">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const clicks = htmlText(cells.at(-1) ?? '');
    return {
      rank,
      title,
      author:htmlText(cells[4] ?? ''),
      categories:categoryText.replace(/^\[|\]$/g,'') ? [categoryText.replace(/^\[|\]$/g,'')] : [],
      status:htmlText(cells[5] ?? ''),
      words:'',
      intro:'',
      cover:'',
      url:zhulangUrl(bookAnchor?.[1]),
      heat:clicks ? '点击 ' + clicks : '',
      updated:htmlText(cells[3] ?? ''),
      latestChapter:latest
    };
  }).filter(Boolean);
}

function fanqieUrl(value) {
  try { return new URL(decodeHtml(value),'https://fanqienovel.com').href; }
  catch { return 'https://fanqienovel.com/'; }
}
function parseFanqieRanking(value) {
  let data;
  try { data = JSON.parse(value); }
  catch { throw new Error('番茄榜单数据格式异常'); }
  if (data.code !== 0 || !Array.isArray(data.data?.book_list)) {
    throw new Error(data.message || '番茄榜单暂不可用');
  }
  return data.data.book_list.map((book,index) => ({
    rank:Number(book.currentPos) || index + 1,
    title:String(book.bookName ?? '').trim(),
    author:String(book.author ?? '').trim(),
    categories:[book.category,book.categoryV2].filter(Boolean),
    status:book.creationStatus === '0' ? '已完结' : '连载中',
    words:Number(book.wordNumber) > 0 ? (Number(book.wordNumber) / 10000).toFixed(2) + '万字' : '',
    intro:String(book.abstract ?? '').trim(),
    cover:fanqieUrl(book.thumbUri),
    url:book.bookId ? 'https://fanqienovel.com/page/' + encodeURIComponent(book.bookId) : 'https://fanqienovel.com/rank',
    heat:Number(book.read_count) > 0 ? Number(book.read_count).toLocaleString('zh-CN') + ' 阅读' : '',
    updated:book.lastChapterUpdateTime
      ? new Date(Number(book.lastChapterUpdateTime) * 1000).toLocaleString('zh-CN',{hour12:false})
      : '',
    latestChapter:String(book.lastChapterTitle ?? '').trim()
  })).filter(item => item.title);
}
function parseFanqieFont(html) {
  const match = html.match(/@font-face\{font-family:([^;]+);[^}]*?src:url\((https:[^)]+?\.woff2)\)/);
  if (!match) return undefined;
  const family = match[1].replace(/^['"]|['"]$/g,'').replace(/[^\w-]/g,'');
  try {
    const url = new URL(match[2]);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.bytetos.com')) return undefined;
    return { family, url:url.href };
  } catch {
    return undefined;
  }
}

function falooUrl(value) {
  try { return new URL(decodeHtml(value),'https://b.faloo.com').href; }
  catch { return 'https://b.faloo.com/'; }
}
function parseFeiluRanking(html) {
  if (html.includes('id="BookContent"')) {
    return html.split('<div class="TwoBox02_02">').slice(1).map((block,index) => {
      const titleMatch = block.match(/<h1 class="fontSize17andHei"[^>]*title="([^"]*)"><a[^>]*href="([^"]+)"/);
      const title = htmlText(titleMatch?.[1] ?? '');
      if (!title) return undefined;
      const author = htmlText(block.match(
        /<div class="TwoBox02_09">[\s\S]*?<a href="\/\/b\.faloo\.com\/l_0_1\.html\?[^"]*"[^>]*title="([^"]*)"/
      )?.[1] ?? '');
      const meta = block.match(
        /<div class="TwoBox02_05"><span class="fontSize14andHui">([\s\S]*?)<\/span><\/div>/
      )?.[1] ?? '';
      const category = htmlText(meta.match(/<a[^>]*title="([^"]*)"/)?.[1] ?? '');
      const metricTexts = [...meta.matchAll(/<span>([\s\S]*?)<\/span>/g)]
        .map(match => htmlText(match[1])).filter(Boolean);
      const words = metricTexts.find(value => value.startsWith('字数：'))?.replace(/^字数：/,'') ?? '';
      const heat = metricTexts.find(value => /(?:点击|月票|收藏|鲜花)：/.test(value)) ?? '';
      const intro = htmlText(block.match(/<div class="TwoBox02_06">([\s\S]*?)<\/div>/)?.[1] ?? '');
      const cover = block.match(/<img[^>]*class="TYImg"[^>]*(?:data-original|src)="([^"]+)"/)?.[1] ?? '';
      const latestChapter = htmlText(block.match(
        /<a class="fontSize14andChen"[^>]*>([\s\S]*?)<\/a>/
      )?.[1] ?? '');
      return {
        rank:index + 1,
        title,
        author,
        categories:category ? [category] : [],
        status:'',
        words,
        intro,
        cover:falooUrl(cover),
        url:falooUrl(titleMatch?.[2]),
        heat,
        updated:'',
        latestChapter
      };
    }).filter(Boolean);
  }
  const blocks = html.match(/<div class="c_c_d_data1(?: nomargin)?">[\s\S]*?<\/div><\/div>/g) ?? [];
  return blocks.map((block,index) => {
    const titleAnchor = block.match(/<div class="c_c_d_da_title"><a[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/div>/);
    const title = htmlText(titleAnchor?.[3] ?? titleAnchor?.[2] ?? '');
    if (!title) return undefined;
    const authorBlock = block.match(/<div class="c_c_d_da_author">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const authorLinks = [...authorBlock.matchAll(/<a[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(match => htmlText(match[2] || match[1])).filter(Boolean);
    const intro = htmlText(block.match(/<div class="c_c_d_da_data"><a[^>]*>([\s\S]*?)<\/a><\/div>/)?.[1] ?? '');
    const cover = block.match(/<div class="c_c_d_da_img"><a[^>]*><img[^>]*src="([^"]+)"/)?.[1] ?? '';
    const recommendedAt = htmlText(block.match(/<div class="c_c_d_da_time">推荐时间：([\s\S]*?)<\/div>/)?.[1] ?? '');
    return {
      rank:index + 1,
      title,
      author:authorLinks[0] || '',
      categories:authorLinks.slice(1,2),
      status:'',
      words:'',
      intro,
      cover:falooUrl(cover),
      url:falooUrl(titleAnchor?.[1]),
      heat:'',
      updated:'',
      recommendedAt,
      latestChapter:''
    };
  }).filter(Boolean);
}

function shuqiUrl(value) {
  try { return new URL(decodeHtml(value),'https://www.shuqi.com').href; }
  catch { return 'https://www.shuqi.com/rank'; }
}
function parseShuqiRanking(html, section) {
  const marker = 'data-clog="' + section + '"';
  const sectionStart = html.indexOf(marker);
  const listStart = sectionStart >= 0 ? html.indexOf('<ul class="cp-ranks-list js-ranksList">',sectionStart) : -1;
  const listEnd = listStart >= 0 ? html.indexOf('</ul>',listStart) : -1;
  if (sectionStart < 0 || listStart < 0 || listEnd < 0) return [];
  const list = html.slice(listStart,listEnd);
  return (list.match(/<li>[\s\S]*?<\/li>/g) ?? []).map((block,index) => {
    const anchor = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = htmlText(block.match(/<span class="bn">([\s\S]*?)<\/span>/)?.[1] ?? '');
    if (!title) return undefined;
    return {
      rank:Number(htmlText(block.match(/<i class="no">\s*(\d+)\s*<\/i>/)?.[1] ?? '')) || index + 1,
      title,
      author:htmlText(block.match(/<span class="au">([\s\S]*?)<\/span>/)?.[1] ?? ''),
      categories:[],
      status:'',
      words:'',
      intro:'',
      cover:'',
      url:shuqiUrl(anchor?.[1]),
      heat:'',
      updated:'',
      latestChapter:''
    };
  }).filter(Boolean);
}

function readRankingSnapshot(id) {
  const row = getValue.get('ranking:' + id);
  if (!row) return undefined;
  try { return JSON.parse(row.value); }
  catch { return undefined; }
}
async function loadRanking(id, force = false) {
  const board = rankingBoards[id];
  if (!board) throw new Error('未知榜单');
  const memory = rankingCache.get(id);
  if (!force && memory && Date.now() - memory.savedAt < rankingCacheTtl) {
    return { ...memory.value, cached:true };
  }
  try {
    let items, font;
    if (board.parser === 'fanqie') {
      const [data,page] = await Promise.all([
        publicPage(board.url,3,board.allowedHosts),
        publicPage(board.pageUrl,3,board.pageAllowedHosts)
      ]);
      items = parseFanqieRanking(data);
      font = parseFanqieFont(page);
    } else {
      const html = await publicPage(board.url,3,board.allowedHosts,board.encoding);
      items = board.parser === 'category' ? parseQimaoCategory(html)
        : board.parser === 'qidian' ? parseQidianRanking(html)
        : board.parser === 'zhulang' ? parseZhulangRanking(html)
        : board.parser === 'feilu' ? parseFeiluRanking(html)
        : board.parser === 'shuqi' ? parseShuqiRanking(html,board.section)
        : parseQimaoRanking(html);
    }
    if (items.length < 5) throw new Error('榜单页面未返回足够的作品');
    const value = {
      board:{
        id,
        source:board.source,
        title:board.title,
        subtitle:board.subtitle,
        url:board.pageUrl || board.url,
        font:board.parser === 'fanqie' ? font : undefined,
        searchable:board.parser !== 'fanqie'
      },
      fetchedAt:new Date().toISOString(),
      items,
      stale:false
    };
    rankingCache.set(id,{ savedAt:Date.now(), value });
    write.run('ranking:' + id,JSON.stringify(value));
    return { ...value, cached:false };
  } catch (error) {
    const fallback = memory?.value ?? readRankingSnapshot(id);
    if (fallback) return {
      ...fallback,
      stale:true,
      cached:true,
      notice:'实时更新失败，当前显示本机上次保存的榜单。'
    };
    throw error;
  }
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
  const { mode, instruction, outline, selection, style = '', notes = '', references = '' } = input;
  const testing = mode === 'connection-test';
  const isTitleSuggestion = mode === 'title-suggestion';
  const analysisInstructions = {
    'analyze-chapter':'分析小说章节，分别说明章情节、节奏、核心卖点、转折、章末钩子及可复用的写作方法。避免大段复述原文。',
    'analyze-opening':'结合前三章原文，分析起势、主角与冲突的建立、各章任务、转折和章末钩子。标明涉及的章名。',
    'analyze-book':'依据提供的逐章分析或分组摘要，汇总全书节奏、主要卖点、冲突推进、转折与钩子，标明涉及章节。'
  };
  const isAnalysis = Object.hasOwn(analysisInstructions, mode);
  if (isAnalysis && (typeof input.content !== 'string' || !input.content.trim())) {
    return send(400, { error: '缺少拆书材料' });
  }
  if (!testing && !isAnalysis && !isTitleSuggestion && (!['chapter', 'rewrite'].includes(mode) ||
      ![instruction, outline, selection, style, notes, references].every(value => typeof value === 'string') ||
      (mode === 'rewrite' ? !selection.trim() : !instruction.trim() && !outline.trim()))) {
    return send(400, { error: '请填写写作要求或提供本章章纲；重写时请选择正文片段' });
  }
  if (isTitleSuggestion &&
      ![instruction, outline, selection, style, notes, references].every(value => typeof value === 'string')) {
    return send(400, { error: '书名生成请求格式不正确' });
  }
  if (isTitleSuggestion && !instruction.trim() && !outline.trim()) {
    return send(400, { error: '请填写命名提示，或先保存作品的故事梗概' });
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
            ? '你是中文小说编辑。根据作者要求、写作风格和选定片段改写正文，只返回改写后的正文。借鉴可概括的文体特征，不得复刻任何现成作品的具体句子。'
            : isTitleSuggestion
              ? '你是中文小说书名编辑。根据作者的命名要求和故事梗概，提供5个可直接使用的中文书名。只返回书名，每行一个，不要编号、书名号、引号或任何解释。书名应贴合题材与故事，彼此有区分度。'
              : '你是中文小说写作助手。根据作者要求、写作风格及章节大纲写出本章，只返回正文。借鉴可概括的文体特征，不得复刻任何现成作品的具体句子。' },
          { role: 'user', content: isAnalysis ? input.content : isTitleSuggestion ? [
            '命名要求\n' + (instruction || '无额外要求'),
            '本地故事梗概\n' + (outline || '无')
          ].join('\n\n') : [
            '写作要求\n' + instruction, '章纲\n' + outline, '选定片段\n' + selection,
            ...(style.trim() ? ['写作风格\n' + style] : []),
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
    if (typeof text !== 'string' || !text.trim()) return send(502, { error: '模型未返回可用内容' });
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
const deleteValue = db.prepare('DELETE FROM workspace_values WHERE key = ?');
const keys = /^(?:works|idea|sources|clips|materials|materialCategories|analyses|archivedWorks|archivedSources|archivedAnalyses|writingStats|chapters:[\w-]+|volumes:[\w-]+|plans:[\w-]+)$/;
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
  const background = request.method === 'GET' ? backgroundFiles.get(request.url) : undefined;
  if (background) {
    response.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
    return response.end(background);
  }
  if (request.method === 'GET' && request.url.startsWith('/analysis-report?')) {
    return analysisReport(response,new URLSearchParams(request.url.split('?')[1]));
  }
  if (request.method === 'GET' && request.url === '/api/workspace') {
    return send(200, {
      version:appVersion,
      ...Object.fromEntries(values.all().filter(row => keys.test(row.key)).map(row => [row.key, JSON.parse(row.value)]))
    });
  }
  if (request.method === 'GET' && request.url.startsWith('/api/rankings')) {
    const query = new URL(request.url,origin).searchParams;
    const id = query.get('board') || 'qimao-boy-hot';
    if (!Object.hasOwn(rankingBoards,id)) return send(400,{ error:'未知榜单' });
    try {
      return send(200,await loadRanking(id,query.get('refresh') === '1'));
    } catch (error) {
      console.error('排行榜读取失败：' + error.message);
      return send(502,{ error:'暂时无法读取排行榜，请检查网络后重试。' });
    }
  }
  if (request.method === 'GET' && request.url === '/api/ai/settings') {
    const stored = readAi();
    const base = stored?.base ?? envAi.base ?? '';
    const match = Object.keys(modelPresets).find(key => modelPresets[key] === base.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
    const provider = stored?.provider ?? (match === 'ollama' ? 'custom' : match) ?? 'custom';
    return send(200, { base, provider, presets:modelPresets, model: stored?.model ?? envAi.model ?? '',
      configured: Boolean(stored ? stored.encryptedKey || stored.provider === 'ollama' : envAi.key && envAi.base && envAi.model), saved: Boolean(stored) });
  }
  const isDeleteWork = request.method === 'DELETE' && request.url.startsWith('/api/work/');
  const isDeleteWorkData = request.method === 'DELETE' && request.url.startsWith('/api/work-data/');
  if (isDeleteWork || isDeleteWorkData) {
    if (request.headers.origin !== origin) return send(403,{ error:'无效的删除请求' });
    let id;
    try {
      id = decodeURIComponent(request.url.slice((isDeleteWork ? '/api/work/' : '/api/work-data/').length));
    } catch {
      return send(400,{ error:'无效的作品编号' });
    }
    if (!/^[\w-]+$/.test(id)) return send(400,{ error:'无效的作品编号' });
    try {
      if (isDeleteWork) {
        const row = getValue.get('works');
        const works = row ? JSON.parse(row.value) : [];
        if (!works.some(item => item.id === id)) return send(404,{ error:'作品不存在' });
        db.exec('BEGIN');
        try {
          write.run('works',JSON.stringify(works.filter(item => item.id !== id)));
          deleteValue.run('chapters:' + id);
          deleteValue.run('volumes:' + id);
          deleteValue.run('plans:' + id);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else {
        deleteValue.run('chapters:' + id);
        deleteValue.run('volumes:' + id);
        deleteValue.run('plans:' + id);
      }
      return send(200,{ deleted:true });
    } catch {
      return send(500,{ error:'本地作品数据删除失败' });
    }
  }
  const isSettings = request.method === 'PUT' && request.url === '/api/ai/settings';
  const isGeneration = request.method === 'POST' && request.url === '/api/ai/generate';
  const isImport = request.method === 'POST' && request.url === '/api/import-book';
  if (!isSettings && !isGeneration && !isImport && (request.method !== 'PUT' || !request.url.startsWith('/api/value/'))) return send(404, { error: '路径不存在' });
  if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
    if (!isImport || request.headers.origin !== origin) return send(403, { error: '无效的写入请求' });
  }
  try {
    if (isImport) {
      let book;
      if (request.headers['content-type'] === 'application/json') {
        const input = await readJson(request,16384);
        if (!input || typeof input.url !== 'string' || !input.url.trim()) {
          return send(400,{ error:'请填写在线小说网址' });
        }
        book = await importOnlineNovel(input.url.trim());
      } else {
        let filename = 'uploaded-novel.txt';
        try { filename = decodeURIComponent(request.headers['x-file-name'] || filename); } catch {}
        filename = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(-180);
        book = decodeBookFile(await readBuffer(request),filename);
      }
      if (!book.text?.trim()) return send(400,{ error:'没有从导入内容中识别到小说正文' });
      return send(200,book);
    }
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
