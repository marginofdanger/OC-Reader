// Pure helpers for the YouTube transcript reader endpoint.
// No fs, no network, no express — everything here must be unit-testable.

function htmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(s) {
  if (s == null) return 'untitled';
  const cleaned = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'untitled';
  if (cleaned.length <= 60) return cleaned;
  // Truncate at 60 then back off to the last hyphen so we don't cut a word in half.
  let truncated = cleaned.slice(0, 60);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > 30) truncated = truncated.slice(0, lastHyphen);
  return truncated.replace(/-+$/g, '');
}

function formatDuration(secondsLike) {
  const total = Math.max(0, Math.floor(Number(secondsLike) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatUploadDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function isEnglish(code) {
  if (!code) return false;
  const lower = String(code).toLowerCase();
  return lower === 'en' || lower.startsWith('en-');
}

function resolveCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const englishTracks = tracks.filter(t => t && isEnglish(t.languageCode));
  if (englishTracks.length === 0) return null;
  const human = englishTracks.find(t => t.kind !== 'asr');
  return human || englishTracks[0];
}

function formatMmSs(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function extractRunsText(titleField) {
  if (!titleField) return null;
  if (typeof titleField.simpleText === 'string') return titleField.simpleText;
  if (Array.isArray(titleField.runs)) {
    return titleField.runs.map(r => (r && r.text) || '').join('');
  }
  return null;
}

function normalizeChapters(rawChapters) {
  if (!Array.isArray(rawChapters)) return [];
  const out = [];
  for (const entry of rawChapters) {
    const r = entry && entry.chapterRenderer;
    if (!r) continue;
    const title = extractRunsText(r.title);
    const startMs = Number(r.timeRangeStartMillis);
    if (title && Number.isFinite(startMs)) {
      out.push({ title, startMs });
    }
  }
  return out;
}

function buildClaudeInput(prompt, payload) {
  const meta = {
    title: payload.title || '',
    channel: payload.channel || '',
    uploadDate: payload.uploadDate || '',
    durationSec: Number(payload.durationSec) || 0,
    watchUrl: payload.watchUrl || '',
    chapters: Array.isArray(payload.chapters) ? payload.chapters : [],
    verbosity: Number(payload.verbosity) || 180,
  };
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const lines = transcript.map(entry => `[${formatMmSs(entry.startMs)}] ${entry.text}`);
  return [
    prompt,
    '',
    'METADATA:',
    JSON.stringify(meta, null, 2),
    '',
    'TRANSCRIPT:',
    lines.join('\n'),
  ].join('\n');
}

function renderYouTubeOutput(meta, bodyFragment) {
  const title = htmlEscape(meta.title);
  const channel = htmlEscape(meta.channel);
  const watchUrl = htmlEscape(meta.watchUrl);
  const thumbnailUrl = htmlEscape(meta.thumbnailUrl);
  const duration = htmlEscape(formatDuration(meta.durationSec));
  const uploadDate = htmlEscape(formatUploadDate(meta.uploadDate));
  const filename = htmlEscape(meta.filename || '');
  const rawUploadDate = htmlEscape(meta.uploadDate || '');
  // If meta.inlineCss is provided, embed the stylesheet directly so the
  // output file is self-contained (safe to share / host anywhere).
  // Otherwise fall back to linking /style.css on the local server.
  const styleTag = meta.inlineCss
    ? `<style>\n${meta.inlineCss}\n</style>`
    : `<link rel="stylesheet" href="/style.css">`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  ${styleTag}
</head>
<body>
  <header>
    <div class="header-inner yt">
      <div class="header-title yt">
        <a class="yt-header-thumb" href="${watchUrl}" target="_blank"><img src="${thumbnailUrl}" alt=""></a>
        <div class="yt-header-text">
          <strong>${title}</strong>
          <div class="yt-header-sub">
            <span class="yt-channel">${channel}</span>
            <span class="yt-sep">&middot;</span>
            <span class="yt-date">${uploadDate}</span>
            <span class="yt-sep">&middot;</span>
            <span class="yt-dur">${duration}</span>
          </div>
        </div>
      </div>
      <div class="yt-header-actions">
        <button id="yt-bookmark-btn"
                class="yt-bookmark-btn"
                title="Bookmark"
                aria-label="Bookmark"
                data-filename="${filename}"
                data-title="${title}"
                data-url="${watchUrl}"
                data-date="${rawUploadDate}"
                data-channel="${channel}"
                onclick="toggleYtBookmark(this)">&#9734;</button>
        <button id="yt-share-btn"
                class="yt-share-btn"
                title="Share"
                aria-label="Share"
                data-filename="${filename}"
                onclick="shareYtPage(this)">&#8599;</button>
        <a class="header-link" href="${watchUrl}" target="_blank" title="Watch on YouTube" aria-label="Watch on YouTube">YT</a>
      </div>
    </div>
  </header>
  <main>
    <div class="yt-body">
    ${bodyFragment}
    </div>
  </main>
  <script>
  async function toggleYtBookmark(btn) {
    const payload = {
      title: btn.dataset.title,
      url: btn.dataset.url,
      filename: btn.dataset.filename,
      interviewDate: btn.dataset.date,
      source: 'YT',
      expert: btn.dataset.channel,
    };
    try {
      const resp = await fetch('/bookmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await resp.json();
      setYtBookmarkState(btn, !!result.bookmarked);
    } catch (e) {
      console.error('Bookmark toggle failed:', e);
    }
  }
  function setYtBookmarkState(btn, on) {
    btn.classList.toggle('is-bookmarked', on);
    btn.innerHTML = on ? '&#9733;' : '&#9734;';
    btn.title = on ? 'Bookmarked' : 'Bookmark';
    btn.setAttribute('aria-label', on ? 'Bookmarked' : 'Bookmark');
  }
  (async function initYtBookmarkState() {
    const btn = document.getElementById('yt-bookmark-btn');
    if (!btn || !btn.dataset.filename) return;
    try {
      const resp = await fetch('/bookmarks');
      if (!resp.ok) return;
      const list = await resp.json();
      if (Array.isArray(list) && list.some(b => b && b.filename === btn.dataset.filename)) {
        setYtBookmarkState(btn, true);
      }
    } catch (e) { /* offline -- leave default state */ }
  })();

  async function shareYtPage(btn) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '&hellip;';
    try {
      const resp = await fetch('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: btn.dataset.filename }),
      });
      const result = await resp.json();
      if (!result.ok) throw new Error(result.error || 'Share failed');
      try { await navigator.clipboard.writeText(result.url); } catch (e) {}
      btn.innerHTML = '&#10003;';
      btn.title = 'Copied ' + result.url;
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 2500);
    } catch (e) {
      console.error('Share failed:', e);
      btn.innerHTML = '!';
      btn.title = 'Share failed: ' + (e && e.message || e);
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.title = 'Share'; }, 3000);
    }
  }

  // When the page is viewed from somewhere other than the local Reader
  // server (e.g. a shared copy on GitHub Pages), hide the interactive
  // buttons whose endpoints only exist on localhost.
  (function hideLocalOnlyControls() {
    const host = location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    if (isLocal) return;
    const actions = document.querySelector('.yt-header-actions');
    if (!actions) return;
    const bookmark = actions.querySelector('#yt-bookmark-btn');
    const share = actions.querySelector('#yt-share-btn');
    if (bookmark) bookmark.remove();
    if (share) share.remove();
  })();
  </script>
</body>
</html>
`;
}

// Insert <h3 class="chapter"> headings into the body fragment based on the
// data-t attributes emitted by the model. Chapter placement used to be the
// model's job; Haiku got it wrong on dense-chapter transcripts (headings
// dumped in a batch at the end). Doing it here is deterministic.
function insertChapterHeadings(bodyFragment, chapters, watchUrl) {
  if (!Array.isArray(chapters) || chapters.length === 0) return bodyFragment;
  const paraRegex = /<p\b[^>]*\bdata-t\s*=\s*"(\d+)"[^>]*>/g;
  const paras = [];
  let m;
  while ((m = paraRegex.exec(bodyFragment)) !== null) {
    paras.push({ startSec: Number(m[1]), pos: m.index });
  }
  if (paras.length === 0) return bodyFragment;

  const sorted = [...chapters]
    .filter(c => c && Number.isFinite(Number(c.startMs)))
    .sort((a, b) => Number(a.startMs) - Number(b.startMs));

  const inserts = [];
  let paraIdx = 0;
  for (const ch of sorted) {
    const targetMs = Number(ch.startMs);
    while (paraIdx < paras.length && paras[paraIdx].startSec * 1000 < targetMs) paraIdx++;
    const pos = paraIdx < paras.length ? paras[paraIdx].pos : bodyFragment.length;
    const ns = Math.floor(targetMs / 1000);
    const mmss = formatMmSs(targetMs);
    const title = htmlEscape(ch.title || '');
    const url = htmlEscape(watchUrl || '');
    inserts.push({
      pos,
      heading: `<h3 class="chapter"><span>${title}</span><a href="${url}&t=${ns}s">&#x21AA; ${mmss}</a></h3>\n`,
    });
  }

  // Apply from the end back to preserve earlier indices. `inserts` is in
  // non-decreasing pos order; reverse iteration also preserves within-pos
  // chapter ordering (earliest chapter ends up topmost after all splices).
  let out = bodyFragment;
  for (let i = inserts.length - 1; i >= 0; i--) {
    out = out.slice(0, inserts[i].pos) + inserts[i].heading + out.slice(inserts[i].pos);
  }
  return out;
}

// Append a right-aligned timestamp anchor to every <p class="q"> based on
// its data-t attribute. Decouples the model from link formatting.
function addQuestionAnchors(bodyFragment, watchUrl) {
  const url = htmlEscape(watchUrl || '');
  return bodyFragment.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/g, (full, attrs, inner) => {
    if (!/\bclass\s*=\s*"q"/.test(attrs)) return full;
    const t = attrs.match(/\bdata-t\s*=\s*"(\d+)"/);
    if (!t) return full;
    const sec = Number(t[1]);
    const mmss = formatMmSs(sec * 1000);
    return `<p${attrs}>${inner}<a href="${url}&t=${sec}s">&#x21AA; ${mmss}</a></p>`;
  });
}

module.exports = {
  htmlEscape, slugify, formatDuration, formatUploadDate,
  resolveCaptionTrack, formatMmSs, normalizeChapters, buildClaudeInput,
  renderYouTubeOutput, insertChapterHeadings, addQuestionAnchors,
};
