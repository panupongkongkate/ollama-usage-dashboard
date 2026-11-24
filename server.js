const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// All paths are configurable via environment variables (no hardcoded user names).
const HOME = process.env.HOME || os.homedir();
const DATA_DIR = process.env.DASH_DATA_DIR || path.join(HOME, 'ollama-dashboard');
const LOG_DIR = process.env.OLLAMA_LOG_DIR || path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Ollama');
const MANIFEST_DIR = process.env.OLLAMA_MANIFEST_DIR || path.join(HOME, '.ollama', 'models', 'manifests');
// Path to the ollama executable (defaults: `ollama` on PATH, or the common Windows install location).
const OLLAMA_BIN = process.env.OLLAMA_BIN || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe') : 'ollama');
const DB_PATH = path.join(DATA_DIR, 'usage.db');
const PORT = Number(process.env.DASH_PORT || 8799);

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    req_key TEXT PRIMARY KEY,
    ts TEXT,
    day TEXT,
    week TEXT,
    month TEXT,
    model TEXT,
    endpoint TEXT,
    client TEXT,
    input_total INTEGER,
    input_cached INTEGER,
    input_eval INTEGER,
    output_tokens INTEGER,
    prompt_ms REAL,
    eval_ms REAL,
    prompt_tps REAL,
    eval_tps REAL,
    duration_s REAL
  );
  CREATE INDEX IF NOT EXISTS idx_day ON requests(day);
  CREATE INDEX IF NOT EXISTS idx_week ON requests(week);
  CREATE INDEX IF NOT EXISTS idx_month ON requests(month);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
`);

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO requests (
    req_key, ts, day, week, month, model, endpoint, client,
    input_total, input_cached, input_eval, output_tokens,
    prompt_ms, eval_ms, prompt_tps, eval_tps, duration_s
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function buildBlobModelMap() {
  const map = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else {
        try {
          const rel = path.relative(MANIFEST_DIR, p).replace(/\\/g, '/');
          const parts = rel.split('/');
          const modelName = parts.slice(1, -1).join('/') + ':' + parts[parts.length - 1];
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          for (const l of (j.layers || [])) {
            if (l.mediaType === 'application/vnd.ollama.image.model' && l.digest) {
              const sha = l.digest.replace('sha256:', 'sha256-');
              if (!map[sha] || modelName.endsWith(':128k')) map[sha] = modelName;
            }
          }
        } catch {}
      }
    }
  }
  walk(MANIFEST_DIR);
  return map;
}

function getISOWeek(dStr) {
  const d = new Date(dStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dStr.slice(0, 7);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

function saveTask(t) {
  const ts = t.ts || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const day = ts.slice(0, 10);
  const month = ts.slice(0, 7);
  const week = getISOWeek(day);
  const inputTotal = Math.max(t.inputTotal || 0, t.inputEval || 0);
  const inputEval = t.inputEval || 0;
  const inputCached = Math.max(0, inputTotal - inputEval);
  const outputTokens = t.outputTokens || 0;
  const endpoint = t.endpoint || '/api/chat';
  const client = endpoint.startsWith('/v1/') ? 'OpenClaw (Discord/Teams)' : 'Cline CLI / Native API';
  const reqKey = `${ts}_${t.slot}_${t.task}_${inputTotal}_${outputTokens}`;
  insertStmt.run(
    reqKey, ts, day, week, month, t.model, endpoint, client,
    inputTotal, inputCached, inputEval, outputTokens,
    t.promptMs || 0, t.evalMs || 0, t.promptTps || 0, t.evalTps || 0, t.durationS || 0
  );
}

function syncLogs() {
  const blobMap = buildBlobModelMap();
  if (!fs.existsSync(LOG_DIR)) return;
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => /^server.*\.log$/i.test(f))
    .map(f => ({ name: f, full: path.join(LOG_DIR, f), mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  let currentModel = 'openthai/openthai2.0-qwen3.8-27b:128k';
  let lastIsoTime = null;

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const content = fs.readFileSync(file.full, 'utf8');
      const lines = content.split(/\r?\n/);
      const activeTasks = {};
      const pendingCompleted = [];

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const tmMatch = line.match(/time=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (tmMatch) lastIsoTime = tmMatch[1].replace('T', ' ');

        const modelMatch = line.match(/--model\s+[^\s]*?(sha256-[0-9a-f]{64})/i);
        if (modelMatch) {
          const sha = modelMatch[1];
          currentModel = blobMap[sha] || sha.slice(0, 19);
        }

        const npMatch = line.match(/slot\s+operator\(\):\s+id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+new prompt,.*?task\.n_tokens\s*=\s*(\d+)/);
        if (npMatch) {
          const key = npMatch[1] + ':' + npMatch[2];
          activeTasks[key] = {
            slot: npMatch[1],
            task: npMatch[2],
            inputTotal: parseInt(npMatch[3], 10),
            promptMs: 0,
            inputEval: 0,
            promptTps: 0,
            evalMs: 0,
            outputTokens: 0,
            evalTps: 0,
            ts: lastIsoTime,
            model: currentModel
          };
          continue;
        }

        const peMatch = line.match(/slot\s+print_timing:\s+id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
        if (peMatch) {
          const key = peMatch[1] + ':' + peMatch[2];
          if (!activeTasks[key]) activeTasks[key] = { slot: peMatch[1], task: peMatch[2], inputTotal: parseInt(peMatch[4], 10), model: currentModel };
          activeTasks[key].promptMs = parseFloat(peMatch[3]);
          activeTasks[key].inputEval = parseInt(peMatch[4], 10);
          activeTasks[key].promptTps = parseFloat(peMatch[5]);
          continue;
        }

        const evMatch = line.match(/slot\s+print_timing:\s+id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second/);
        if (evMatch) {
          const key = evMatch[1] + ':' + evMatch[2];
          if (!activeTasks[key]) activeTasks[key] = { slot: evMatch[1], task: evMatch[2], inputTotal: 0, inputEval: 0, promptMs: 0, promptTps: 0, model: currentModel };
          const t = activeTasks[key];
          t.evalMs = parseFloat(evMatch[3]);
          t.outputTokens = parseInt(evMatch[4], 10);
          t.evalTps = parseFloat(evMatch[5]);
          pendingCompleted.push(t);
          delete activeTasks[key];
          continue;
        }

        const ginMatch = line.match(/\[GIN\]\s+(\d{4}\/\d{2}\/\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})\s+\|\s+\d+\s+\|\s+([^|]+)\|\s+[^|]+\|\s+POST\s+"([^"]+)"/);
        if (ginMatch) {
          const datePart = ginMatch[1].replace(/\//g, '-');
          const timePart = ginMatch[2];
          const durRaw = ginMatch[3].trim();
          const endpoint = ginMatch[4];
          lastIsoTime = datePart + ' ' + timePart;
          if ((endpoint.includes('chat') || endpoint.includes('generate') || endpoint.includes('completions')) && pendingCompleted.length > 0) {
            const t = pendingCompleted.shift();
            t.ts = lastIsoTime;
            t.endpoint = endpoint;
            let durS = (t.promptMs + t.evalMs) / 1000;
            const mMin = durRaw.match(/(\d+)m([\d.]+)s/);
            const mSec = durRaw.match(/^([\d.]+)s$/);
            const mMs = durRaw.match(/^([\d.]+)ms$/);
            if (mMin) durS = parseInt(mMin[1], 10) * 60 + parseFloat(mMin[2]);
            else if (mSec) durS = parseFloat(mSec[1]);
            else if (mMs) durS = parseFloat(mMs[1]) / 1000;
            t.durationS = durS;
            saveTask(t);
          }
        }
      }
      for (const t of pendingCompleted) {
        if (!t.ts) t.ts = new Date(file.mtime).toISOString().slice(0, 19).replace('T', ' ');
        t.endpoint = t.endpoint || '/api/chat';
        t.durationS = (t.promptMs + t.evalMs) / 1000;
        saveTask(t);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('Sync error:', e);
  }
}

function getGpuAndPsStatus() {
  let gpus = [];
  let ollamaPs = [];
  try {
    const smi = execSync('nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits', { encoding: 'utf8', timeout: 3000 });
    gpus = smi.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [index, name, memUsed, memTotal, util, temp] = line.split(',').map(s => s.trim());
      return { index: +index, name, memUsed: +memUsed, memTotal: +memTotal, util: +util, temp: +temp };
    });
  } catch {}
  try {
    const psOut = execSync(OLLAMA_BIN + ' ps', { encoding: 'utf8', timeout: 3000 });
    const lines = psOut.trim().split(/\r?\n/).slice(1);
    ollamaPs = lines.filter(Boolean).map(l => {
      const parts = l.trim().split(/\s{2,}/);
      return { name: parts[0] || '', id: parts[1] || '', size: parts[2] || '', processor: parts[3] || '', context: parts[4] || '', until: parts[5] || '' };
    });
  } catch {}
  return { gpus, ollamaPs };
}

function getDashboardData() {
  syncLogs();
  const now = new Date();
  const offsetMs = 7 * 3600 * 1000;
  const localIso = new Date(now.getTime() + offsetMs).toISOString();
  const today = localIso.slice(0, 10);
  const thisMonth = localIso.slice(0, 7);
  const thisWeek = getISOWeek(today);

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(input_total + output_tokens), 0) as total_tokens,
      COALESCE(SUM(input_total), 0) as total_input,
      COALESCE(SUM(input_cached), 0) as total_cached,
      COALESCE(SUM(input_eval), 0) as total_eval,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(AVG(CASE WHEN eval_tps > 0 THEN eval_tps END), 0) as avg_eval_tps,
      COALESCE(AVG(CASE WHEN prompt_tps > 0 THEN prompt_tps END), 0) as avg_prompt_tps,
      COALESCE(SUM(CASE WHEN day = ? THEN input_total + output_tokens ELSE 0 END), 0) as today_tokens,
      COALESCE(SUM(CASE WHEN day = ? THEN output_tokens ELSE 0 END), 0) as today_output,
      COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), 0) as today_requests,
      COALESCE(SUM(CASE WHEN week = ? THEN input_total + output_tokens ELSE 0 END), 0) as week_tokens,
      COALESCE(SUM(CASE WHEN week = ? THEN output_tokens ELSE 0 END), 0) as week_output,
      COALESCE(SUM(CASE WHEN week = ? THEN 1 ELSE 0 END), 0) as week_requests,
      COALESCE(SUM(CASE WHEN month = ? THEN input_total + output_tokens ELSE 0 END), 0) as month_tokens,
      COALESCE(SUM(CASE WHEN month = ? THEN output_tokens ELSE 0 END), 0) as month_output,
      COALESCE(SUM(CASE WHEN month = ? THEN 1 ELSE 0 END), 0) as month_requests
    FROM requests
  `).get(today, today, today, thisWeek, thisWeek, thisWeek, thisMonth, thisMonth, thisMonth);

  const byDay = db.prepare(`
    SELECT day as label, COUNT(*) as requests,
      SUM(input_cached) as input_cached, SUM(input_eval) as input_eval,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens,
      ROUND(AVG(CASE WHEN eval_tps > 0 THEN eval_tps END), 1) as avg_tps
    FROM requests GROUP BY day ORDER BY day ASC
  `).all();

  const byWeek = db.prepare(`
    SELECT week as label, COUNT(*) as requests,
      SUM(input_cached) as input_cached, SUM(input_eval) as input_eval,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens,
      ROUND(AVG(CASE WHEN eval_tps > 0 THEN eval_tps END), 1) as avg_tps
    FROM requests GROUP BY week ORDER BY week ASC
  `).all();

  const byMonth = db.prepare(`
    SELECT month as label, COUNT(*) as requests,
      SUM(input_cached) as input_cached, SUM(input_eval) as input_eval,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens,
      ROUND(AVG(CASE WHEN eval_tps > 0 THEN eval_tps END), 1) as avg_tps
    FROM requests GROUP BY month ORDER BY month ASC
  `).all();

  const byModel = db.prepare(`
    SELECT model, COUNT(*) as requests,
      SUM(input_cached) as input_cached, SUM(input_eval) as input_eval,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens,
      ROUND(AVG(CASE WHEN eval_tps > 0 THEN eval_tps END), 1) as avg_tps
    FROM requests GROUP BY model ORDER BY total_tokens DESC
  `).all();

  const byClient = db.prepare(`
    SELECT client, COUNT(*) as requests,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens
    FROM requests GROUP BY client ORDER BY total_tokens DESC
  `).all();

  const byDayModel = db.prepare(`
    SELECT day, model, COUNT(*) as requests,
      SUM(input_total) as input_total, SUM(output_tokens) as output_tokens,
      SUM(input_total + output_tokens) as total_tokens
    FROM requests GROUP BY day, model ORDER BY day DESC, total_tokens DESC
  `).all();

  const recent = db.prepare(`
    SELECT ts, model, client, endpoint, input_total, input_cached, input_eval, output_tokens,
      ROUND(eval_tps, 1) as eval_tps, ROUND(duration_s, 2) as duration_s
    FROM requests ORDER BY ts DESC LIMIT 60
  `).all();

  return {
    updatedAt: localIso.slice(0, 19).replace('T', ' '),
    today, thisWeek, thisMonth,
    summary,
    byDay, byWeek, byMonth,
    byModel, byClient, byDayModel,
    recent,
    live: getGpuAndPsStatus()
  };
}

if (process.argv.includes('--sync-only')) {
  syncLogs();
  const c = db.prepare('SELECT COUNT(*) as requests, SUM(input_total) as input_total, SUM(output_tokens) as output_tokens FROM requests').get();
  console.log('Sync complete:', c);
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/stats') {
    try {
      const data = getDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const htmlPath = path.join(DATA_DIR, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(htmlPath));
  } else {
    res.writeHead(404);
    res.end('Dashboard UI not found');
  }
});

// Periodic background sync every 30s so logs are captured even if no browser is open
setInterval(() => { try { syncLogs(); } catch {} }, 30000);
syncLogs();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ollama Dashboard listening on http://0.0.0.0:${PORT}`);
});
