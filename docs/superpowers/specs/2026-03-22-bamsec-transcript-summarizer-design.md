# BamSEC Transcript Summarizer — Design Spec

## Overview

A Brave browser extension that extracts earnings call transcripts from BamSEC and sends them to a local Node.js server, which pipes the text through the Claude CLI to produce a structured HTML summary. The summary preserves the structure and tone of the original transcript.

## Components

### 1. Brave Extension

**Purpose:** Scrape transcript text from BamSEC and send it to the local server.

**Files:**
- `extension/manifest.json` — Manifest V3. Permissions: `*://www.bamsec.com/*`, `http://localhost:3210/*`
- `extension/background.js` — Service worker. Listens for toolbar button click, injects content script, receives scraped text, POSTs to local server, shows status via badge
- `extension/content.js` — Injected into BamSEC page. Scrapes transcript DOM, extracts structured data (speakers, roles, text blocks), identifies the prepared remarks vs Q&A boundary, sends data back to background script
- `extension/icons/` — Extension icons (16, 48, 128px)

**Scraping approach:** BamSEC transcript pages render server-side HTML (no SPA/dynamic loading). The content script targets:
- **Metadata:** Company name, ticker, quarter, and date extracted from the page header elements and URL path (BamSEC URLs contain the filing CIK and accession number)
- **Transcript body:** The main content container holds the full transcript as sequential text blocks. Speaker names appear as bold/strong elements preceding their remarks.
- **Section boundary:** The Q&A section is identifiable by a heading or separator containing "Question-and-Answer" or similar text, dividing prepared remarks from Q&A.
- **Speaker extraction:** Speaker names and roles (CEO, CFO, analyst + firm) are parsed from the bold-formatted speaker introductions.

Note: BamSEC's DOM structure should be inspected at implementation time and selectors confirmed. The content script should be written to degrade gracefully — if structured extraction fails, fall back to extracting all visible text from the transcript container.

**UX flow:**
1. User navigates to a BamSEC earnings transcript page
2. Clicks the extension toolbar button
3. Extension checks server health (`GET /health`)
4. If server is down, shows error badge/notification
5. If server is up, scrapes transcript, POSTs to `/summarize`
6. Shows "Summarizing..." badge while waiting
7. Shows "Done" or error when complete

### 2. Local Node.js Server

**Purpose:** Receive transcript data, invoke Claude CLI, save and open the HTML output.

**Files:**
- `server/server.js` — Express server on `localhost:3210`
- `server/package.json` — Dependencies: `express`, `open`
- `server/prompt.txt` — Claude CLI prompt template

**Endpoints:**
- `GET /health` — Returns `{ status: "ok" }`. Used by extension to verify server is running.
- `POST /summarize` — Accepts JSON body: `{ transcript, ticker, quarter, year, company }`. Orchestrates the summarization pipeline.

**POST /summarize pipeline:**
1. Validate required fields
2. Compose the full prompt by reading `prompt.txt` and appending the transcript text (separated by a delimiter)
3. Write the composed prompt to a temp file (transcripts can be 15k+ words — too large for a shell argument)
4. Spawn Claude CLI, piping the temp file via stdin: `claude -p - < tempfile.txt`
5. Capture stdout (the HTML output)
6. Save to `${PROJECT_ROOT}/output/{ticker}-Q{quarter}-{year}.html` — where `PROJECT_ROOT` is resolved via `path.resolve(__dirname, '..')` (the Reader directory)
7. Open the file in the default browser via the `open` package
8. Clean up temp file
9. Return `{ success: true, path: "..." }` to extension

**No authentication** — localhost only.
**No database** — file I/O only.

### 3. Claude CLI Prompt

The prompt template (`server/prompt.txt`) instructs Claude to produce:

1. **Header** — Company name, ticker, quarter, date
2. **Prepared Remarks** — Summarized management commentary, attributed to each speaker (CEO, CFO, etc.). Condensed but preserving the speaker's tone and key phrases.
3. **Q&A Section** — Each analyst question paired with management's answer:
   - Analyst name and firm
   - Question (summarized)
   - Management response (summarized, preserving flavor of original language)
4. **Styling** — Self-contained HTML with inline CSS. Clean typography, good spacing, comfortable reading experience. No external dependencies.

Output: Valid HTML only. No markdown, no code fences.

### 4. HTML Output

- **Location:** `Reader/output/`
- **Filename pattern:** `{TICKER}-Q{quarter}-{year}.html`
- **Example:** `AAPL-Q1-2026.html`
- **Self-contained:** Inline CSS, no external resources
- **Auto-opened** in default browser after generation

## Data Flow

```
BamSEC page (Brave)
    │
    ▼
Extension content.js scrapes transcript
    │
    ▼
Extension background.js POSTs to localhost:3210/summarize
    │
    ▼
Node server writes transcript to temp file
    │
    ▼
Node server pipes prompt+transcript to: claude -p via stdin
    │
    ▼
Claude CLI returns HTML summary
    │
    ▼
Server saves to Reader/output/{ticker}-Q{q}-{year}.html
    │
    ▼
Server opens HTML in default browser
    │
    ▼
Server returns success to extension
```

## Project Structure

```
Reader/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── server/
│   ├── server.js
│   ├── package.json
│   └── prompt.txt
├── output/
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-03-22-bamsec-transcript-summarizer-design.md
```

## Error Handling

- Extension checks `/health` before sending — shows clear error if server is down
- Server validates required fields in POST body
- If Claude CLI fails or times out, server returns error with details
- Extension shows error state via badge text

## Assumptions

- Claude CLI (`claude`) is installed and available on PATH
- User starts the Node server manually before using the extension (`node server/server.js`)
- BamSEC transcript pages have a consistent DOM structure that can be scraped
- Transcripts fit within Claude's context window (earnings calls typically 5k-15k words)

## Out of Scope

- Automatic server startup
- Authentication or multi-user support
- Persistent storage or history tracking
- Non-transcript BamSEC pages (10-K, 10-Q, etc.)
- Batch processing of multiple transcripts
