# YouTube Transcript Reader — Design

**Date:** 2026-04-13
**Project:** extension of `Reader/`
**Status:** design approved, awaiting implementation plan

## Goal

Let the user press the Reader extension button on any YouTube watch page and receive
an elegantly formatted, near-verbatim HTML reading copy of the video's transcript,
served from the existing local Reader server and matching the existing Reader
visual style.

## Scope

- **In:** YouTube watch pages with available English captions (human or auto-generated);
  verbatim cleanup only (punctuation, capitalization, paragraph breaks, filler removal);
  chapter-aware headings when YouTube provides explicit chapters; thumbnail + metadata card;
  verbosity slider tied to the existing popup pattern.
- **Out:** summarization, section headings invented by Claude, non-English captions,
  non-YouTube video platforms, playlist handling, Data API usage, video/audio download.

## Non-Goals

- No new standalone project. All changes land in the existing `Reader/` codebase.
- No changes to existing `/summarize` or `/summarize-expert` behavior.
- No new output-page scaffolding: the bookmarking, history, status page, and job queue
  infrastructure are reused as-is.

## Architecture Overview

The extension detects YouTube watch pages, extracts transcript + metadata from the
page's embedded `ytInitialPlayerResponse` / `ytInitialData` JSON, and POSTs the
payload to a new `/summarize-youtube` endpoint on the existing Reader server. The
server pipes the payload through Claude CLI with a YouTube-specific prompt that only
cleans up the transcript, wraps the result in the existing Reader HTML shell plus a
new metadata card, and opens the output file in a new tab via the existing pipeline.

```
[YouTube watch page]
        │ user clicks Reader extension icon
        ▼
[background.js] ─ detects YT, injects content-youtube.js
        │
        ▼
[content-youtube.js] ─ reads ytInitialPlayerResponse + ytInitialData,
        │              fetches timedtext JSON, builds payload
        ▼
[background.js] ─ POST /summarize-youtube, polls via alarms
        │
        ▼
[server.js] ─ job queue → Claude CLI with prompt-youtube.txt
        │
        ▼
[output/yt-YYYY-MM-DD-<slug>.html] ─ opens in new tab, added to bookmarks
```

## Component Changes

### Extension: `Reader/extension/manifest.json`

Add to `host_permissions`:

```
"https://www.youtube.com/*",
"https://m.youtube.com/*"
```

No other manifest changes.

### Extension: `Reader/extension/background.js`

Add one entry to `SITE_PATTERNS`:

```js
youtube: {
  match: url => /(?:^|\.)youtube\.com\/watch/.test(url),
  script: 'content-youtube.js',
  endpoint: '/summarize-youtube'
}
```

Add one branch to the `chrome.runtime.onMessage` listener that handles
`message.type === 'youtube-transcript'` the same way `'transcript'` is handled
today (guard with `tabsSending`, call `sendToServer`). No changes to the polling,
badge, or alarm infrastructure.

### Extension: `Reader/extension/content-youtube.js` (new)

The content script runs in the isolated world and must read page variables
(`ytInitialPlayerResponse`, `ytInitialData`) that live in the main world. The
standard workaround is used:

1. Inject a `<script>` element into the page that reads both variables and posts
   them back via `window.postMessage({ source: 'reader-yt', player, initial })`.
2. The content script listens for that message with an origin check, then:
   a. Resolves an English caption track from
      `player.captions.playerCaptionsTracklistRenderer.captionTracks`, preferring
      `languageCode === 'en' && kind !== 'asr'` (human English), falling back to
      any `languageCode === 'en'` track (auto-generated English). If no English
      track exists, sends `{ error: 'No English captions available for this
      video' }` to the background and exits — non-English content is explicitly
      out of scope, so there is no fallback to other languages.
   b. Fetches `track.baseUrl + '&fmt=json3'` and parses the `events` array into
      `[{ startMs, text }]` entries. Each event's `segs` array is joined with
      spaces, leading/trailing whitespace trimmed, and empty events dropped.
   c. Extracts metadata from `player.videoDetails` and
      `player.microformat.playerMicroformatRenderer`:
      - `title`, `channel` (= `author`), `videoId`, `durationSec` (= `lengthSeconds`),
        `thumbnailUrl` (= highest-resolution entry in
        `videoDetails.thumbnail.thumbnails`), `uploadDate`, `watchUrl` (constructed
        from `videoId`).
   d. Extracts chapters from
      `initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap`,
      finding the first entry whose `key === 'DESCRIPTION_CHAPTERS'` or
      `'AUTO_CHAPTERS'`, and reading `value.chapters[].chapterRenderer` into
      `[{ title, startMs: timeRangeStartMillis }]`. If the path is missing, use
      an empty array. No description-text fallback.
   e. Reads `ytVerbosity` from `chrome.storage.local` (default 180) and includes
      it in the payload.
3. Posts `{ type: 'youtube-transcript', data: { ... } }` to the background.

**Resilience note:** YouTube's internal JSON shapes change periodically. The script
wraps every nested access in try/catch with explicit null-checks and emits a
descriptive `{ error: ... }` on any structural mismatch so debugging is easier than
"undefined is not a function". Caption fetch failures are likewise caught and
reported.

### Extension: `Reader/extension/popup.html` + `popup.js`

Add a third `.setting` block below Expert Call Verbosity:

```html
<div class="setting">
  <label>YouTube Verbosity <span id="yt-val">180</span></label>
  <input type="range" id="yt-verbosity" min="10" max="200" step="10" value="180">
</div>
```

`popup.js` gains the symmetric load/save wiring using the key `ytVerbosity`. The
accent color matches the existing tan slider (no `.setting.youtube` override).

### Server: `Reader/server/server.js`

Add a new route `POST /summarize-youtube` that:

1. Validates the payload has `transcript`, `title`, and `watchUrl`.
2. Enqueues a job with `type: 'youtube'`, using the existing job queue helper.
3. Returns `{ success: true, jobId }`.

Add a new worker branch inside the existing job processor that, for
`type === 'youtube'`:

1. Reads `prompt-youtube.txt`.
2. Builds the Claude CLI stdin: the prompt, followed by a JSON block containing
   `{ title, channel, uploadDate, durationSec, chapters, transcript, verbosity }`.
   Transcript entries are flattened to lines of the form `[mm:ss] text` so the
   model can see timing for paragraph-break decisions.
3. Spawns the Claude CLI identically to the existing endpoints.
4. Collects Claude's output (HTML body fragment) and passes it to a new
   `renderYouTubeOutput(meta, bodyFragment)` function that wraps it in the output
   shell.
5. Writes the file to `output/yt-YYYY-MM-DD-<slug>.html` where `<slug>` is derived
   from the video title (lowercased, non-alphanum → hyphens, truncated to 60 chars).
6. Updates the job to `done` with the filename and registers it in the existing
   bookmark/history store with `kind: 'youtube'`.

The status page rendering and existing routes are unchanged. If the
bookmark/history store distinguishes kinds visually, a new `youtube` kind is added
alongside `earnings` and `expert`.

### Server: `Reader/server/prompt-youtube.txt` (new)

The prompt establishes:

- **Role:** You are a transcript editor. You are *not* a summarizer.
- **Task:** Convert a raw YouTube caption stream into clean, readable prose.
- **What to do:** Add punctuation. Capitalize sentences. Break into paragraphs at
  natural pause points (use the `[mm:ss]` timing to help — a gap of several seconds
  is usually a paragraph break). Remove filler words (`um`, `uh`), verbal tics
  (`you know`, `I mean`, `like` used as filler), and false starts
  (`I think — I mean I thought`).
- **What not to do:** Do not summarize. Do not compress. Do not add section
  headings of your own invention. Do not change the speaker's wording beyond the
  cleanup listed above. Do not editorialize or paraphrase.
- **Chapters:** If the input's `chapters` array is non-empty, emit an
  `<h3 class="chapter">` at each chapter boundary containing the chapter title
  and a right-side anchor link of the form
  `<a href="{watchUrl}&t={startSec}s">↪ {mm:ss}</a>`. Place each heading
  immediately before the first paragraph whose `[mm:ss]` timestamp is at or after
  the chapter start. If `chapters` is empty, emit no headings at all — pure
  paragraphs.
- **Verbosity:** The `verbosity` input is a knob on *how aggressively to trim
  filler and redundancy*, not a knob on content. 200 = strip only pure filler
  words; 180 (default) = also remove false starts and verbal tics; 100 = also
  tighten obvious redundancy while preserving meaning; 10 = very tight, still no
  invented structure. Verbosity never authorizes summarization.
- **Output format:** Emit only the HTML body fragment — a sequence of `<h3
  class="chapter">` (optional) and `<p>` elements. No `<html>`, `<head>`,
  `<body>`, `<main>`, or wrapper divs. No markdown.

### Server: `Reader/server/style.css`

Append:

```css
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

No modifications to existing selectors.

### Server: output shell

`renderYouTubeOutput(meta, bodyFragment)` produces:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="header-title"><strong>{title}</strong> &nbsp; {channel}</div>
      <a class="header-link" href="{watchUrl}" target="_blank">Watch on YouTube</a>
    </div>
  </header>
  <main>
    <div class="yt-meta-card">
      <a href="{watchUrl}" target="_blank"><img src="{thumbnailUrl}" alt=""></a>
      <div class="yt-meta-body">
        <div class="yt-meta-title">{title}</div>
        <div class="yt-meta-sub">{channel} · {uploadDate} · {formattedDuration}</div>
        <div class="yt-meta-url">{watchUrl}</div>
      </div>
    </div>
    {bodyFragment}
  </main>
</body>
</html>
```

`formattedDuration` is `Xh Ym` for durations ≥ 1h, `Ym` otherwise. `uploadDate`
is rendered as `Mon D, YYYY` (e.g. `Apr 2, 2026`). All interpolated values are
HTML-escaped except `bodyFragment`.

## Data Flow

1. User clicks Reader extension icon on a YouTube watch page.
2. `background.js` detects `youtube.com/watch`, checks server health, injects
   `content-youtube.js`.
3. Content script injects an in-page bridge script, receives the JSON globals,
   resolves the caption track, fetches `timedtext` JSON, extracts metadata and
   chapters, reads `ytVerbosity` from storage, posts
   `{ type: 'youtube-transcript', data }` to the background.
4. `background.js` POSTs to `/summarize-youtube`, receives a `jobId`, creates a
   polling alarm.
5. Server enqueues the job, worker picks it up, runs Claude CLI with
   `prompt-youtube.txt`, gets an HTML body fragment, calls `renderYouTubeOutput`,
   writes the file, marks the job `done`, registers the bookmark.
6. Background alarm fires, sees `job.status === 'done'`, opens the output URL in a
   new tab, flips badge to `OK`.

## Error Handling

Only one new failure mode: **no English caption track**. The content script detects
this and posts `{ error: 'No captions available for this video' }`, which the
existing background error path renders as a red `ERR` badge. All other failure
paths (server unreachable, Claude CLI error, job worker exception, network fault)
are handled by the existing infrastructure without modification.

Structural mismatches in YouTube's internal JSON (e.g. a renamed
`playerCaptionsTracklistRenderer` key) are caught per-access and reported as
`{ error: 'Failed to locate caption tracks on this page' }` so future breakage
surfaces clearly rather than as silent undefined access.

## Testing

Manual end-to-end verification on three representative videos:

1. **Long interview with explicit chapters** (e.g. a 90-minute podcast with
   creator-authored chapter markers) — confirms chapter headings render, jump
   links work, and verbatim paragraphs fill each section.
2. **Short talk without chapters** (e.g. a 10-minute conference talk) — confirms
   headless paragraph-only output.
3. **Auto-captioned video** (no human captions) — confirms the ASR fallback works
   and output quality is acceptable.

Also: load the extension in Brave/Chrome, verify the popup slider persists its
value across sessions, and verify that the bookmark/history page shows YouTube
entries distinctly.

## Open Questions

None as of this revision.
