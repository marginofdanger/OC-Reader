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
  assert.ok(result.length <= 60, `expected <=60, got ${result.length}: ${result}`);
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
  // Default (no inlineCss): link tag to /style.css
  assert.ok(html.includes('<link rel="stylesheet" href="/style.css">'));
  assert.ok(html.includes('</html>'));
});

test('renderYouTubeOutput inlines CSS when meta.inlineCss is provided', () => {
  const html = renderYouTubeOutput({ ...sampleMeta, inlineCss: 'body { color: red; }' }, '<p>x</p>');
  assert.ok(html.includes('<style>\nbody { color: red; }\n</style>'));
  assert.ok(!html.includes('<link rel="stylesheet" href="/style.css">'));
});

test('renderYouTubeOutput includes a share button and hide-on-remote script', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p>x</p>');
  assert.ok(html.includes('id="yt-share-btn"'));
  assert.ok(html.includes('shareYtPage'));
  assert.ok(html.includes("fetch('/share'"));
  assert.ok(html.includes('hideLocalOnlyControls'));
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
  // No more duplicate meta card in <main> -- everything is in the sticky header
  assert.ok(!between.includes('yt-meta-card'));
});

test('renderYouTubeOutput wraps body fragment in .yt-body', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p class="q">why?</p><p>because</p>');
  assert.ok(html.includes('<div class="yt-body">'));
  const bodyOpen = html.indexOf('<div class="yt-body">');
  assert.ok(bodyOpen > 0);
  const after = html.slice(bodyOpen);
  assert.ok(after.includes('<p class="q">why?</p>'));
  assert.ok(after.includes('<p>because</p>'));
});

test('renderYouTubeOutput packs thumbnail, date, length into the sticky header', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p>x</p>');
  const headerOpen = html.indexOf('<header>');
  const headerClose = html.indexOf('</header>');
  const between = html.slice(headerOpen, headerClose);
  assert.ok(between.includes(sampleMeta.thumbnailUrl));
  assert.ok(between.includes('1h 47m'));
  assert.ok(between.includes('Apr 2, 2026'));
  assert.ok(between.includes(sampleMeta.channel));
  // Header link is accessibility-labeled with "Watch on YouTube" and shows "YT"
  assert.ok(between.includes('title="Watch on YouTube"'));
  assert.ok(between.match(/>YT<\/a>/));
});

test('renderYouTubeOutput includes bookmark button with filename data attr', () => {
  const html = renderYouTubeOutput({ ...sampleMeta, filename: 'yt-2026-04-14-test.html' }, '<p>x</p>');
  assert.ok(html.includes('id="yt-bookmark-btn"'));
  assert.ok(html.includes('data-filename="yt-2026-04-14-test.html"'));
  assert.ok(html.includes('toggleYtBookmark'));
  assert.ok(html.includes("fetch('/bookmark'"));
  assert.ok(html.includes("fetch('/bookmarks'"));
});

test('renderYouTubeOutput bookmark button has empty data-filename if not provided', () => {
  const html = renderYouTubeOutput(sampleMeta, '<p>x</p>');
  assert.ok(html.includes('data-filename=""'));
});
