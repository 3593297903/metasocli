import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { saveLocalApiKey, credentialStatus } from '../dist/metaso/credentials.js';

// Short-lived loopback form; no third-party assets, plaintext files or generated video requests.

const token = randomUUID();
let origin, consumed = false;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== new URL(origin).host || req.url !== '/' + token || consumed) {
    res.writeHead(404); res.end('Unavailable'); return;
  }
  if (req.method === 'GET') {
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>metasocli 本机账号连接</title><h1>metasocli 本机账号连接</h1><p>将现有 Metaso API Key 加密保存到本项目，仅供当前 Windows 用户读取。本操作不生成视频。</p><form method="post"><label>Metaso API Key<input type="password" name="apiKey" required autocomplete="off" maxlength="4096"></label><button type="submit">连接并加密保存</button></form></html>'); return;
  }
  if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
    res.writeHead(403); res.end('Denied'); return;
  }
  consumed = true;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 8192) throw new Error('Input too large');
    }
    const form = new URLSearchParams(body);
    if (form.getAll('apiKey').length !== 1) throw new Error('Missing key');
    await saveLocalApiKey(form.get('apiKey'));
    body = '';
    const status = await credentialStatus();
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>metasocli 已保存连接</title><h1>连接凭据已加密保存</h1><p>CLI 将自动读取此安装的凭据。没有提交生成任务；正在进行只读认证检查。</p></html>');
    console.log(JSON.stringify({ saved: true, ...status }));
  } catch (e) {
    res.writeHead(500); res.end('Local credential could not be saved. No generation submitted.');
    console.log(JSON.stringify({ saved: false, code: typeof e.code === 'string' ? e.code : 'LOCAL_ERROR' }));
    process.exitCode = 1;
  } finally { clearTimeout(timer); server.close(); }
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
const timer = setTimeout(() => server.close(), 600000);
server.listen(0, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log(JSON.stringify({ setupUrl: origin + '/' + token }));
});
