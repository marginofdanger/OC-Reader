# YouTube Transcript Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Reader extension/server to capture YouTube watch-page transcripts, clean them to near-verbatim reading copy via Claude, and render them in the existing Reader visual style with an optional chapter-based navigation header.

**Architecture:** A new content script reads YouTube's embedded `ytInitialPlayerResponse` / `ytInitialData` globals, fetches the `timedtext` caption JSON, and POSTs a normalized payload to a new `/summarize-youtube` Express endpoint. The server runs the payload through a YouTube-specific Claude prompt (cleanup only, never summarize) and wraps the resulting HTML body fragment in the existing Reader output shell plus a new thumbnail metadata card. All job queuing, alarm polling, bookmarking, history, badge behavior, and output routing are reused from the existing pipeline with zero modification.

**Tech Stack:** Chrome Extension (Manifest V3, MV3 service worker, content scripts), Node.js + Express (existing `server.js`), Claude CLI (existing spawn pattern), native `node:test` runner for unit tests (no new dependencies).

**Design spec:** `docs/superpowers/specs/2026-04-13-youtube-transcript-reader-design.md`

**Preconditions / notes for the implementer:**

- **The Reader repo currently has pre-existing uncommitted changes** in `extension/background.js`, `extension/content-expert.js`, `server/prompt-expert.txt`, and `server/server.js`, plus untracked files (`.superpowers/`, `docs/`, `extension/content-expert-meta.js`, `server/claude_test_stderr.txt`, `server/settings.json`, `stderr.tmp`). **Do not stage any of those in your commits.** Every `git add` step below names exact files.
- **All code lives in `C:\Users\AdrianOw\Projects\Reader\`**, not `C:\Users\AdrianOw\Projects\YouTube\` (which is this session's working directory but is otherwise empty).
- The project has no test framework today. Task 1 adds a minimal `node:test` script entry so later tasks can TDD pure helpers. Integration/browser paths are verified manually — those steps are explicit about what to check.
- **Windows shell note:** the user runs `bash` on Windows 11. Use forward slashes in paths. Use `node --test` which works identically on Windows.
- **YouTube testing caveats:** YouTube occasionally ships DOM/JSON changes. If you get a structural error during manual testing, read the error payload from the badge, check the actual shape of `ytInitialPlayerResponse` in DevTools, and adjust the accessor rather than guessing.

---

## File Structure

**New files (create):**

- `Reader/server/youtube-helpers.js` — all pure server-side helpers (caption track resolver, metadata normalizer, chapter normalizer, duration/date formatters, slug, HTML escape, Claude input builder, output HTML renderer). Pure functions only — no fs, no network, no express.
- `Reader/server/youtube-helpers.test.js` — `node:test` unit tests for every helper in `youtube-helpers.js`.
- `Reader/server/prompt-youtube.txt` — Claude system prompt. Instructs cleanup-only behavior, chapter rules, verbosity semantics.
- `Reader/extension/content-youtube.js` — content script. Injects a bridge `<script>` that reads the page globals, receives them via `postMessage`, fetches the caption JSON, normalizes, and posts the payload to the background.

**Modified files:**

- `Reader/extension/manifest.json` — add two host permissions.
- `Reader/extension/background.js` — add one entry to `SITE_PATTERNS`, add one branch to the `onMessage` listener.
- `Reader/extension/popup.html` — add one `.setting` block (slider).
- `Reader/extension/popup.js` — add load/save wiring for `ytVerbosity`.
- `Reader/server/server.js` — add `POST /summarize-youtube` route and one branch in the job worker for `type === 'youtube'`.
- `Reader/server/style.css` — append the `.yt-meta-card*` and `h3.chapter` classes.
- `Reader/server/package.json` — add `"test": "node --test *.test.js"` script.

Each task produces a self-contained, committable change.

---

### Task 1: Add node:test runner wiring

**Files:**
- Modify: `Reader/server/package.json`

- [ ] **Step 1: Open `Reader/server/package.json` and add a test script**

The file currently has:

```json
{
  "name": "bamsec-summarizer-server",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
```

Change `scripts` to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test *.test.js"
  },
```

- [ ] **Step 2: Verify the test runner works with no tests present**

Run from `Reader/server/`:

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && npm test
```

Expected: exits with a message like `# tests 0` or similar (may warn about glob with no matches — that's fine, we just need the script to exist). If it errors on the shell glob, you can ignore this step — Task 2 will create the first test file which validates the runner end-to-end.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/package.json && git commit -m "$(cat <<'EOF'
chore(server): add node:test script for unit tests

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure helpers — HTML escape, slug, duration formatter, upload date formatter

**Files:**
- Create: `Reader/server/youtube-helpers.js`
- Create: `Reader/server/youtube-helpers.test.js`

- [ ] **Step 1: Write the failing tests**

Create `Reader/server/youtube-helpers.test.js` with:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  htmlEscape,
  slugify,
  formatDuration,
  formatUploadDate,
} = require('./youtube-helpers');

test('htmlEscape escapes the five basic characters', () => {
  assert.equal(htmlEscape('<p>"a" & \'b\'</p>'), '&lt;p&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/p&gt;');
});

test('htmlEscape passes through plain text', () => {
  assert.equal(htmlEscape('hello world'), 'hello world');
});

test('htmlEscape handles empty string and non-string inputs gracefully', () => {
  assert.equal(htmlEscape(''), '');
  assert.equal(htmlEscape(null), '');
  assert.equal(htmlEscape(undefined), '');
});

test('slugify lowercases and replaces non-alphanumerics with hyphens', () => {
  assert.equal(slugify('The GPU Economics of Frontier Labs'), 'the-gpu-economics-of-frontier-labs');
});

test('slugify collapses runs of separators and trims edges', () => {
  assert.equal(slugify('  Hello!!  World??  '), 'hello-world');
});

test('slugify truncates to 60 characters at a word boundary', () => {
  const long = 'this is a very long title that keeps going and going past sixty characters easily';
  const result = slugify(long);
  assert.ok(result.length <= 60, `expected ≤60, got ${result.length}: ${result}`);
  assert.ok(!result.endsWith('-'), 'should not end with a hyphen');
});

test('slugify returns "untitled" for empty or symbol-only input', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(slugify(null), 'untitled');
});

test('formatDuration under one hour shows minutes only', () => {
  assert.equal(formatDuration(42 * 60), '42m');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59), '0m');
  assert.equal(formatDuration(60), '1m');
});

test('formatDuration one hour or more shows hours and minutes', () => {
  assert.equal(formatDuration(3600), '1h 0m');
  assert.equal(formatDuration(3600 + 47 * 60), '1h 47m');
  assert.equal(formatDuration(2 * 3600 + 5 * 60), '2h 5m');
});

test('formatDuration accepts numeric string input (YT returns strings)', () => {
  assert.equal(formatDuration('6420'), '1h 47m');
});

test('formatUploadDate renders ISO YYYY-MM-DD as "Mon D, YYYY"', () => {
  assert.equal(formatUploadDate('2026-04-02'), 'Apr 2, 2026');
  assert.equal(formatUploadDate('2025-12-31'), 'Dec 31, 2025');
});

test('formatUploadDate handles full ISO datetime strings', () => {
  assert.equal(formatUploadDate('2026-04-02T12:34:56Z'), 'Apr 2, 2026');
});

test('formatUploadDate returns empty string on invalid input', () => {
  assert.equal(formatUploadDate(''), '');
  assert.equal(formatUploadDate('not-a-date'), '');
  assert.equal(formatUploadDate(null), '');
});
```

- [ ] **Step 2: Run the test file and verify it fails because the module does not exist**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: fails with `Cannot find module './youtube-helpers'`.

- [ ] **Step 3: Create `Reader/server/youtube-helpers.js` with the four helpers**

```js
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

module.exports = { htmlEscape, slugify, formatDuration, formatUploadDate };
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: all 13 tests pass. If `slugify` truncation fails, re-check that the long string actually exceeds 60 chars and that the `lastIndexOf('-')` branch kicks in.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/youtube-helpers.js server/youtube-helpers.test.js && git commit -m "$(cat <<'EOF'
feat(server): add pure YouTube helper primitives

htmlEscape, slugify, formatDuration, formatUploadDate with unit tests.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Pure helper — caption track resolver

**Files:**
- Modify: `Reader/server/youtube-helpers.js`
- Modify: `Reader/server/youtube-helpers.test.js`

- [ ] **Step 1: Add failing tests for `resolveCaptionTrack`**

Append to `Reader/server/youtube-helpers.test.js`:

```js
const { resolveCaptionTrack } = require('./youtube-helpers');

const track = (languageCode, kind, baseUrl) => ({ languageCode, kind, baseUrl });

test('resolveCaptionTrack prefers human English over auto English', () => {
  const tracks = [
    track('en', 'asr', 'auto-en'),
    track('en', undefined, 'human-en'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'human-en');
});

test('resolveCaptionTrack falls back to auto English if no human English', () => {
  const tracks = [
    track('en', 'asr', 'auto-en'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'auto-en');
});

test('resolveCaptionTrack returns null when no English track exists', () => {
  const tracks = [
    track('es', undefined, 'human-es'),
    track('fr', 'asr', 'auto-fr'),
  ];
  assert.equal(resolveCaptionTrack(tracks), null);
});

test('resolveCaptionTrack returns null on null/empty input', () => {
  assert.equal(resolveCaptionTrack(null), null);
  assert.equal(resolveCaptionTrack([]), null);
});

test('resolveCaptionTrack treats en-US, en-GB as English', () => {
  const tracks = [
    track('en-GB', undefined, 'human-gb'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'human-gb');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: the 5 new tests fail with `resolveCaptionTrack is not a function`.

- [ ] **Step 3: Implement `resolveCaptionTrack` in `youtube-helpers.js`**

Add to `Reader/server/youtube-helpers.js` above `module.exports`:

```js
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
```

Update the export:

```js
module.exports = { htmlEscape, slugify, formatDuration, formatUploadDate, resolveCaptionTrack };
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: all 18 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/youtube-helpers.js server/youtube-helpers.test.js && git commit -m "$(cat <<'EOF'
feat(server): add resolveCaptionTrack helper

Prefers human English captions over auto-generated, returns null when
no English track is available.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Pure helper — chapter normalizer and transcript line formatter

**Files:**
- Modify: `Reader/server/youtube-helpers.js`
- Modify: `Reader/server/youtube-helpers.test.js`

- [ ] **Step 1: Add failing tests for `formatMmSs` and `normalizeChapters`**

Append to `Reader/server/youtube-helpers.test.js`:

```js
const { formatMmSs, normalizeChapters } = require('./youtube-helpers');

test('formatMmSs under one hour', () => {
  assert.equal(formatMmSs(0), '00:00');
  assert.equal(formatMmSs(59 * 1000), '00:59');
  assert.equal(formatMmSs(90 * 1000), '01:30');
});

test('formatMmSs one hour or more uses h:mm:ss', () => {
  assert.equal(formatMmSs(3600 * 1000), '1:00:00');
  assert.equal(formatMmSs((3600 + 23 * 60 + 14) * 1000), '1:23:14');
});

test('normalizeChapters extracts title+startMs from YT chapter shape', () => {
  const raw = [
    { chapterRenderer: { title: { simpleText: 'Intro' }, timeRangeStartMillis: 0 } },
    { chapterRenderer: { title: { simpleText: 'Deep dive' }, timeRangeStartMillis: 123000 } },
  ];
  assert.deepEqual(normalizeChapters(raw), [
    { title: 'Intro', startMs: 0 },
    { title: 'Deep dive', startMs: 123000 },
  ]);
});

test('normalizeChapters handles the runs-based title shape', () => {
  const raw = [
    { chapterRenderer: { title: { runs: [{ text: 'Part ' }, { text: 'one' }] }, timeRangeStartMillis: 0 } },
  ];
  assert.deepEqual(normalizeChapters(raw), [{ title: 'Part one', startMs: 0 }]);
});

test('normalizeChapters returns empty array for null/undefined/empty', () => {
  assert.deepEqual(normalizeChapters(null), []);
  assert.deepEqual(normalizeChapters(undefined), []);
  assert.deepEqual(normalizeChapters([]), []);
});

test('normalizeChapters skips malformed entries', () => {
  const raw = [
    { chapterRenderer: { title: { simpleText: 'Good' }, timeRangeStartMillis: 0 } },
    { notAChapter: true },
    { chapterRenderer: { title: null, timeRangeStartMillis: 5000 } },
  ];
  assert.deepEqual(normalizeChapters(raw), [{ title: 'Good', startMs: 0 }]);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: the 6 new tests fail with "is not a function".

- [ ] **Step 3: Implement `formatMmSs` and `normalizeChapters`**

Add to `Reader/server/youtube-helpers.js` above `module.exports`:

```js
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
```

Update exports:

```js
module.exports = {
  htmlEscape, slugify, formatDuration, formatUploadDate,
  resolveCaptionTrack, formatMmSs, normalizeChapters,
};
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: all 24 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/youtube-helpers.js server/youtube-helpers.test.js && git commit -m "$(cat <<'EOF'
feat(server): add formatMmSs and normalizeChapters helpers

Normalizes YouTube's nested chapterRenderer shape (supporting both
simpleText and runs title formats) into {title, startMs} pairs, and
formats ms into mm:ss or h:mm:ss.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pure helper — Claude CLI input builder

**Files:**
- Modify: `Reader/server/youtube-helpers.js`
- Modify: `Reader/server/youtube-helpers.test.js`

- [ ] **Step 1: Add failing tests for `buildClaudeInput`**

Append to `Reader/server/youtube-helpers.test.js`:

```js
const { buildClaudeInput } = require('./youtube-helpers');

test('buildClaudeInput includes the prompt followed by a JSON metadata block', () => {
  const prompt = 'You are a transcript editor.';
  const payload = {
    title: 'T', channel: 'C', uploadDate: '2026-04-02', durationSec: 600,
    watchUrl: 'https://youtube.com/watch?v=x',
    chapters: [{ title: 'Intro', startMs: 0 }],
    transcript: [{ startMs: 0, text: 'hello world' }, { startMs: 3500, text: 'again' }],
    verbosity: 180,
  };
  const out = buildClaudeInput(prompt, payload);
  assert.ok(out.startsWith('You are a transcript editor.'));
  assert.ok(out.includes('"title": "T"'));
  assert.ok(out.includes('"verbosity": 180'));
});

test('buildClaudeInput formats transcript lines with [mm:ss] prefix', () => {
  const payload = {
    title: 'T', channel: 'C', uploadDate: '', durationSec: 0, watchUrl: '',
    chapters: [],
    transcript: [
      { startMs: 0, text: 'hello' },
      { startMs: 90000, text: 'minute and a half in' },
    ],
    verbosity: 180,
  };
  const out = buildClaudeInput('PROMPT', payload);
  assert.ok(out.includes('[00:00] hello'));
  assert.ok(out.includes('[01:30] minute and a half in'));
});

test('buildClaudeInput handles empty chapters and transcript arrays', () => {
  const out = buildClaudeInput('P', {
    title: '', channel: '', uploadDate: '', durationSec: 0, watchUrl: '',
    chapters: [], transcript: [], verbosity: 100,
  });
  assert.ok(out.includes('"chapters": []'));
  assert.ok(out.includes('TRANSCRIPT:'));
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: 3 new tests fail.

- [ ] **Step 3: Implement `buildClaudeInput`**

Add to `Reader/server/youtube-helpers.js`:

```js
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
```

Update exports to include `buildClaudeInput`.

- [ ] **Step 4: Run tests, verify all pass**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: 27 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/youtube-helpers.js server/youtube-helpers.test.js && git commit -m "$(cat <<'EOF'
feat(server): add buildClaudeInput helper

Assembles the YT cleanup prompt input: prompt + metadata JSON block +
transcript lines formatted as [mm:ss] text.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Pure helper — output HTML renderer

**Files:**
- Modify: `Reader/server/youtube-helpers.js`
- Modify: `Reader/server/youtube-helpers.test.js`

- [ ] **Step 1: Add failing tests for `renderYouTubeOutput`**

Append to `Reader/server/youtube-helpers.test.js`:

```js
const { renderYouTubeOutput } = require('./youtube-helpers');

const sampleMeta = {
  title: 'The GPU Economics of Frontier Labs',
  channel: 'Dwarkesh Podcast',
  uploadDate: '2026-04-02',
  durationSec: 6420,
  thumbnailUrl: 'https://i.ytimg.com/vi/abc/maxres.jpg',
  watchUrl: 'https://www.youtube.com/watch?v=abc',
};

test('renderYouTubeOutput produces a full HTML document', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p>hello</p>');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/style.css">'));
  assert.ok(html.includes('</html>'));
});

test('renderYouTubeOutput interpolates title, channel, duration, url', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p>x</p>');
  assert.ok(html.includes('The GPU Economics of Frontier Labs'));
  assert.ok(html.includes('Dwarkesh Podcast'));
  assert.ok(html.includes('1h 47m'));
  assert.ok(html.includes('Apr 2, 2026'));
  assert.ok(html.includes('https://www.youtube.com/watch?v=abc'));
  assert.ok(html.includes('https://i.ytimg.com/vi/abc/maxres.jpg'));
});

test('renderYouTubeOutput HTML-escapes metadata fields but not the body fragment', () => {
  const meta = { ...sampleMeta, title: 'A & B <c>', channel: '"quoted"' };
  const body = '<p>raw &amp; already-escaped</p>';
  const html = renderYouTubeOutput(meta, body);
  assert.ok(html.includes('A &amp; B &lt;c&gt;'));
  assert.ok(html.includes('&quot;quoted&quot;'));
  assert.ok(html.includes('<p>raw &amp; already-escaped</p>'));
});

test('renderYouTubeOutput includes the body fragment inside <main>', () => {
  const html = renderYouTubeOutput(sampleMeta, '<h3 class="chapter">X</h3><p>y</p>');
  const mainOpen = html.indexOf('<main>');
  const mainClose = html.indexOf('</main>');
  const between = html.slice(mainOpen, mainClose);
  assert.ok(between.includes('<h3 class="chapter">X</h3>'));
  assert.ok(between.includes('<p>y</p>'));
  assert.ok(between.includes('yt-meta-card'));
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: 4 new tests fail.

- [ ] **Step 3: Implement `renderYouTubeOutput`**

Add to `Reader/server/youtube-helpers.js`:

```js
function renderYouTubeOutput(meta, bodyFragment) {
  const title = htmlEscape(meta.title);
  const channel = htmlEscape(meta.channel);
  const watchUrl = htmlEscape(meta.watchUrl);
  const thumbnailUrl = htmlEscape(meta.thumbnailUrl);
  const duration = htmlEscape(formatDuration(meta.durationSec));
  const uploadDate = htmlEscape(formatUploadDate(meta.uploadDate));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="header-title"><strong>${title}</strong> &nbsp; ${channel}</div>
      <a class="header-link" href="${watchUrl}" target="_blank">Watch on YouTube</a>
    </div>
  </header>
  <main>
    <div class="yt-meta-card">
      <a href="${watchUrl}" target="_blank"><img src="${thumbnailUrl}" alt=""></a>
      <div class="yt-meta-body">
        <div class="yt-meta-title">${title}</div>
        <div class="yt-meta-sub">${channel} · ${uploadDate} · ${duration}</div>
        <div class="yt-meta-url">${watchUrl}</div>
      </div>
    </div>
    ${bodyFragment}
  </main>
</body>
</html>
`;
}
```

Update exports to include `renderYouTubeOutput`.

- [ ] **Step 4: Run tests, verify all pass**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: 31 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/youtube-helpers.js server/youtube-helpers.test.js && git commit -m "$(cat <<'EOF'
feat(server): add renderYouTubeOutput HTML shell renderer

Wraps Claude's body fragment in the existing Reader output shell plus a
new thumbnail metadata card. All metadata is HTML-escaped; the body
fragment is inserted as-is.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Write the Claude cleanup prompt

**Files:**
- Create: `Reader/server/prompt-youtube.txt`

- [ ] **Step 1: Create `Reader/server/prompt-youtube.txt`**

```
You are a transcript editor, not a summarizer. Your job is to convert a raw
YouTube caption stream into clean, readable prose while preserving what the
speaker said as closely as possible.

YOU WILL RECEIVE:
- METADATA: a JSON block with title, channel, uploadDate, durationSec, watchUrl,
  a chapters array, and a verbosity value.
- TRANSCRIPT: a sequence of lines formatted as "[mm:ss] text", one per caption
  event.

WHAT TO DO:
1. Add punctuation and capitalization. Turn caption fragments into real
   sentences.
2. Break into paragraphs at natural pause points. A gap of several seconds
   between consecutive [mm:ss] timestamps is usually a paragraph break. So is
   a clear topic shift.
3. Remove filler: "um", "uh", "like" used as filler, "you know" used as filler,
   "I mean" used as filler, and false starts (e.g. "I think — I mean I
   thought").
4. Emit the result as a sequence of <p> elements. Use no other wrappers.

WHAT NOT TO DO:
- Do not summarize. Do not compress. Verbatim is the default.
- Do not invent section headings. The only headings allowed are chapter
  headings from the chapters array (see below).
- Do not paraphrase or editorialize.
- Do not add commentary, framing, or meta-description of the video.
- Do not output <html>, <head>, <body>, <main>, or any wrapper div. Only
  <h3 class="chapter"> and <p> elements at the top level.
- Do not use markdown.

CHAPTERS:
If the chapters array is non-empty, insert an <h3 class="chapter"> at each
chapter boundary, immediately BEFORE the first paragraph whose first
[mm:ss] timestamp is at or after the chapter's startMs. The heading must
have this exact structure:

  <h3 class="chapter"><span>CHAPTER_TITLE</span><a href="WATCH_URL&t=Ns">↪ MM:SS</a></h3>

where:
- CHAPTER_TITLE is the chapter's title (HTML-escape &, <, >).
- WATCH_URL is the metadata watchUrl value.
- N is floor(startMs / 1000) — the start time in whole seconds.
- MM:SS is the chapter start rendered as mm:ss (or h:mm:ss for chapters past
  one hour).

If the chapters array is EMPTY, emit NO headings at all. Just paragraphs.

VERBOSITY:
The verbosity value is a knob on how aggressively to trim filler and
redundancy — never a knob on content:
- 200: strip only pure filler words (um, uh).
- 180 (default): also remove false starts and verbal tics (you know, I mean,
  like used as filler).
- 100: also tighten obvious redundancy while preserving meaning and wording.
- 10: very tight, still no invented structure, still no summarization.

Verbosity never authorizes summarization, rephrasing, or invented structure.

OUTPUT:
Emit only the HTML body fragment. The first byte of your output must be
either `<h3` (if chapters exist) or `<p`. Do not include any preamble,
explanation, or closing remark.
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/prompt-youtube.txt && git commit -m "$(cat <<'EOF'
feat(server): add Claude cleanup prompt for YouTube transcripts

Cleanup-only, never summarize; chapter-aware headings with jump links;
verbosity controls trimming aggressiveness only.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add `/summarize-youtube` route and worker

**Files:**
- Modify: `Reader/server/server.js`

The existing `/summarize` and `/summarize-expert` endpoints inline their Claude CLI spawn logic rather than factoring a helper — this task inlines the same pattern for YouTube. Key details already confirmed by reading `server.js`:

- `jobId` is a **string**: `String(++jobCounter)`.
- Claude CLI invocation: `spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', lockedModel], { stdio: ['pipe','pipe','pipe'], timeout: 300000 })`.
- The existing endpoints expect Claude to emit a full `<!DOCTYPE html>` document; for YouTube we skip that validation because our prompt asks for a body fragment only, and we wrap it via `yt.renderYouTubeOutput`.
- Completed jobs are pushed to `completedJobs` with a `company` field; the status page's "Completed" column uses the `[Expert]` prefix to distinguish expert jobs visually. We use a `[YT]` prefix for YouTube to get the same free visual distinction.
- Bookmark button injection from the existing endpoints depends on Claude generating a `<button id="bookmark-btn">` inside the HTML — our fragment-style output does not include one, so v1 YouTube outputs do not get a bookmark toggle. They still appear in the "Completed" column on `/status`. Adding bookmark support is a separate future change.
- `settings.model` (default `'opus'`) is loaded from `settings.json` and used when the request body doesn't override it — we follow the same pattern.

- [ ] **Step 1: Add the helper require**

In `Reader/server/server.js`, after the existing `const path = require('path');` line, add:

```js
const yt = require('./youtube-helpers');
```

- [ ] **Step 2: Add the YouTube prompt path constant**

Near the existing `const EXPERT_PROMPT_PATH = path.resolve(__dirname, 'prompt-expert.txt');` line (or `PROMPT_PATH` if the expert constant is elsewhere), add:

```js
const PROMPT_YT_PATH = path.resolve(__dirname, 'prompt-youtube.txt');
```

- [ ] **Step 3: Add the `/summarize-youtube` endpoint**

Place the entire block below directly after the existing `app.post('/summarize-expert', ...)` handler and its closing `});`. Do not wrap or rename anything; paste as-is.

```js
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
  const lockedModel = body.model || settings.model || 'opus';
  const label = `[YT] ${body.title.length > 80 ? body.title.slice(0, 77) + '...' : body.title}`;

  log(`POST /summarize-youtube: "${body.title}" channel=${body.channel || 'none'} ` +
      `(transcript entries: ${body.transcript.length}, verbosity: ${verbosity}, model: ${lockedModel})`);

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
    log(`Cleaning up YouTube transcript: ${label} [model=${lockedModel}]`);

    try {
      const promptTemplate = fs.readFileSync(PROMPT_YT_PATH, 'utf-8');
      const claudeInput = yt.buildClaudeInput(promptTemplate, { ...body, verbosity });
      log(`Job ${jobId}: prompt size ${claudeInput.length} chars`);

      const bodyFragment = await new Promise((resolve, reject) => {
        const chunks = [];
        const errChunks = [];
        const child = spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', lockedModel], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300000
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
        child.stdin.write(claudeInput);
        child.stdin.end();
      });

      // Validate: body fragment must start with <h3 or <p (per prompt spec)
      const trimmed = bodyFragment.trim();
      if (!trimmed || !(trimmed.startsWith('<h3') || trimmed.startsWith('<p'))) {
        throw new Error(`Claude returned non-fragment output (${bodyFragment.length} chars). First 300: ${bodyFragment.slice(0, 300)}`);
      }

      const meta = {
        title: body.title,
        channel: body.channel || '',
        uploadDate: body.uploadDate || '',
        durationSec: Number(body.durationSec) || 0,
        thumbnailUrl: body.thumbnailUrl || '',
        watchUrl: body.watchUrl,
      };
      const finalHtml = yt.renderYouTubeOutput(meta, trimmed);

      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const { filename, outputPath } = uniqueFilename(OUTPUT_DIR, `yt-${dateStr}-${yt.slugify(body.title)}.html`);
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
```

This block is a close mirror of the existing `/summarize-expert` handler — every difference is intentional (no `<!DOCTYPE` validation, fragment-prefix validation instead, YouTube-specific filename, `yt.renderYouTubeOutput` wrap, no bookmark button injection, no header metadata injection).

- [ ] **Step 4: Start the server and hit the endpoint with curl to verify plumbing**

Start the server:

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node server.js
```

Expected: server starts (look at the end of `server.log` if stdout is quiet). Leave it running in a second terminal.

Validation rejection:

```bash
curl -X POST http://localhost:3210/summarize-youtube -H "Content-Type: application/json" -d '{}'
```

Expected: `{"success":false,"error":"Missing transcript"}` (HTTP 400).

Full-payload test:

```bash
curl -X POST http://localhost:3210/summarize-youtube -H "Content-Type: application/json" -d '{"title":"Test Video","watchUrl":"https://youtube.com/watch?v=x","channel":"Ch","uploadDate":"2026-04-02","durationSec":60,"thumbnailUrl":"https://i.ytimg.com/vi/x/maxres.jpg","chapters":[],"transcript":[{"startMs":0,"text":"hello world this is a test"},{"startMs":2500,"text":"and a second caption event"}],"verbosity":180}'
```

Expected: `{"success":true,"jobId":"N","queued":false_or_true}`. A few seconds later, look in `Reader/output/` for `yt-YYYY-MM-DD-test-video.html`. Open it in a browser — it should render the Reader shell with the meta card and Claude's cleaned-up body fragment. If Claude CLI isn't available locally, the job will move to `error` — that's still a valid plumbing check. Confirm via:

```bash
curl http://localhost:3210/job/N   # replace N with the returned jobId
```

Stop the server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/server.js && git commit -m "$(cat <<'EOF'
feat(server): add /summarize-youtube endpoint and worker

Wires the YT payload through Claude CLI using prompt-youtube.txt and
renders via youtube-helpers.renderYouTubeOutput. Reuses the existing
job queue, history, and output pipeline.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Append YouTube CSS classes to `style.css`

**Files:**
- Modify: `Reader/server/style.css`

- [ ] **Step 1: Append the new classes to the bottom of `Reader/server/style.css`**

```css

/* YouTube transcript reader */
.yt-meta-card {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1.5rem;
  background: #f5efe8;
  border-left: 4px solid #c4956a;
  border-radius: 0 6px 6px 0;
  padding: 0.9rem 1rem;
}
.yt-meta-card img {
  flex: 0 0 180px;
  height: 101px;
  object-fit: cover;
  border-radius: 4px;
}
.yt-meta-body { flex: 1; font-size: 0.93rem; }
.yt-meta-title { font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem; }
.yt-meta-sub { color: #8b6d4e; margin-bottom: 0.35rem; }
.yt-meta-url { font-size: 0.85rem; color: #3d3225; }

h3.chapter {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 1.1rem;
  font-weight: 700;
  color: #3d3225;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
}
h3.chapter a {
  font-size: 0.8rem;
  color: #8b6d4e;
  text-decoration: none;
  font-weight: 400;
}
```

- [ ] **Step 2: Visually verify**

With the server running, open the test file you created in Task 8 (`http://localhost:3210/output/yt-YYYY-MM-DD-test-video.html`). The meta card should render with a cream background, tan left border, and a broken-image icon where the thumbnail would be (the test payload points at a non-existent URL — that's fine). If Task 8's Claude run errored rather than producing output, just eyeball the styles in `style.css`, push through this commit, and re-verify visually during Task 14.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add server/style.css && git commit -m "$(cat <<'EOF'
feat(server): add .yt-meta-card and h3.chapter styles

Reader-style cream-and-tan palette, 78ch-friendly, matches existing
.key-insight card look.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Extension manifest — add YouTube host permissions

**Files:**
- Modify: `Reader/extension/manifest.json`

- [ ] **Step 1: Add two host permissions**

In `Reader/extension/manifest.json`, inside the `host_permissions` array, add two new entries (keep the existing entries in place):

```json
  "host_permissions": [
    "https://www.bamsec.com/*",
    "http://localhost:3210/*",
    "https://*.tegus.co/*",
    "https://*.alphasense.com/*",
    "https://*.alpha-sense.com/*",
    "https://*.alphasights.com/*",
    "https://www.youtube.com/*",
    "https://m.youtube.com/*"
  ],
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add extension/manifest.json && git commit -m "$(cat <<'EOF'
feat(extension): add YouTube host permissions

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Extension background.js — add YouTube site pattern and message branch

**Files:**
- Modify: `Reader/extension/background.js`

Note: `background.js` has pre-existing uncommitted changes from earlier work. Do not lose them — your edits should layer on top of the current working-tree state. Read the file before editing.

- [ ] **Step 1: Read the current `background.js` to see where pre-existing changes live**

Use the Read tool on `C:/Users/AdrianOw/Projects/Reader/extension/background.js`. Confirm `SITE_PATTERNS` and `chrome.runtime.onMessage.addListener` are still present in roughly the shape described in the design spec. Note any modifications in the uncommitted area so you don't overwrite them.

- [ ] **Step 2: Add `youtube` to `SITE_PATTERNS`**

Find the `SITE_PATTERNS` object. Add a new entry at the end:

```js
  youtube: {
    match: url => /(?:^|\.)youtube\.com\/watch/.test(url),
    script: 'content-youtube.js',
    endpoint: '/summarize-youtube'
  },
```

- [ ] **Step 3: Add a `'youtube-transcript'` branch to the message listener**

Find the block inside `chrome.runtime.onMessage.addListener` that handles `message.type === 'transcript'` and `message.type === 'expert-transcript'`. Add a third branch alongside them (keep the `tabsSending` guard pattern):

```js
  } else if (message.type === 'youtube-transcript') {
    tabsSending.add(tabId);
    sendToServer(message.data, '/summarize-youtube', tabId).finally(() => tabsSending.delete(tabId));
  }
```

- [ ] **Step 4: Reload the extension in Brave/Chrome**

Open `chrome://extensions`, click the reload button on the Reader extension card. Watch for errors in the "Inspect views: service worker" console — the file must parse cleanly. No runtime test yet — that's Task 14.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add extension/background.js && git commit -m "$(cat <<'EOF'
feat(extension): route youtube.com/watch through new content script

Adds youtube site pattern and 'youtube-transcript' message branch.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Extension content script — `content-youtube.js`

**Files:**
- Create: `Reader/extension/content-youtube.js`

This script runs in the page's isolated world and uses an injected `<script>` bridge to read `ytInitialPlayerResponse` and `ytInitialData` from the main world.

- [ ] **Step 1: Create `Reader/extension/content-youtube.js`**

```js
// Runs on youtube.com/watch pages. Reads embedded YT JSON via an injected
// bridge, normalizes into a transcript payload, posts to background.

(async () => {
  try {
    const globals = await readPageGlobals();
    if (!globals) {
      chrome.runtime.sendMessage({ error: 'Failed to read YouTube page globals' });
      return;
    }
    const { player, initial } = globals;

    // Resolve caption track
    const tracks =
      player &&
      player.captions &&
      player.captions.playerCaptionsTracklistRenderer &&
      player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      chrome.runtime.sendMessage({ error: 'No captions available for this video' });
      return;
    }
    const isEnglish = code => {
      if (!code) return false;
      const lower = String(code).toLowerCase();
      return lower === 'en' || lower.startsWith('en-');
    };
    const englishTracks = tracks.filter(t => t && isEnglish(t.languageCode));
    if (englishTracks.length === 0) {
      chrome.runtime.sendMessage({ error: 'No English captions available for this video' });
      return;
    }
    const track = englishTracks.find(t => t.kind !== 'asr') || englishTracks[0];

    // Fetch caption JSON
    const captionUrl = track.baseUrl + '&fmt=json3';
    const resp = await fetch(captionUrl);
    if (!resp.ok) {
      chrome.runtime.sendMessage({ error: `Caption fetch failed: ${resp.status}` });
      return;
    }
    const captions = await resp.json();

    // Parse events → [{ startMs, text }]
    const transcript = [];
    for (const ev of captions.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      transcript.push({ startMs: Number(ev.tStartMs) || 0, text });
    }
    if (transcript.length === 0) {
      chrome.runtime.sendMessage({ error: 'Caption track was empty' });
      return;
    }

    // Metadata
    const vd = player.videoDetails || {};
    const micro =
      player.microformat &&
      player.microformat.playerMicroformatRenderer;
    const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    const bestThumb = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
    const meta = {
      title: vd.title || '',
      channel: vd.author || '',
      videoId: vd.videoId || '',
      durationSec: Number(vd.lengthSeconds) || 0,
      thumbnailUrl: bestThumb,
      uploadDate: (micro && micro.uploadDate) || '',
      watchUrl: vd.videoId ? `https://www.youtube.com/watch?v=${vd.videoId}` : window.location.href,
    };

    // Chapters (may or may not exist)
    const chapters = extractChapters(initial);

    // Verbosity from extension storage (defaults to 180)
    const { ytVerbosity } = await chrome.storage.local.get('ytVerbosity');
    const verbosity = typeof ytVerbosity === 'number' ? ytVerbosity : 180;

    chrome.runtime.sendMessage({
      type: 'youtube-transcript',
      data: { ...meta, chapters, transcript, verbosity },
    });
  } catch (err) {
    chrome.runtime.sendMessage({ error: `YouTube content script failed: ${err && err.message ? err.message : err}` });
  }
})();

// --- helpers ---

function readPageGlobals() {
  // Inject a bridge <script> that copies window.ytInitialPlayerResponse and
  // window.ytInitialData into a window.postMessage. We listen for the
  // response and resolve with the parsed objects.
  return new Promise((resolve) => {
    const nonce = 'reader-yt-' + Math.random().toString(36).slice(2);
    function listener(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.source !== nonce) return;
      window.removeEventListener('message', listener);
      resolve({ player: e.data.player, initial: e.data.initial });
    }
    window.addEventListener('message', listener);

    const code = `
      (function(){
        try {
          window.postMessage({
            source: ${JSON.stringify(nonce)},
            player: window.ytInitialPlayerResponse || null,
            initial: window.ytInitialData || null
          }, '*');
        } catch (e) {
          window.postMessage({ source: ${JSON.stringify(nonce)}, player: null, initial: null }, '*');
        }
      })();
    `;
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();

    // Timeout fallback after 3s so we never hang.
    setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(null);
    }, 3000);
  });
}

function extractChapters(initial) {
  try {
    const markersMap =
      initial &&
      initial.playerOverlays &&
      initial.playerOverlays.playerOverlayRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap;
    if (!Array.isArray(markersMap)) return [];
    const entry =
      markersMap.find(m => m && (m.key === 'DESCRIPTION_CHAPTERS' || m.key === 'AUTO_CHAPTERS'));
    if (!entry || !entry.value || !Array.isArray(entry.value.chapters)) return [];
    const out = [];
    for (const c of entry.value.chapters) {
      const r = c && c.chapterRenderer;
      if (!r) continue;
      const title =
        (r.title && typeof r.title.simpleText === 'string' && r.title.simpleText) ||
        (r.title && Array.isArray(r.title.runs) && r.title.runs.map(x => (x && x.text) || '').join('')) ||
        null;
      const startMs = Number(r.timeRangeStartMillis);
      if (title && Number.isFinite(startMs)) out.push({ title, startMs });
    }
    return out;
  } catch (e) {
    return [];
  }
}
```

- [ ] **Step 2: Reload the extension and check the service worker console parses it**

In `chrome://extensions`, click reload. Open "Inspect views: service worker" — no errors. (The content script itself isn't loaded until you click the button on a YT page; that happens in Task 14.)

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add extension/content-youtube.js && git commit -m "$(cat <<'EOF'
feat(extension): add YouTube content script

Reads ytInitialPlayerResponse/ytInitialData via an injected bridge,
resolves English caption track, fetches timedtext JSON, extracts
metadata and chapters, posts normalized payload to background.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Popup slider for YouTube verbosity

**Files:**
- Modify: `Reader/extension/popup.html`
- Modify: `Reader/extension/popup.js`

- [ ] **Step 1: Add the slider to `popup.html`**

In `Reader/extension/popup.html`, directly after the existing Expert Call Verbosity `.setting.expert` block and before the `.setting.concurrency` block, insert:

```html
  <div class="setting">
    <label>YouTube Verbosity <span id="yt-val">180</span></label>
    <input type="range" id="yt-verbosity" min="10" max="200" step="10" value="180">
  </div>
```

- [ ] **Step 2: Wire it up in `popup.js`**

Find the top of `popup.js` where the other slider references live (`ecSlider`, `exSlider`). Add the YT element references:

```js
const ytSlider = document.getElementById('yt-verbosity');
const ytVal = document.getElementById('yt-val');
```

Extend the `chrome.storage.local.get` call to include `ytVerbosity`:

```js
chrome.storage.local.get(['ecVerbosity', 'exVerbosity', 'ytVerbosity', 'concurrency'], (data) => {
  if (data.ecVerbosity != null) { ecSlider.value = data.ecVerbosity; ecVal.textContent = data.ecVerbosity; }
  if (data.exVerbosity != null) { exSlider.value = data.exVerbosity; exVal.textContent = data.exVerbosity; }
  if (data.ytVerbosity != null) { ytSlider.value = data.ytVerbosity; ytVal.textContent = data.ytVerbosity; }
  if (data.concurrency != null) { concurrency.value = data.concurrency; }
});
```

Add a change listener symmetric to the existing ones:

```js
ytSlider.addEventListener('input', () => {
  ytVal.textContent = ytSlider.value;
  chrome.storage.local.set({ ytVerbosity: parseInt(ytSlider.value) });
});
```

- [ ] **Step 3: Reload the extension and manually verify**

Reload in `chrome://extensions`. Click the extension icon to open the popup. The new slider appears under Expert Call Verbosity, shows `180`, and persists when you drag it and close/reopen the popup.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add extension/popup.html extension/popup.js && git commit -m "$(cat <<'EOF'
feat(extension): add YouTube verbosity slider to popup

Default 180 (near-verbatim). Persisted to chrome.storage.local as
ytVerbosity. Read by content-youtube.js at extract time.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: End-to-end manual verification on three real videos

**Files:** none modified in this task unless bugs are found.

This is the only integration test. Browser automation of YouTube is not worth the complexity; manual verification covers the full round-trip.

- [ ] **Step 1: Start the server and reload the extension**

Terminal A:
```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node server.js
```

Chrome: reload the Reader extension at `chrome://extensions`.

- [ ] **Step 2: Test case 1 — long interview WITH chapters**

Navigate to any podcast-style YouTube video that has creator-defined chapters (the video description will show a timestamp list, and the video progress bar shows segmented chapter ticks). Click the Reader extension icon.

Expected:
- Badge flips to `...` then `OK` (may take 30-90s depending on video length).
- A new tab opens to `http://localhost:3210/output/yt-YYYY-MM-DD-<slug>.html`.
- The page renders: sticky header with title + channel + Watch on YouTube button; meta card with thumbnail (left) + title + channel · date · duration + URL; a sequence of `<h3 class="chapter">` headings matching the video's chapters, each with a `↪ mm:ss` jump link that opens the video at that time; verbatim paragraphs between headings, with punctuation and no filler.
- The video title appears in the bookmark/history list on the status page (`http://localhost:3210/status`) as a YouTube entry.

If any of this fails:
- **Wrong or no chapters:** open DevTools on the YouTube page and inspect `ytInitialData.playerOverlays` to check whether the chapter path in `extractChapters` matches current YouTube markup. Adjust the accessor in `content-youtube.js`, commit as a fixup.
- **Transcript empty or broken:** check the service worker console for the `{ error: ... }` message and follow the same debugging pattern on `ytInitialPlayerResponse.captions`.
- **Output HTML looks wrong:** check Claude's raw output in `server.log`; if the prompt is being ignored (e.g. summary appears), tighten the prompt wording in Task 7 and retry.

- [ ] **Step 3: Test case 2 — short video WITHOUT chapters**

Pick any 5-15 minute YouTube video with captions but no chapter markers (most tutorial/talk videos). Click the Reader extension icon.

Expected:
- Same success path as case 1, but the output contains NO `<h3>` headings — just paragraphs directly after the meta card.

- [ ] **Step 4: Test case 3 — auto-captioned video**

Pick a video with only auto-generated captions (no human-authored track — you can tell because YouTube's caption menu shows "English (auto-generated)"). Click the Reader extension icon.

Expected:
- Success. The ASR fallback path in `resolveCaptionTrack` kicks in. Output quality may be noticeably worse (more guesses in punctuation, more residual filler) but the page still renders and is readable.

- [ ] **Step 5: Test case 4 — video with no English captions**

Pick a video with only non-English captions. Click the icon.

Expected:
- Badge flips to red `ERR` within a second or two.
- No new tab opens.
- The service worker console shows `Content script error: No English captions available for this video`.

- [ ] **Step 6: Commit any bug fixes uncovered in steps 2-5**

If you had to change `content-youtube.js`, the prompt, CSS, or anything else to make any of the four test cases pass, commit each fix separately with a message describing what broke and what the fix is. No fixup commits — normal focused commits. Example:

```bash
cd "C:/Users/AdrianOw/Projects/Reader" && git add extension/content-youtube.js && git commit -m "$(cat <<'EOF'
fix(extension): handle chapters under updatedMarkersMap key

YT renamed the markersMap path on some videos; add a second accessor.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Stop the server**

Ctrl+C in the server terminal.

- [ ] **Step 8: Final sanity check — run unit tests once more**

```bash
cd "C:/Users/AdrianOw/Projects/Reader/server" && node --test youtube-helpers.test.js
```

Expected: all 31 tests still pass (helper changes from bug fixes should have added tests, not broken tests).

---

## Completion Criteria

- [ ] All 14 tasks checked off.
- [ ] `npm test` in `Reader/server` runs green.
- [ ] All four manual test cases in Task 14 pass.
- [ ] No new warnings in the extension service worker console during a successful run.
- [ ] Pre-existing uncommitted changes in `background.js`, `content-expert.js`, `prompt-expert.txt`, and `server.js` remain present in the working tree (they were never staged by any of these commits).

## Notes for the Implementer

- **Claude CLI invocation.** The plan inlines the exact spawn pattern from the existing endpoints (`spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', lockedModel], ...)`). If the existing endpoints are updated later to use a shared helper, this endpoint should be refactored to match — do not let it drift.
- **Bookmark button.** v1 YouTube output pages do not include the bookmark button. They still appear in the "Completed" column on `/status`. If you want bookmarking later, it's an additive change: include `<button id="bookmark-btn">` in `renderYouTubeOutput`, ship the `bookmarkTranscript()` client-side helper with the page, and inject the `data-*` attributes at write time like the other endpoints do.
- **Chapter accessor fragility.** YouTube's `playerOverlays...multiMarkersPlayerBarRenderer.markersMap` path has shifted before. If Task 14 step 2 fails on the chapter check but the rest works, treat it as a bug to fix in `extractChapters` — try inspecting `ytInitialData` in DevTools and adding a second accessor path, not a fallback to parsing the description.
- **Thumbnails and image display.** The highest-resolution thumbnail from `videoDetails.thumbnail.thumbnails` sometimes returns a very large `maxres` URL. The CSS sets `height: 101px; object-fit: cover` so it always displays cleanly.
- **Non-English fallback.** Do not add one even if tempted during Task 14. It's explicitly out of scope in the spec.
