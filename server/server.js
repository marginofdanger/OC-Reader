const express = require('express');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const yt = require('./youtube-helpers');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = 3220;
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
];
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const PROMPT_PATH = path.resolve(__dirname, 'prompt.txt');
const SERVER_LOG = path.resolve(__dirname, 'server.log');
const STYLE_CSS_PATH = path.resolve(__dirname, 'style.css');
const EARNINGS_STYLE_CSS_PATH = path.resolve(__dirname, 'earnings-style.css');
const CODEX_OVERLAY_DIR = path.resolve(__dirname, 'codex-overlays');

// Sharing: published copies go to this local git repo, get committed,
// pushed, and become public at SHARE_BASE_URL/<filename>. Override via
// environment variables if the layout differs.
const SHARE_REPO_PATH = process.env.READER_SHARE_REPO
  || path.resolve(__dirname, '..', '..', 'marginofdanger.github.io');
const SHARE_SUBDIR = process.env.READER_SHARE_SUBDIR || 'reader/shares';
const SHARE_BASE_URL = process.env.READER_SHARE_BASE_URL
  || 'https://marginofdanger.github.io/reader/shares';

function readStyleCss() {
  try { return fs.readFileSync(STYLE_CSS_PATH, 'utf-8'); }
  catch (e) { return ''; }
}

function readEarningsStyleCss() {
  try { return fs.readFileSync(EARNINGS_STYLE_CSS_PATH, 'utf-8'); }
  catch (e) { return ''; }
}

// Replace a <link rel="stylesheet" href="X"> with an inline <style> block
// containing the file's contents — used when sharing a file off-server,
// since /style.css and /earnings-style.css only exist on localhost.
function inlineStylesheet(html, hrefPath, cssContents) {
  const linkTag = `<link rel="stylesheet" href="${hrefPath}">`;
  if (html.includes(linkTag)) {
    return html.replace(linkTag, `<style>\n${cssContents}\n</style>`);
  }
  return html;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(SERVER_LOG, line + '\n');
}

function uniqueFilename(dir, name) {
  let filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) return { filename: name, outputPath: filePath };
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  let i = 2;
  while (fs.existsSync(filePath)) {
    const newName = `${base}-${i}${ext}`;
    filePath = path.join(dir, newName);
    if (!fs.existsSync(filePath)) return { filename: newName, outputPath: filePath };
    i++;
  }
  return { filename: name, outputPath: filePath };
}
function normalizeProvider(provider) {
  const p = String(provider || 'claude').toLowerCase();
  return p === 'codex' ? 'codex' : 'claude';
}

function resolveCodexModel(model) {
  const m = String(model || '').trim();
  return m || DEFAULT_CODEX_MODEL;
}

function codexModelOptionsHtml(selected) {
  const selectedModel = resolveCodexModel(selected);
  return CODEX_MODEL_OPTIONS
    .map(m => `<option value="${m.value}" ${m.value === selectedModel ? 'selected' : ''}>${m.label}</option>`)
    .join('');
}

function processingLabel(provider, model) {
  if (provider === 'codex') return `codex:${resolveCodexModel(model)}`;
  return model || 'opus';
}

function providerSelectOptions(selected) {
  const provider = normalizeProvider(selected);
  return [
    `<option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude</option>`,
    `<option value="codex" ${provider === 'codex' ? 'selected' : ''}>Codex</option>`,
  ].join('');
}

function codexStyleOverlay(taskType) {
  const overlayName = {
    earnings: 'earnings.txt',
    expert: 'expert.txt',
    youtube: 'youtube.txt',
  }[taskType];

  if (!overlayName) return '';

  const overlayPath = path.join(CODEX_OVERLAY_DIR, overlayName);
  try {
    return fs.readFileSync(overlayPath, 'utf-8').trim();
  } catch (e) {
    log(`WARN Codex overlay unavailable for ${taskType}: ${e.message}`);
    return '';
  }
}
function codexPromptEnvelope(prompt, taskType) {
  const styleOverlay = codexStyleOverlay(taskType);
  return [
    'You are being run by a local transcript-processing server, not as an interactive coding agent.',
    'Do not inspect the repository. Do not run shell commands. Do not edit files.',
    'Transform only the transcript/content in the prompt below, and return only the requested output.',
    styleOverlay,
    '',
    prompt,
  ].filter(Boolean).join('\n');
}

function runClaudePrompt(prompt, { model, jobId, timeoutMs = 300000, env = {} }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', model || 'opus'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));
    child.on('close', code => {
      const stderr = Buffer.concat(errChunks).toString();
      if (stderr) log(`Job ${jobId} stderr: ${stderr.slice(0, 500)}`);
      if (code !== 0) {
        reject(new Error(`Claude exited ${code}: ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks).toString());
      }
    });
    child.on('error', err => reject(err));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function runCodexPrompt(prompt, { model, jobId, timeoutMs = 900000, env = {}, taskType = '' }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const args = ['exec', '--ephemeral', '--skip-git-repo-check'];
    const resolvedModel = resolveCodexModel(model);
    if (resolvedModel) args.push('-m', resolvedModel);
    args.push('-');
    const command = process.env.CODEX_CLI_PATH || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const spawnCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : command;
    const spawnArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', command, ...args]
      : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));
    child.on('close', code => {
      const stderr = Buffer.concat(errChunks).toString();
      if (stderr) log(`Job ${jobId} codex stderr: ${stderr.slice(0, 500)}`);
      if (code !== 0) {
        reject(new Error(`Codex exited ${code}: ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks).toString());
      }
    });
    child.on('error', err => reject(err));
    child.stdin.write(codexPromptEnvelope(prompt, taskType));
    child.stdin.end();
  });
}

function runProcessingPrompt(prompt, opts) {
  const provider = normalizeProvider(opts.provider);
  if (provider === 'codex') return runCodexPrompt(prompt, opts);
  return runClaudePrompt(prompt, opts);
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve output files at /output/filename.html
app.use('/output', express.static(OUTPUT_DIR));

// Serve style.css at /style.css (referenced by YouTube output shell)
app.get('/style.css', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'style.css'));
});

// Serve earnings-style.css at /earnings-style.css (referenced by every
// earnings-call summary so its CSS lives in one editable file rather
// than being regenerated by the model on each call).
app.get('/earnings-style.css', (req, res) => {
  res.sendFile(EARNINGS_STYLE_CSS_PATH);
});

// Serve favicon.svg — referenced by the /status page so the bookmark in
// Brave/Chrome shows a recognizable icon rather than the default globe.
app.get('/favicon.svg', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'favicon.svg'));
});

// Request queue — concurrent workers
const queue = [];
let activeWorkers = 0;
let maxConcurrency = 3;
const activeJobs = []; // track all currently processing jobs
const processing = () => activeWorkers > 0;
const LOG_PATH = path.resolve(__dirname, '..', 'output', 'history.json');
// Load history from disk
let completedJobs = [];
try { completedJobs = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); } catch (e) {}

// Bookmarks
const BOOKMARKS_PATH = path.resolve(__dirname, '..', 'output', 'bookmarks.json');
let bookmarks = [];
try { bookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, 'utf-8')); } catch (e) {}

const DATE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_INDEX = Object.fromEntries(DATE_MONTHS.map((m, i) => [m.toLowerCase(), i]));

function parseBookmarkDateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;

  const monthMatch = raw.match(/^(\d{1,2})\s*[-\s]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\s]\s*(\d{2,4})$/i);
  if (monthMatch) {
    const day = parseInt(monthMatch[1], 10);
    const month = MONTH_INDEX[monthMatch[2].slice(0, 3).toLowerCase()];
    let year = parseInt(monthMatch[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, month, day);
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10) - 1;
    const day = parseInt(slashMatch[2], 10);
    let year = parseInt(slashMatch[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, month, day);
  }

  return Number.NEGATIVE_INFINITY;
}

function formatBookmarkDate(value) {
  const ms = parseBookmarkDateMs(value);
  if (!Number.isFinite(ms)) return String(value || '');
  const d = new Date(ms);
  return String(d.getUTCDate()).padStart(2, '0') + '-' + DATE_MONTHS[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(-2);
}

function bookmarksByCallDate() {
  return bookmarks
    .map((bookmark, index) => ({ bookmark, index, sortDate: parseBookmarkDateMs(bookmark.date) }))
    .sort((a, b) => (b.sortDate - a.sortDate) || (b.index - a.index))
    .map(item => item.bookmark);
}

// Job tracking for async polling
let jobCounter = 0;
const jobs = new Map(); // jobId -> { status, filename, error, company, quarter, year }

let queueIdCounter = 0;
function enqueue(fn, label) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, label, queueId: ++queueIdCounter });
    processQueue();
  });
}

async function processQueue() {
  while (activeWorkers < maxConcurrency && queue.length > 0) {
    const { fn, resolve, reject } = queue.shift();
    activeWorkers++;
    (async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        activeWorkers--;
        processQueue();
      }
    })();
  }
}


function saveEarningsHtmlOutput(html, opts) {
  if (!html || (!html.includes('<!DOCTYPE') && !html.includes('<html'))) {
    throw new Error(`Empty or invalid HTML output (${html ? html.length : 0} chars). First 200: ${(html || '').slice(0, 200)}`);
  }

  const company = opts.company || 'UNKNOWN';
  const quarter = opts.quarter || 'QX';
  const year = opts.year || new Date().getFullYear();
  const sanitized = company
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase();
  const suffix = opts.filenameSuffix || '';
  const { filename, outputPath } = uniqueFilename(OUTPUT_DIR, `${sanitized}-${quarter}-${year}${suffix}.html`);

  let finalHtml = html.replace(/<style[^>]*>[\s\S]*?<\/style>\s*/gi, '');
  finalHtml = finalHtml.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>\s*/gi, '');
  finalHtml = finalHtml.replace('</head>', '<link rel="stylesheet" href="/earnings-style.css">\n</head>');
  finalHtml = finalHtml.replace('</head>', `<meta name="summarizer-verbosity" content="${opts.verbosity}">\n<meta name="summarizer-model" content="${opts.target}">\n</head>`);

  const earningsSource = 'EC';
  const earningsDate = opts.eventDate || `${quarter} ${year}`;
  finalHtml = finalHtml.replace(/(<(?:button|a)[^>]*id="bookmark-btn")[^>]*>/, (match, prefix) => {
    const cleaned = prefix.replace(/\s+data-[a-z-]+="[^"]*"/gi, '');
    const hasOnclick = /onclick/.test(cleaned);
    return `${cleaned} data-source-url="${(opts.sourceUrl || '').replace(/"/g, '&quot;')}" data-interview-date="${String(earningsDate).replace(/"/g, '&quot;')}" data-source="${earningsSource}" data-expert="${company.replace(/"/g, '&quot;')}"${hasOnclick ? '' : ' onclick="bookmarkTranscript()"'}>`;
  });

  const shareBtn = `<button id="share-btn" title="Share" aria-label="Share" data-filename="${filename.replace(/"/g, '&quot;')}" onclick="shareEarningsPage(this)">&#8599;</button>`;
  finalHtml = finalHtml.replace(
    /(<button\b[^>]*id="bookmark-btn"[^>]*>[^<]*<\/button>)/i,
    `$1\n      ${shareBtn}`
  );

  const extraScript = `
function shareEarningsPage(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '\\u2026';
  fetch('http://localhost:3220/share', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ filename: btn.dataset.filename }) })
    .then(r => r.json())
    .then(j => {
      if (!j.ok) throw new Error(j.error || 'Share failed');
      try { navigator.clipboard.writeText(j.url); } catch(e) {}
      btn.innerHTML = '\\u2713';
      btn.title = 'Copied ' + j.url;
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 2500);
    })
    .catch(e => {
      console.error('Share failed:', e);
      btn.innerHTML = '!';
      btn.title = 'Share failed: ' + (e && e.message || e);
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 3000);
    });
}
(function hideLocalOnlyControls() {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const bm = actions.querySelector('#bookmark-btn');
  const sh = actions.querySelector('#share-btn');
  if (bm) bm.remove();
  if (sh) sh.remove();
})();
`;
  finalHtml = finalHtml.replace('</script>', extraScript + '</script>');

  const statusLink = `\n<footer style="max-width:90ch;margin:2rem auto 1rem;padding-top:0.75rem;border-top:1px solid #e8e0d4;text-align:right;font-size:0.7rem"><a href="http://localhost:3220/status" style="color:#8b6d4e;text-decoration:none">Summarizer Status ↗</a></footer>\n`;
  finalHtml = finalHtml.replace('</body>', statusLink + '</body>');
  fs.writeFileSync(outputPath, finalHtml, 'utf-8');
  return { filename, outputPath };
}
app.get('/health', (req, res) => {
  res.json({ status: 'ok', queued: queue.length, processing: processing(), activeWorkers, maxConcurrency });
});

// Remove item from queue
app.get('/queue/remove', (req, res) => {
  const id = parseInt(req.query.id);
  const idx = queue.findIndex(q => q.queueId === id);
  if (idx >= 0) {
    const removed = queue.splice(idx, 1)[0];
    removed.reject(new Error('Cancelled by user'));
    log(`Removed from queue: ${removed.label} (queueId=${id})`);
  }
  res.redirect('/status');
});

app.get('/status', (req, res) => {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Summarizer Status</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta http-equiv="refresh" content="15">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #faf8f5; color: #2c2418; margin: 0 auto; padding: 1.5rem 2rem; font-size: 0.9rem; max-width: 1600px; }
  h1 { font-size: 1.3rem; border-bottom: 2px solid #c4956a; padding-bottom: 0.5rem; margin-bottom: 1rem; }
  .columns { display: flex; gap: 2rem; }
  .col-status { flex: 1; min-width: 0; }
  .col-bookmarks { flex: 2; min-width: 0; }
  h3 { margin: 0.8rem 0 0.4rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
  .active { background: #d4edda; color: #155724; }
  .idle { background: #f0ebe3; color: #8b6d4e; }
  .queued-item { background: #fff3cd; color: #856404; padding: 0.4rem 0.7rem; border-radius: 4px; margin: 0.3rem 0; display: flex; justify-content: space-between; align-items: center; }
  .queued-item .q-remove { color: #b08000; text-decoration: none; font-size: 0.8rem; margin-left: 0.5rem; }
  .queued-item .q-remove:hover { color: #cc0000; }
  .done-item { background: #f0ebe3; padding: 0.4rem 0.7rem; border-radius: 0 4px 4px 0; margin: 0.3rem 0; display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; border-left: 3px solid #c4956a; gap: 0.5rem; }
  .done-item.expert { background: #edf2f8; border-left-color: #4a7ab5; }
  .done-item .done-left { flex: 1; min-width: 0; }
  .done-item .done-title { color: inherit; text-decoration: none; }
  .done-item .done-title:hover { text-decoration: underline; }
  .done-item .done-expert { font-size: 0.78rem; color: #6b7d94; }
  .done-item .done-right { flex-shrink: 0; white-space: nowrap; text-align: right; font-size: 0.78rem; }
  .time { color: #8b6d4e; }
  .bookmark-item { background: #edf2f8; border-left: 3px solid #4a7ab5; padding: 0.4rem 0.7rem; border-radius: 0 4px 4px 0; margin: 0.3rem 0; display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; gap: 0.5rem; }
  .bk-table { width: 100%; border-spacing: 0 0.3rem; }
  .bk-table td { vertical-align: middle; }
  .bk-table .bk-cell-title { padding: 0.4rem 0.7rem; background: #edf2f8; border-left: 3px solid #4a7ab5; border-radius: 0 4px 4px 0; }
  .bk-table .bk-cell-title a { color: #2c5282; text-decoration: none; font-weight: 400; font-size: 0.85rem; }
  .bk-table .bk-cell-title a:hover { text-decoration: underline; }
  .bk-table .bk-expert { font-size: 0.78rem; color: #6b7d94; }
  .bk-table .bk-cell-src { padding: 0.4rem 0.2rem; background: #edf2f8; font-size: 0.8rem; color: #4a7ab5; font-weight: 600; text-align: center; white-space: nowrap; width: 1.8rem; }
  .bk-table .bk-cell-date { padding: 0.4rem 0.2rem; background: #edf2f8; font-size: 0.8rem; color: #6b7d94; white-space: nowrap; width: 5rem; }
  .bk-table .bk-cell-remove { padding: 0.4rem 0.2rem 0.4rem 0; background: #edf2f8; width: 0.8rem; border-radius: 0 4px 4px 0; }
  .bk-table .bk-cell-remove a { color: #999; text-decoration: none; font-size: 0.8rem; }
  .bk-table .bk-cell-remove a:hover { color: #cc0000; }
  .bookmark-item .bk-remove { float: right; color: #999; cursor: pointer; text-decoration: none; font-size: 0.8rem; }
  .bookmark-item .bk-remove:hover { color: #cc0000; }
  .empty { color: #8b6d4e; font-style: italic; }
  .show-more { text-align: center; padding: 0.4rem; color: #8b6d4e; cursor: pointer; font-size: 0.82rem; font-weight: 600; border-radius: 4px; margin: 0.3rem 0; }
  .show-more:hover { background: #f0ebe3; }
  .toggle-btn { cursor: pointer; user-select: none; }
  .toggle-btn:hover { opacity: 0.7; }
  .col-status { flex: 1.4; overflow: hidden; }
  .col-status.expanded { flex: 2.5; }
  .columns.expanded-status .col-bookmarks { flex: 0.5; }
</style>
<script>
function toggleCompleted() {
  const col = document.getElementById('col-status');
  const columns = document.getElementById('columns');
  const arrow = document.getElementById('toggle-arrow');
  if (col.classList.contains('expanded')) {
    col.classList.remove('expanded');
    columns.classList.remove('expanded-status');
    arrow.textContent = '▶';
    sessionStorage.removeItem('completedOpen');
  } else {
    col.classList.add('expanded');
    columns.classList.add('expanded-status');
    arrow.textContent = '▼';
    sessionStorage.setItem('completedOpen', '1');
  }
}

// Restore state after auto-refresh
if (sessionStorage.getItem('completedOpen') === '1') {
  document.addEventListener('DOMContentLoaded', function() { toggleCompleted(); });
}
</script>
</head><body>
<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap">
<h1 style="margin-bottom:0">Expert / Earnings / YouTube Summarizer</h1>
<div style="font-size:0.78rem;color:#8b6d4e;display:flex;gap:1rem;align-items:center">
<span><strong>Status:</strong> <span class="badge ${processing() ? 'active' : 'idle'}">${processing() ? '⏳ ' + activeWorkers + '/' + maxConcurrency : '✓ Idle'}</span></span>
<label>EC verbosity <input type="number" id="ec-v" value="60" min="10" max="200" step="10" style="width:3rem;font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px 3px"></label>
<label>Expert verbosity <input type="number" id="ex-v" value="30" min="10" max="200" step="10" style="width:3rem;font-size:0.75rem;border:1px solid #4a7ab5;border-radius:3px;padding:1px 3px"></label>
<label>Workers <select id="conc" style="font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px"><option value="1">1</option><option value="2">2</option><option value="3" ${maxConcurrency===3?'selected':''}>3</option><option value="5" ${maxConcurrency===5?'selected':''}>5</option></select></label>
<label title="Default for earnings calls and expert transcripts">EC/Expert <select id="prov" style="font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px">${providerSelectOptions(settings.provider)}</select></label><label title="Default for YouTube transcript cleanup">YouTube <select id="yt-prov" style="font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px">${providerSelectOptions(settings.youtubeProvider || 'codex')}</select></label><label>Claude <select id="mod" style="font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px"><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></label><label>Codex <select id="codex-model" style="font-size:0.75rem;border:1px solid #c4956a;border-radius:3px;padding:1px">${codexModelOptionsHtml(settings.codexModel)}</select></label><label title="When EC/Expert provider is Codex, also run a matched Claude Opus copy for comparison">Shadow Opus <input type="checkbox" id="shadow-opus" ${settings.shadowOpusForCodex ? 'checked' : ''}></label>
</div>
</div>
<script>
// Sync settings with extension storage via server
fetch('/settings').then(r=>r.json()).then(s=>{
  if(s.ecVerbosity) document.getElementById('ec-v').value=s.ecVerbosity;
  if(s.exVerbosity) document.getElementById('ex-v').value=s.exVerbosity;
  if(s.concurrency) document.getElementById('conc').value=s.concurrency;
  if(s.provider) document.getElementById('prov').value=s.provider;
  if(s.youtubeProvider) document.getElementById('yt-prov').value=s.youtubeProvider;
  if(s.model) document.getElementById('mod').value=s.model;
  if(s.codexModel) document.getElementById('codex-model').value=s.codexModel;
  document.getElementById('shadow-opus').checked = !!s.shadowOpusForCodex;
});
['ec-v','ex-v','conc','prov','yt-prov','mod','codex-model','shadow-opus'].forEach(id=>{
  document.getElementById(id).addEventListener('change',()=>{
    const data={ecVerbosity:+document.getElementById('ec-v').value,exVerbosity:+document.getElementById('ex-v').value,concurrency:+document.getElementById('conc').value,provider:document.getElementById('prov').value,youtubeProvider:document.getElementById('yt-prov').value,model:document.getElementById('mod').value,codexModel:document.getElementById('codex-model').value,shadowOpusForCodex:document.getElementById('shadow-opus').checked};
    fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  });
});
</script>
${activeJobs.length > 0 ? activeJobs.map(j => `<p><strong>Current:</strong> ${j.company} ${j.quarter} ${j.year} (started ${Math.round((Date.now() - j.startTime) / 1000)}s ago)</p>`).join('') : ''}
${queue.length > 0 ? `<h3>Queue (${queue.length})</h3>` + queue.map((q, i) => `<div class="queued-item"><span>${i + 1}. ${q.label || 'Unknown'}</span><a class="q-remove" href="/queue/remove?id=${q.queueId}" title="Cancel">✕</a></div>`).join('') : '<p>Queue empty</p>'}
<div class="columns" id="columns">
<div class="col-bookmarks" id="col-bookmarks">
<h3>★ Bookmarked (${bookmarks.length})</h3>
${bookmarks.length > 0 ? '<table class="bk-table">' + bookmarksByCallDate().map(b => {
  const dateStr = formatBookmarkDate(b.date);
  const isEC = b.source === 'EC';
  const isYT = b.source === 'YT';
  // YouTube bookmarks share the earnings-call warm tan palette since
  // YT outputs use the same Reader style. Only expert calls get the blue.
  const isWarm = isEC || isYT;
  const bg = isWarm ? '#f0ebe3' : '#edf2f8';
  const border = isWarm ? '#c4956a' : '#4a7ab5';
  const srcColor = isWarm ? '#8b6d4e' : '#4a7ab5';
  const linkColor = isWarm ? '#5a4a3a' : '#2c5282';
  const localUrl = '/output/' + b.filename;
  const srcLink = b.url ? `<a href="${b.url}" target="_blank" style="color:${srcColor};text-decoration:none" title="Open original source">${b.source || ''}</a>` : (b.source || '');
  return `<tr><td class="bk-cell-title" style="background:${bg};border-left:3px solid ${border}"><a href="${localUrl}" target="_blank" style="color:${linkColor}">${b.title}</a>${b.expert ? `<div class="bk-expert">${b.expert}</div>` : ''}</td><td class="bk-cell-src" style="background:${bg}">${srcLink}</td><td class="bk-cell-date" style="background:${bg}">${dateStr}</td><td class="bk-cell-remove" style="background:${bg}"><a href="/bookmark/remove?filename=${encodeURIComponent(b.filename)}" title="Remove">✕</a></td></tr>`;
}).join('') + '</table>' : '<p class="empty">No bookmarks yet</p>'}
</div>
<div class="col-status" id="col-status">
<h3 class="toggle-btn" onclick="toggleCompleted()"><span id="toggle-arrow">▶</span> Completed (${completedJobs.length})</h3>
${completedJobs.length > 0 ? completedJobs.slice().reverse().map((j, i) => {
  const isExpert = (j.company || '').startsWith('[Expert]');
  const cls = isExpert ? 'done-item expert' : 'done-item';
  let title = (j.company || '') + ' ' + (j.quarter || '') + ' ' + (j.year || '');
  let role = '';
  if (isExpert) {
    title = title.replace(/^\[Expert\]\s*/, '');
    const dotIdx = title.indexOf(' · ');
    if (dotIdx > -1) { role = title.slice(dotIdx + 3).trim(); title = title.slice(0, dotIdx).trim(); }
  }
  const link = j.filename ? `<a class="done-title" href="/output/${j.filename}" target="_blank">${title}</a>` : `<span class="done-title">${title}</span>`;
  const timeStr = j.date ? new Date(j.date).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const hidden = i >= 30 ? ' style="display:none" class="' + cls + ' done-overflow"' : ' class="' + cls + '"';
  return `<div${hidden}><div class="done-left">${link}${role ? `<div class="done-expert">${role}</div>` : ''}</div><div class="done-right time">${timeStr} · ${j.timeSeconds}s</div></div>`;
}).join('') + (completedJobs.length > 30 ? `<div class="show-more" id="show-more-btn" onclick="document.querySelectorAll('.done-overflow').forEach(e=>e.style.display='');this.style.display='none'">Show ${completedJobs.length - 30} more...</div>` : '') : '<p class="empty">None yet</p>'}
</div>
</div>
<p class="time" style="margin-top:1rem;text-align:center">Auto-refreshes every 15s</p>
</body></html>`;
  res.send(html);
});

// Poll for job completion
app.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/summarize', async (req, res) => {
  const { company, quarter, year, eventDate, sourceUrl } = req.body;
  const lockedProvider = normalizeProvider(req.body.provider || settings.provider);
  const model = lockedProvider === 'codex'
    ? resolveCodexModel(req.body.codexModel || settings.codexModel)
    : (req.body.model || settings.model || 'opus');

  // Support both split and legacy formats
  let transcript = req.body.transcript || '';
  if (!transcript && (req.body.preparedRemarks || req.body.qanda)) {
    const isConference = !quarter;
    const header = isConference
      ? `${company} - Conference${eventDate ? ` (${eventDate})` : ''}`
      : `${company} - ${quarter} ${year} Earnings Call${eventDate ? ` (${eventDate})` : ''}`;
    transcript = `${header}\n\n`;
    if (sourceUrl) transcript += `Source: ${sourceUrl}\n\n`;
    transcript += `=== PREPARED REMARKS ===\n\n${req.body.preparedRemarks}\n\n`;
    transcript += `=== QUESTIONS AND ANSWERS ===\n\n${req.body.qanda}`;
  }

  if (!transcript) {
    return res.status(400).json({ success: false, error: 'Missing transcript text' });
  }

  // Lock in settings at click time
  const verbosity = req.body.verbosity || settings.ecVerbosity || 60;
  const lockedModel = model;
  const lockedTarget = processingLabel(lockedProvider, lockedModel);

  log(`POST /summarize: ${company} ${quarter} ${year} (transcript: ${transcript.length} chars, verbosity: ${verbosity}, provider: ${lockedProvider}, model: ${lockedTarget})`);

  // Assign job ID and respond immediately
  const jobId = String(++jobCounter);
  jobs.set(jobId, { status: 'queued', company, quarter, year });

  const position = queue.length + activeWorkers;
  if (position > 0) {
    log(`Queued: ${company} ${quarter} ${year} (position ${position + 1})`);
  }

  // Respond immediately so the extension doesn't time out
  res.json({ success: true, jobId, queued: position > 0 });

  // Process in background
  const label = `${company} ${quarter} ${year}`;
  enqueue(async () => {
    const startTime = Date.now();
    const jobEntry = { company, quarter, year, startTime, jobId };
    activeJobs.push(jobEntry);
    jobs.set(jobId, { status: 'processing', company, quarter, year });
    log(`Summarizing: ${label} [${lockedTarget}]`);

    try {
      let promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf-8');
      promptTemplate = promptTemplate.replace(/Verbosity level:\s*\d+/i, `Verbosity level: ${verbosity}`);
      log(`Job ${jobId}: verbosity=${verbosity} provider=${lockedProvider} model=${lockedTarget}`);
      const fullPrompt = `${promptTemplate}\n\n---\n\nTRANSCRIPT:\n\n${transcript}`;

      log(`Job ${jobId}: prompt size ${fullPrompt.length} chars`);
      const html = await runProcessingPrompt(fullPrompt, {
        provider: lockedProvider,
        model: lockedModel,
        jobId,
        timeoutMs: 300000,
      taskType: 'earnings',
      });
      // Validate output
      if (!html || (!html.includes('<!DOCTYPE') && !html.includes('<html'))) {
        throw new Error(`Empty or invalid HTML output (${html.length} chars). First 200: ${html.slice(0, 200)}`);
      }

      const sanitized = (company || 'UNKNOWN')
        .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
      const { filename, outputPath } = uniqueFilename(OUTPUT_DIR, `${sanitized}-${quarter || 'QX'}-${year || new Date().getFullYear()}.html`);

      // Strip any model-emitted <style> blocks AND any <link
      // rel="stylesheet"> tags (the model sometimes emits its own, often
      // with a broken relative href), then link the canonical earnings
      // stylesheet so every summary shares one editable CSS file.
      let finalHtml = html.replace(/<style[^>]*>[\s\S]*?<\/style>\s*/gi, '');
      finalHtml = finalHtml.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>\s*/gi, '');
      finalHtml = finalHtml.replace('</head>', '<link rel="stylesheet" href="/earnings-style.css">\n</head>');

      // Inject metadata into HTML head
      finalHtml = finalHtml.replace('</head>', `<meta name="summarizer-verbosity" content="${verbosity}">\n<meta name="summarizer-model" content="${lockedTarget}">\n</head>`);

      // Inject bookmark data attributes server-side for earnings calls — strip any Claude-generated data-* attrs first
      const earningsSource = 'EC';
      const earningsDate = eventDate || `${quarter} ${year}`;
      finalHtml = finalHtml.replace(/(<(?:button|a)[^>]*id="bookmark-btn")[^>]*>/, (match, prefix) => {
        const cleaned = prefix.replace(/\s+data-[a-z-]+="[^"]*"/gi, '');
        const hasOnclick = /onclick/.test(cleaned);
        return `${cleaned} data-source-url="${(sourceUrl || '').replace(/"/g, '&quot;')}" data-interview-date="${earningsDate.replace(/"/g, '&quot;')}" data-source="${earningsSource}" data-expert="${(company || '').replace(/"/g, '&quot;')}"${hasOnclick ? '' : ' onclick="bookmarkTranscript()"'}>`;
      });

      // Inject share button into .header-actions immediately after the
      // bookmark button. The model doesn't know its own filename, so the
      // button is added server-side with data-filename baked in.
      const shareBtn = `<button id="share-btn" title="Share" aria-label="Share" data-filename="${filename.replace(/"/g, '&quot;')}" onclick="shareEarningsPage(this)">&#8599;</button>`;
      finalHtml = finalHtml.replace(
        /(<button\b[^>]*id="bookmark-btn"[^>]*>[^<]*<\/button>)/i,
        `$1\n      ${shareBtn}`
      );

      // Append share + local-only-controls JS to the existing <script>
      // block. shareEarningsPage POSTs to /share (same endpoint YouTube
      // uses); hideLocalOnlyControls strips the share/bookmark buttons
      // when the page is viewed from GitHub Pages instead of localhost.
      const extraScript = `
function shareEarningsPage(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '\\u2026';
  fetch('http://localhost:3220/share', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ filename: btn.dataset.filename }) })
    .then(r => r.json())
    .then(j => {
      if (!j.ok) throw new Error(j.error || 'Share failed');
      try { navigator.clipboard.writeText(j.url); } catch(e) {}
      btn.innerHTML = '\\u2713';
      btn.title = 'Copied ' + j.url;
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 2500);
    })
    .catch(e => {
      console.error('Share failed:', e);
      btn.innerHTML = '!';
      btn.title = 'Share failed: ' + (e && e.message || e);
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 3000);
    });
}
(function hideLocalOnlyControls() {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const bm = actions.querySelector('#bookmark-btn');
  const sh = actions.querySelector('#share-btn');
  if (bm) bm.remove();
  if (sh) sh.remove();
})();
`;
      finalHtml = finalHtml.replace('</script>', extraScript + '</script>');

      // Inject status link before closing </body>
      const statusLink = `\n<footer style="max-width:90ch;margin:2rem auto 1rem;padding-top:0.75rem;border-top:1px solid #e8e0d4;text-align:right;font-size:0.7rem"><a href="http://localhost:3220/status" style="color:#8b6d4e;text-decoration:none">Summarizer Status ↗</a></footer>\n`;
      finalHtml = finalHtml.replace('</body>', statusLink + '</body>');
      fs.writeFileSync(outputPath, finalHtml, 'utf-8');

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Saved: ${outputPath} (${totalTime}s) [${queue.length} remaining in queue]`);
      completedJobs.push({ company, quarter, year, timeSeconds: parseFloat(totalTime), date: new Date().toISOString(), filename });
      try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);

      jobs.set(jobId, { status: 'done', filename, company, quarter, year, timeSeconds: parseFloat(totalTime) });

      if (lockedProvider === 'codex' && settings.shadowOpusForCodex) {
        const shadowJobId = String(++jobCounter);
        const shadowCompany = `[Opus Experiment] ${company}`;
        jobs.set(shadowJobId, { status: 'queued', company: shadowCompany, quarter, year });
        log(`Experiment: queued Opus shadow for ${label} (source job ${jobId})`);
        enqueue(async () => {
          const shadowStartTime = Date.now();
          const shadowEntry = { company: shadowCompany, quarter, year, startTime: shadowStartTime, jobId: shadowJobId };
          activeJobs.push(shadowEntry);
          jobs.set(shadowJobId, { status: 'processing', company: shadowCompany, quarter, year });
          log(`Experiment: running Opus shadow for ${label} [source ${lockedTarget}]`);
          try {
            const opusHtml = await runProcessingPrompt(fullPrompt, {
              provider: 'claude',
              model: 'opus',
              jobId: shadowJobId,
              timeoutMs: 300000,
              taskType: 'earnings',
            });
            const { filename: shadowFilename, outputPath: shadowOutputPath } = saveEarningsHtmlOutput(opusHtml, {
              company,
              quarter,
              year,
              eventDate,
              sourceUrl,
              verbosity,
              target: 'opus-experiment',
              filenameSuffix: '-OPUS-EXPERIMENT',
            });
            const shadowTime = ((Date.now() - shadowStartTime) / 1000).toFixed(1);
            log(`Experiment saved Opus shadow: ${shadowOutputPath} (${shadowTime}s) [source job ${jobId}]`);
            completedJobs.push({ company: shadowCompany, quarter, year, timeSeconds: parseFloat(shadowTime), date: new Date().toISOString(), filename: shadowFilename, experimentSourceJob: jobId, experimentProvider: 'opus' });
            try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
            const shadowIdx = activeJobs.findIndex(j => j.jobId === shadowJobId); if (shadowIdx >= 0) activeJobs.splice(shadowIdx, 1);
            jobs.set(shadowJobId, { status: 'done', filename: shadowFilename, company: shadowCompany, quarter, year, timeSeconds: parseFloat(shadowTime), experimentSourceJob: jobId });
          } catch (error) {
            log(`ERROR Experiment Opus shadow failed: ${error.message}`);
            const shadowIdx = activeJobs.findIndex(j => j.jobId === shadowJobId); if (shadowIdx >= 0) activeJobs.splice(shadowIdx, 1);
            jobs.set(shadowJobId, { status: 'error', error: error.message, company: shadowCompany, quarter, year, experimentSourceJob: jobId });
          }
        }, `${label} [Opus experiment]`).catch(() => {});
      }
    } catch (error) {
      log(`ERROR Summarization failed: ${error.message}`);
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);
      jobs.set(jobId, { status: 'error', error: error.message, company, quarter, year });
    }
  }, label);
});

// Expert transcript summarization
const EXPERT_PROMPT_PATH = path.resolve(__dirname, 'prompt-expert.txt');
const PROMPT_YT_PATH = path.resolve(__dirname, 'prompt-youtube.txt');

app.post('/summarize-expert', async (req, res) => {
  const { title, transcript, primaryCompany, interviewDate, expertPerspective, expertBio, source, sourceUrl } = req.body;
  const lockedProvider = normalizeProvider(req.body.provider || settings.provider);
  const model = lockedProvider === 'codex'
    ? resolveCodexModel(req.body.codexModel || settings.codexModel)
    : (req.body.model || settings.model || 'opus');

  if (!transcript || transcript.length < 200) {
    return res.status(400).json({ success: false, error: 'Missing or too short transcript text' });
  }

  // Build metadata header for Claude
  let header = `Expert Interview: ${title || 'Unknown'}\n`;
  if (primaryCompany) header += `Primary Company: ${primaryCompany}\n`;
  if (expertPerspective) header += `Expert: ${expertPerspective}\n`;
  if (expertBio) header += `Expert Bio: ${expertBio}\n`;
  if (interviewDate) header += `Interview Date: ${interviewDate}\n`;
  if (source) header += `Source: ${source}\n`;
  if (sourceUrl) header += `Source URL: ${sourceUrl}\n`;

  const fullTranscript = `${header}\n---\n\n${transcript}`;

  // Lock in settings at click time
  const verbosity = req.body.verbosity || settings.exVerbosity || 30;
  const lockedModel = model;
  const lockedTarget = processingLabel(lockedProvider, lockedModel);

  log(`POST /summarize-expert: "${title}" company=${primaryCompany || 'none'} expert=${expertPerspective || 'none'} source=${source || 'none'} date=${interviewDate || 'NONE'} (transcript: ${transcript.length} chars, verbosity: ${verbosity}, provider: ${lockedProvider}, model: ${lockedTarget})`);

  // Assign job ID and respond immediately
  const jobId = String(++jobCounter);
  // Build a richer label: company + truncated title + expert perspective
  const labelParts = [];
  if (primaryCompany) labelParts.push(primaryCompany);
  if (expertPerspective) labelParts.push(expertPerspective);
  if (!labelParts.length && title) labelParts.push(title.length > 60 ? title.slice(0, 57) + '...' : title);
  const label = `[Expert] ${labelParts.join(' · ') || 'Unknown'}`;
  jobs.set(jobId, { status: 'queued', company: label, quarter: '', year: '' });

  const position = queue.length + activeWorkers;
  if (position > 0) {
    log(`Queued: ${label} (position ${position + 1})`);
  }

  res.json({ success: true, jobId, queued: position > 0 });

  // Process in background
  enqueue(async () => {
    const startTime = Date.now();
    const jobEntry = { company: label, quarter: '', year: '', startTime, jobId };
    activeJobs.push(jobEntry);
    jobs.set(jobId, { status: 'processing', company: label, quarter: '', year: '' });
    log(`Summarizing expert transcript: ${label} [${lockedTarget}]`);

    try {
      let promptTemplate = fs.readFileSync(EXPERT_PROMPT_PATH, 'utf-8');
      promptTemplate = promptTemplate.replace(/Verbosity level:\s*\d+/i, `Verbosity level: ${verbosity}`);
      log(`Job ${jobId}: verbosity=${verbosity} provider=${lockedProvider} model=${lockedTarget}`);
      const fullPrompt = `${promptTemplate}\n\n---\n\nTRANSCRIPT:\n\n${fullTranscript}`;

      log(`Job ${jobId}: prompt size ${fullPrompt.length} chars`);
      const html = await runProcessingPrompt(fullPrompt, {
        provider: lockedProvider,
        model: lockedModel,
        jobId,
        timeoutMs: 300000,
      taskType: 'expert',
      });
      // Validate output
      if (!html || (!html.includes('<!DOCTYPE') && !html.includes('<html'))) {
        throw new Error(`Empty or invalid HTML output (${html.length} chars). First 200: ${html.slice(0, 200)}`);
      }

      // Generate filename from title or company
      const nameSource = primaryCompany || title || 'EXPERT';
      const sanitized = nameSource
        .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
      const datePart = interviewDate ? interviewDate.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') : new Date().toISOString().slice(0, 10);
      const { filename, outputPath } = uniqueFilename(OUTPUT_DIR, `EXPERT-${sanitized}-${datePart}.html`);

      // Determine source abbreviation
      const srcAbbrev = (source || '').toLowerCase().includes('alphasights') ? 'AS' : 'TG';

      // Extract expert role from Claude's generated header metadata line
      // The metadata line typically contains: "Role, Company · TG · 15 Sep 2025"
      // Look for the meta/subtitle span in the header
      let expertDesc = expertPerspective || '';
      // Extract the full text content of the header-meta div, stripping HTML tags
      const metaMatch = html.match(/class="[^"]*meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (metaMatch) {
        const metaText = metaMatch[1].replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
        const parts = metaText.split('·').map(s => s.trim());
        // The role is everything before the source abbreviation
        const roleParts = [];
        for (const p of parts) {
          if (/^(TG|AS|AlphaSense|AlphaSights)$/i.test(p)) break;
          if (/^\d{1,2}\s/.test(p) || /^\d{4}/.test(p) || /unknown/i.test(p)) break;
          roleParts.push(p);
        }
        if (roleParts.length > 0) expertDesc = roleParts.join(' · ');
      }

      // Inject metadata into HTML head
      let finalHtml = html.replace('</head>', `<meta name="summarizer-verbosity" content="${verbosity}">\n<meta name="summarizer-model" content="${lockedTarget}">\n</head>`);

      // Inject bookmark data attributes server-side — strip any Claude-generated data-* attrs first to avoid duplicates
      finalHtml = finalHtml.replace(/(<(?:button|a)[^>]*id="bookmark-btn")[^>]*>/, (match, prefix) => {
        // Strip all existing data-* attributes
        const cleaned = prefix.replace(/\s+data-[a-z-]+="[^"]*"/gi, '');
        // Re-add onclick if it was removed
        const hasOnclick = /onclick/.test(cleaned);
        return `${cleaned} data-source-url="${(sourceUrl || '').replace(/"/g, '&quot;')}" data-interview-date="${(interviewDate || '').replace(/"/g, '&quot;')}" data-source="${srcAbbrev}" data-expert="${(expertDesc || '').replace(/"/g, '&quot;')}"${hasOnclick ? '' : ' onclick="bookmarkTranscript()"'}>`;
      });

      // Inject status link before closing </body>
      const statusLink = `\n<footer style="max-width:90ch;margin:2rem auto 1rem;padding-top:0.75rem;border-top:1px solid #e8e0d4;text-align:right;font-size:0.7rem"><a href="http://localhost:3220/status" style="color:#8b6d4e;text-decoration:none">Summarizer Status ↗</a></footer>\n`;
      finalHtml = finalHtml.replace('</body>', statusLink + '</body>');
      fs.writeFileSync(outputPath, finalHtml, 'utf-8');

      // Extract richer title from Claude's generated HTML for the completed list
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
      const richTitle = titleMatch ? titleMatch[1].replace(/\s*[-–—]\s*.*Summary$/i, '').trim() : '';
      const richLabel = richTitle ? `[Expert] ${richTitle}` : label;
      const completedLabel = expertDesc ? `${richLabel} · ${expertDesc}` : richLabel;

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Saved: ${outputPath} (${totalTime}s) [${queue.length} remaining in queue]`);
      completedJobs.push({ company: completedLabel, quarter: '', year: '', timeSeconds: parseFloat(totalTime), date: new Date().toISOString(), filename });
      try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);

      jobs.set(jobId, { status: 'done', filename, company: completedLabel, quarter: '', year: '', timeSeconds: parseFloat(totalTime) });
    } catch (error) {
      log(`ERROR Expert summarization failed: ${error.message}`);
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);
      jobs.set(jobId, { status: 'error', error: error.message, company: label, quarter: '', year: '' });
    }
  }, label);
});

// Build a raw YouTube body fragment (no Claude) by dumping each scraped
// transcript segment as a timestamped <p>. Used when body.raw === true
// for quick scrape verification.
function buildRawYouTubeBody(body) {
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice() : [];
  chapters.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  const watchUrl = String(body.watchUrl || '');
  const parts = [];
  let chapterIdx = 0;
  for (const seg of transcript) {
    const startMs = Number(seg.startMs) || 0;
    while (chapterIdx < chapters.length && chapters[chapterIdx].startMs <= startMs) {
      const ch = chapters[chapterIdx];
      const startSec = Math.floor((Number(ch.startMs) || 0) / 1000);
      const mmss = yt.formatMmSs(ch.startMs);
      parts.push(
        `<h3 class="chapter"><span>${yt.htmlEscape(ch.title)}</span>` +
        `<a href="${yt.htmlEscape(watchUrl)}&t=${startSec}s">&#x21AA; ${mmss}</a></h3>`
      );
      chapterIdx++;
    }
    const mmss = yt.formatMmSs(startMs);
    const text = yt.htmlEscape(String(seg.text || '').trim());
    if (text) {
      parts.push(`<p><span style="color:#8b6d4e;font-size:0.85em;">[${mmss}]</span> ${text}</p>`);
    }
  }
  return parts.join('\n');
}

// YouTube transcript reader
app.post('/summarize-youtube', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing transcript' });
  }
  if (!body.title || typeof body.title !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing title' });
  }
  if (typeof body.watchUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing watchUrl' });
  }

  const verbosity = Number(body.verbosity) || 180;
  // YouTube transcript cleanup is a mechanical edit task -- Haiku handles
  // it cheaply for typical videos. Two failure modes force a Sonnet upgrade:
  //   1. Very long transcripts (>1800 segments) blow past Haiku's output
  //      budget and get compressed into summary prose instead of verbatim.
  //   2. Chaptered transcripts above ~600 segments overwhelm Haiku's running
  //      bookkeeping of "am I past chapter N's startMs yet?" -- observed: a
  //      1182-segment / 11-chapter video placed half its chapter headings
  //      late, after content whose timestamps were already past them.
  const transcriptLen = Array.isArray(body.transcript) ? body.transcript.length : 0;
  const chapterCount = Array.isArray(body.chapters) ? body.chapters.length : 0;
  const needsSonnet = transcriptLen > 1800 || (chapterCount > 0 && transcriptLen > 600);
  const lockedProvider = normalizeProvider(body.provider || settings.youtubeProvider || 'codex');
  const lockedModel = lockedProvider === 'codex'
    ? resolveCodexModel(body.codexModel || settings.codexModel)
    : (needsSonnet ? 'sonnet' : 'haiku');
  const lockedTarget = processingLabel(lockedProvider, lockedModel);
  const label = `[YT] ${body.title.length > 80 ? body.title.slice(0, 77) + '...' : body.title}`;

  log(`POST /summarize-youtube: "${body.title}" channel=${body.channel || 'none'} ` +
      `(transcript entries: ${body.transcript.length}, verbosity: ${verbosity}, provider: ${lockedProvider}, model: ${lockedTarget})`);

  const jobId = String(++jobCounter);
  jobs.set(jobId, { status: 'queued', company: label, quarter: '', year: '' });

  const position = queue.length + activeWorkers;
  if (position > 0) log(`Queued: ${label} (position ${position + 1})`);

  res.json({ success: true, jobId, queued: position > 0 });

  enqueue(async () => {
    const startTime = Date.now();
    const jobEntry = { company: label, quarter: '', year: '', startTime, jobId };
    activeJobs.push(jobEntry);
    jobs.set(jobId, { status: 'processing', company: label, quarter: '', year: '' });
    log(`Cleaning up YouTube transcript: ${label} [${lockedTarget}]`);

    try {
      let trimmed;
      if (body.raw === true) {
        log(`Job ${jobId}: RAW mode -- skipping model processing, dumping scraped transcript as-is`);
        trimmed = buildRawYouTubeBody(body);
      } else {
        const promptTemplate = fs.readFileSync(PROMPT_YT_PATH, 'utf-8');
        const modelInput = yt.buildClaudeInput(promptTemplate, { ...body, verbosity });
        log(`Job ${jobId}: prompt size ${modelInput.length} chars`);

        // 15min timeout -- long podcast transcripts (100k+ char prompts)
        // routinely need several minutes when there's concurrent load.
        const modelEnv = lockedProvider === 'claude'
          ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' }
          : {};
        const bodyFragment = await runProcessingPrompt(modelInput, {
          provider: lockedProvider,
          model: lockedModel,
          jobId,
          timeoutMs: 900000,
          env: modelEnv,
        taskType: 'youtube',
        });
        // Validate: body fragment must start with <p (new prompt emits
        // only paragraphs; chapter headings are inserted server-side).
        // Accept <h3 too for back-compat if the model ignores the rule.
        trimmed = bodyFragment.trim();
        if (!trimmed || !(trimmed.startsWith('<h3') || trimmed.startsWith('<p'))) {
          throw new Error(`Model returned non-fragment output (${bodyFragment.length} chars). First 300: ${bodyFragment.slice(0, 300)}`);
        }

        // Deterministic placement of chapter headings and question-jump
        // anchors based on the data-t attributes the model emitted on each
        // paragraph. The model is no longer trusted to place these.
        trimmed = yt.insertChapterHeadings(trimmed, body.chapters, body.watchUrl);
        trimmed = yt.addQuestionAnchors(trimmed, body.watchUrl);
      }

      // Reserve the filename before rendering so we can embed it in the
      // HTML (used by the bookmark button to identify this output).
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const { filename, outputPath } = uniqueFilename(OUTPUT_DIR, `yt-${dateStr}-${yt.slugify(body.title)}.html`);

      const meta = {
        title: body.title,
        channel: body.channel || '',
        uploadDate: body.uploadDate || '',
        durationSec: Number(body.durationSec) || 0,
        thumbnailUrl: body.thumbnailUrl || '',
        watchUrl: body.watchUrl,
        filename,
        inlineCss: readStyleCss(),
      };
      const finalHtml = yt.renderYouTubeOutput(meta, trimmed);
      fs.writeFileSync(outputPath, finalHtml, 'utf-8');

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Saved: ${outputPath} (${totalTime}s) [${queue.length} remaining in queue]`);
      completedJobs.push({ company: label, quarter: '', year: '', timeSeconds: parseFloat(totalTime), date: new Date().toISOString(), filename });
      try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);

      jobs.set(jobId, { status: 'done', filename, company: label, quarter: '', year: '', timeSeconds: parseFloat(totalTime) });
    } catch (error) {
      log(`ERROR YouTube cleanup failed: ${error.message}`);
      const idx = activeJobs.findIndex(j => j.jobId === jobId); if (idx >= 0) activeJobs.splice(idx, 1);
      jobs.set(jobId, { status: 'error', error: error.message, company: label, quarter: '', year: '' });
    }
  }, label);
});

// Bookmark toggle
app.post('/bookmark', (req, res) => {
  const { title, url, filename, interviewDate, source, expert } = req.body;
  const idx = bookmarks.findIndex(b => b.filename === filename);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
    res.json({ bookmarked: false });
  } else {
    bookmarks.push({ title, url, filename, date: interviewDate || '', source: source || '', expert: expert || '' });
    try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
    res.json({ bookmarked: true });
  }
});

// Return the full bookmark list as JSON (used by YT output pages to
// check if the current file is already bookmarked on load)
app.get('/bookmarks', (req, res) => {
  res.json(bookmarks);
});

// Publish an output file to the share repo (marginofdanger.github.io/shares)
// and return a public URL. Called from the Share button on YT output pages.
app.post('/share', (req, res) => {
  const filename = (req.body && req.body.filename) || '';
  if (!filename || typeof filename !== 'string' || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }
  const srcPath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(srcPath)) {
    return res.status(404).json({ ok: false, error: 'Output file not found' });
  }
  if (!fs.existsSync(SHARE_REPO_PATH)) {
    return res.status(500).json({ ok: false, error: `Share repo not found at ${SHARE_REPO_PATH}` });
  }

  try {
    const shareDir = path.join(SHARE_REPO_PATH, SHARE_SUBDIR);
    if (!fs.existsSync(shareDir)) fs.mkdirSync(shareDir, { recursive: true });

    // Read source HTML and ensure any localhost-only stylesheets are
    // inlined. Output files link /style.css (YouTube) or
    // /earnings-style.css (earnings calls); replace either link with an
    // embedded <style> block so the shared copy is self-contained.
    let html = fs.readFileSync(srcPath, 'utf-8');
    html = inlineStylesheet(html, '/style.css', readStyleCss());
    html = inlineStylesheet(html, '/earnings-style.css', readEarningsStyleCss());

    const destPath = path.join(shareDir, filename);
    fs.writeFileSync(destPath, html, 'utf-8');

    // Commit and push from the share repo. Use execSync so the client
    // gets a definitive ok/error response; this is a rare manual action
    // so blocking briefly is fine.
    const cwd = SHARE_REPO_PATH;
    const relPath = path.posix.join(SHARE_SUBDIR, filename);
    const { execSync } = require('child_process');
    try {
      execSync(`git add "${relPath}"`, { cwd, stdio: 'pipe' });
      // If nothing changed, git commit will exit non-zero -- detect and
      // treat as a no-op success (file already shared identically).
      try {
        execSync(`git commit -m "share: ${filename}"`, { cwd, stdio: 'pipe' });
      } catch (e) {
        const msg = (e && e.stderr && e.stderr.toString()) || (e && e.stdout && e.stdout.toString()) || '';
        if (!/nothing to commit/i.test(msg)) throw e;
      }
      execSync('git push origin HEAD', { cwd, stdio: 'pipe', timeout: 60000 });
    } catch (gitErr) {
      const detail = (gitErr && gitErr.stderr && gitErr.stderr.toString())
        || (gitErr && gitErr.message) || String(gitErr);
      log(`Share git error for ${filename}: ${detail.slice(0, 500)}`);
      return res.status(500).json({ ok: false, error: `git push failed: ${detail.slice(0, 200)}` });
    }

    const url = `${SHARE_BASE_URL}/${encodeURIComponent(filename)}`;
    log(`Shared ${filename} -> ${url}`);
    res.json({ ok: true, url });
  } catch (e) {
    log(`Share error for ${filename}: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Remove bookmark via GET (for status page links)
app.get('/bookmark/remove', (req, res) => {
  const filename = req.query.filename;
  const idx = bookmarks.findIndex(b => b.filename === filename);
  if (idx >= 0) bookmarks.splice(idx, 1);
  try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
  res.redirect('/status');
});

// Settings storage
let settings = { ecVerbosity: 60, exVerbosity: 30, concurrency: 3, provider: 'claude', youtubeProvider: 'codex', model: 'opus', codexModel: DEFAULT_CODEX_MODEL, shadowOpusForCodex: false };
const SETTINGS_PATH = path.resolve(__dirname, 'settings.json');
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) }; } catch (e) {}
settings.provider = normalizeProvider(settings.provider);
settings.youtubeProvider = normalizeProvider(settings.youtubeProvider || 'codex');
settings.codexModel = resolveCodexModel(settings.codexModel);
maxConcurrency = settings.concurrency || 3;

app.get('/settings', (req, res) => {
  res.json(settings);
});

app.post('/settings', (req, res) => {
  if (req.body.ecVerbosity != null) settings.ecVerbosity = Math.max(10, Math.min(200, parseInt(req.body.ecVerbosity)));
  if (req.body.exVerbosity != null) settings.exVerbosity = Math.max(10, Math.min(200, parseInt(req.body.exVerbosity)));
  if (req.body.concurrency != null) {
    settings.concurrency = Math.max(1, Math.min(10, parseInt(req.body.concurrency)));
    maxConcurrency = settings.concurrency;
    processQueue();
  }
  if (req.body.provider) settings.provider = normalizeProvider(req.body.provider);
  if (req.body.youtubeProvider) settings.youtubeProvider = normalizeProvider(req.body.youtubeProvider);
  if (req.body.model) settings.model = req.body.model;
  if (req.body.codexModel != null) settings.codexModel = resolveCodexModel(req.body.codexModel);
  if (req.body.shadowOpusForCodex != null) settings.shadowOpusForCodex = !!req.body.shadowOpusForCodex;
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch (e) {}
  log(`Settings updated: ${JSON.stringify(settings)}`);
  res.json(settings);
});

app.listen(PORT, () => {
  log(`OC-Reader server running at http://localhost:${PORT} (EC/expert: ${settings.provider}, YouTube: ${settings.youtubeProvider}, concurrency: ${maxConcurrency})`);
});










