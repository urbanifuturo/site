#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  Urbani Futuro — Servidor com Google Gemini GRATUITO
//  Modelos gratuitos 2025/2026:
//    gemini-2.5-flash-lite  → 15 req/min, 1000/dia  (mais rápido)
//    gemini-2.5-flash       → 10 req/min, 500/dia
//    gemini-2.5-pro         →  5 req/min, 100/dia
//
//  1. Chave grátis: https://aistudio.google.com/apikey
//  2. Crie api_key.txt com a chave AIzaSy...
//  3. Execute: node server.js
//  4. Acesse:  http://localhost:3000
// ═══════════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const PORT  = 3000;

// Rate limit: espaço mínimo entre requisições (free tier = 15 req/min)
let lastReqTime = 0;
const MIN_INTERVAL_MS = 5000; // 5s entre req para não estourar

function getKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const f = path.join(__dirname, 'api_key.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function proxyGemini(reqBody, res) {
  const key = getKey();
  if (!key) {
    send200(res, { error: { message: 'Chave não encontrada. Crie api_key.txt com sua chave AIzaSy...' } });
    return;
  }

  // Garante intervalo mínimo entre requisições
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastReqTime));
  if (wait > 0) {
    console.log(`  ⏳ Aguardando ${(wait/1000).toFixed(1)}s (rate limit free tier)...`);
    await sleep(wait);
  }
  lastReqTime = Date.now();

  let parsed;
  try { parsed = JSON.parse(reqBody); } catch(e) {
    send200(res, { error: { message: 'JSON inválido' } }); return;
  }
  const prompt = (parsed.messages || []).map(m => m.content).join('\n');
  const geminiBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
  });

  // Tenta modelos em ordem do mais leve para o mais pesado
  const MODELS = [
    'gemini-2.5-flash-lite',   // 15 req/min, 1000/dia — ideal
    'gemini-2.5-flash',        // 10 req/min, 500/dia  — fallback
    'gemini-2.5-pro',          // 5 req/min,  100/dia  — último recurso
  ];

  async function tryModel(idx) {
    if (idx >= MODELS.length) {
      send200(res, { error: { message: 'Quota do plano gratuito esgotada. Aguarde alguns minutos e tente de novo.' } });
      return;
    }
    const model = MODELS[idx];
    console.log(`  🤖 Tentando modelo: ${model}`);

    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${key}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(geminiBody) }
    };

    const req = https.request(opts, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', async () => {
        try {
          const gr = JSON.parse(data);
          if (gr.error) {
            const msg = gr.error.message || '';
            const isQuota = msg.toLowerCase().includes('quota') ||
                            msg.toLowerCase().includes('resource_exhausted') ||
                            r.statusCode === 429;
            if (isQuota) {
              console.log(`  ⚠  ${model} sem quota. Tentando próximo modelo...`);
              await sleep(3000);
              tryModel(idx + 1);
              return;
            }
            send200(res, { error: { message: msg } }); return;
          }
          const text = gr.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (!text) { 
            // Loga o motivo se disponível
            const reason = gr.candidates?.[0]?.finishReason || 'desconhecido';
            console.log(`  ❌ Resposta vazia. finishReason: ${reason}`);
            console.log(`  📄 Resposta completa: ${JSON.stringify(gr).slice(0,500)}`);
            send200(res, { error: { message: 'Resposta vazia. finishReason: ' + reason } }); 
            return; 
          }
          console.log(`  ✅ ${model}: ${text.length} chars`);
          // Log primeiros 300 chars para debug
          console.log(`  📄 Preview: ${text.slice(0,300).replace(/\n/g,' ')}`);
          send200(res, { content: [{ type: 'text', text }] });
        } catch(e) {
          send200(res, { error: { message: 'Erro ao processar: ' + e.message } });
        }
      });
    });
    req.on('error', e => send200(res, { error: { message: 'Conexão falhou: ' + e.message } }));
    req.write(geminiBody);
    req.end();
  }

  tryModel(0);
}

function send200(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function proxyGeoJSON(res) {
  https.get({
    hostname: 'raw.githubusercontent.com',
    path: '/codeforgermany/click_that_hood/main/public/data/brazil-states.geojson',
    headers: { 'User-Agent': 'urbani-futuro' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
      res.end(d);
    });
  }).on('error', () => { res.writeHead(502); res.end('{}'); });
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let b = ''; req.on('data', c => b += c); req.on('end', () => proxyGemini(b, res)); return;
  }
  if (req.url === '/api/geojson') { proxyGeoJSON(res); return; }

  let fp = req.url === '/' ? '/index.html' : req.url;
  fp = path.join(__dirname, fp.split('?')[0]);
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                 '.png':'image/png', '.jpg':'image/jpeg', '.json':'application/json' }[path.extname(fp)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(fp).pipe(res);

}).listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║     Urbani Futuro — Servidor iniciado      ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
  console.log('  🌐  http://localhost:' + PORT);
  console.log('  🤖  IA: Gemini 2.5 Flash-Lite (gratuito)');
  console.log('  ⏱   Intervalo: 5s entre requisições');
  const key = getKey();
  if (key) {
    console.log('  🔑  Chave: ' + key.slice(0,10) + '...' + key.slice(-4));
  } else {
    console.log('');
    console.log('  ⚠   Chave não encontrada!');
    console.log('      Crie api_key.txt com sua chave AIzaSy...');
    console.log('      Obtenha grátis: https://aistudio.google.com/apikey');
  }
  console.log('');
});
