# BamSEC Transcript Summarizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Brave extension + local Node server that scrapes earnings call transcripts from BamSEC and produces HTML summaries via the Claude CLI.

**Architecture:** Three components — (1) Brave Manifest V3 extension that scrapes transcript text from BamSEC's iframe-embedded transcript DOM, (2) a local Express server on port 3210 that receives the transcript and shells out to the Claude CLI, (3) a prompt template that instructs Claude to produce a self-contained HTML summary preserving the original tone.

**Tech Stack:** JavaScript (extension + server), Node.js, Express, Claude CLI (`claude -p`)

**Spec:** `docs/superpowers/specs/2026-03-22-bamsec-transcript-summarizer-design.md`

---

## BamSEC DOM Structure Reference

The transcript lives inside an iframe with `id="embedded_doc"` (same-origin, directly accessible from content script).

**Outer page:**
- `document.title` — `"SoFi Technologies, Inc., Q4 2025 Earnings Call, Jan 30, 2026 – SoFi Technologies Inc. – BamSEC"`
- `a[href*="/companies/"]` — Company name link (e.g., `"SoFi Technologies Inc."`)
- URL pattern: `https://www.bamsec.com/transcripts/{uuid}`

**Inside iframe (`#embedded_doc`):**
- `H1` — Title: `"SoFi Technologies, Inc., Q4 2025 Earnings Call, Jan 30, 2026"`
- `H2` sections (in order): `"Corporate Participants"`, `"Conference Call Participants"`, `"Presentation"`, `"Questions and Answers"`
- `H3` — Speaker names with company and role: `"Anthony J. Noto SoFi Technologies, Inc. – CEO & Director"`
- `P` — Paragraphs of speech text, following each `H3`
- `LI` — Participant list items under `"Corporate Participants"` and `"Conference Call Participants"` H2 sections

**Key structural rule:** The transcript is a flat sequence of `H2 > H3 > P+` blocks. Each speaker turn is an `H3` (speaker name + role) followed by one or more `P` tags containing their remarks. The `H2` headings `"Presentation"` and `"Questions and Answers"` divide prepared remarks from Q&A.

---

## File Structure

```
Reader/
├── extension/
│   ├── manifest.json          # Manifest V3 config, permissions, toolbar action
│   ├── background.js          # Service worker: button click → inject → POST to server
│   ├── content.js             # Scrapes iframe DOM, extracts structured transcript
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── server/
│   ├── package.json           # Express dependency
│   ├── server.js              # Express server: /health, /summarize endpoints
│   └── prompt.txt             # Claude CLI prompt template
├── output/                    # Generated HTML summaries
└── docs/
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `server/package.json`
- Create: `extension/manifest.json`
- Create: `output/.gitkeep`

- [ ] **Step 1: Initialize server package.json**

```json
{
  "name": "bamsec-summarizer-server",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "open": "^10.1.0"
  }
}
```

Write to `server/package.json`.

- [ ] **Step 2: Install server dependencies**

Run: `cd server && npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 3: Create extension manifest**

```json
{
  "manifest_version": 3,
  "name": "BamSEC Transcript Summarizer",
  "version": "1.0.0",
  "description": "Extract earnings call transcripts from BamSEC and summarize via Claude",
  "permissions": ["activeTab", "scripting"],
  "host_permissions": [
    "https://www.bamsec.com/*",
    "http://localhost:3210/*"
  ],
  "action": {
    "default_title": "Summarize Transcript",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "background": {
    "service_worker": "background.js"
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Write to `extension/manifest.json`.

- [ ] **Step 4: Create placeholder icons**

Create simple colored square PNGs at `extension/icons/icon16.png`, `icon48.png`, `icon128.png`. These can be generated as solid-color 1x1 pixel PNGs or simple canvas-drawn icons via a Node script.

- [ ] **Step 5: Create output directory**

Run: `mkdir -p output && touch output/.gitkeep`

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json extension/manifest.json extension/icons/ output/.gitkeep
git commit -m "feat: scaffold project with extension manifest and server package"
```

---

### Task 2: Content Script — Transcript Scraper

**Files:**
- Create: `extension/content.js`

- [ ] **Step 1: Write content.js**

This script is injected into BamSEC transcript pages. It accesses the `#embedded_doc` iframe and extracts structured transcript data.

```javascript
(function () {
  // Access the transcript iframe
  const iframe = document.getElementById('embedded_doc');
  if (!iframe) {
    chrome.runtime.sendMessage({ error: 'No transcript iframe found on this page.' });
    return;
  }

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  if (!doc) {
    chrome.runtime.sendMessage({ error: 'Cannot access transcript iframe content.' });
    return;
  }

  // --- Extract metadata ---
  const h1 = doc.querySelector('h1');
  const titleText = h1 ? h1.textContent.trim() : document.title;

  // Parse title: "SoFi Technologies, Inc., Q4 2025 Earnings Call, Jan 30, 2026"
  // Pattern: "{Company}, {Quarter} {Year} Earnings Call, {Date}"
  const titleMatch = titleText.match(/^(.+?),\s*(Q[1-4])\s+(\d{4})\s+Earnings Call/i);
  const company = titleMatch ? titleMatch[1].trim() : titleText;
  const quarter = titleMatch ? titleMatch[2] : '';
  const year = titleMatch ? titleMatch[3] : '';

  // Try to extract ticker from company link on outer page
  const companyLink = document.querySelector('a[href*="/companies/"]');
  const companyName = companyLink ? companyLink.textContent.trim() : company;

  // --- Extract transcript body ---
  const elements = Array.from(doc.body.children);
  let currentSection = '';
  let currentSpeaker = '';
  const sections = { presentation: [], qa: [] };

  for (const el of elements) {
    const tag = el.tagName;
    const text = el.textContent.trim();

    if (tag === 'H2') {
      if (text === 'Presentation') {
        currentSection = 'presentation';
      } else if (text === 'Questions and Answers') {
        currentSection = 'qa';
      }
      continue;
    }

    if (!currentSection) continue;

    if (tag === 'H3') {
      currentSpeaker = text;
      continue;
    }

    if (tag === 'P' && text && currentSpeaker) {
      const target = currentSection === 'presentation' ? sections.presentation : sections.qa;
      // Append to existing speaker block or create new one
      const lastBlock = target[target.length - 1];
      if (lastBlock && lastBlock.speaker === currentSpeaker) {
        lastBlock.text += '\n\n' + text;
      } else {
        target.push({ speaker: currentSpeaker, text });
      }
    }
  }

  // --- Build full transcript text for Claude ---
  let transcript = `${company} - ${quarter} ${year} Earnings Call\n\n`;
  transcript += '=== PREPARED REMARKS ===\n\n';
  for (const block of sections.presentation) {
    transcript += `[${block.speaker}]\n${block.text}\n\n`;
  }
  transcript += '=== QUESTIONS AND ANSWERS ===\n\n';
  for (const block of sections.qa) {
    transcript += `[${block.speaker}]\n${block.text}\n\n`;
  }

  // Send to background script
  chrome.runtime.sendMessage({
    type: 'transcript',
    data: {
      transcript,
      company: companyName,
      quarter,
      year,
      title: titleText
    }
  });
})();
```

Write to `extension/content.js`.

- [ ] **Step 2: Verify the script handles edge cases**

Review: the script degrades gracefully — if `#embedded_doc` is missing or inaccessible, it sends an error message. If the title doesn't match the regex, it falls back to the raw title. If there's no ticker, it uses the company name.

- [ ] **Step 3: Commit**

```bash
git add extension/content.js
git commit -m "feat: add content script to scrape BamSEC transcript DOM"
```

---

### Task 3: Background Service Worker

**Files:**
- Create: `extension/background.js`

- [ ] **Step 1: Write background.js**

```javascript
const SERVER_URL = 'http://localhost:3210';

// Listen for toolbar button click
chrome.action.onClicked.addListener(async (tab) => {
  // Only work on BamSEC transcript pages
  if (!tab.url || !tab.url.includes('bamsec.com/transcripts')) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Not a BamSEC transcript page');
    return;
  }

  // Check server health first
  try {
    const health = await fetch(`${SERVER_URL}/health`);
    if (!health.ok) throw new Error('Server unhealthy');
  } catch (e) {
    await setBadge('OFF', '#cc0000', tab.id);
    console.error('Server not running at', SERVER_URL);
    return;
  }

  // Show "working" state
  await setBadge('...', '#0066cc', tab.id);

  // Inject content script to scrape the page
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Failed to inject content script:', e);
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message.error) {
    setBadge('ERR', '#cc0000', tabId);
    console.error('Content script error:', message.error);
    return;
  }

  if (message.type === 'transcript') {
    sendToServer(message.data, tabId);
  }
});

async function sendToServer(data, tabId) {
  try {
    const response = await fetch(`${SERVER_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (result.success) {
      await setBadge('OK', '#00aa00', tabId);
    } else {
      await setBadge('ERR', '#cc0000', tabId);
      console.error('Server error:', result.error);
    }
  } catch (e) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('Failed to reach server:', e);
  }
}

async function setBadge(text, color, tabId) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  // Clear badge after 5 seconds for success/error states
  if (text !== '...') {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId });
    }, 5000);
  }
}
```

Write to `extension/background.js`.

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat: add background service worker with server communication"
```

---

### Task 4: Claude CLI Prompt Template

**Files:**
- Create: `server/prompt.txt`

- [ ] **Step 1: Write the prompt template**

```
You are summarizing an earnings call transcript. Produce a self-contained HTML file.

Structure the output as follows:

1. A header section with the company name, ticker (if available), quarter, and date.

2. A "Prepared Remarks" section summarizing management's opening statements:
   - Attribute remarks to each speaker (CEO, CFO, etc.)
   - Condense the content but preserve the speaker's tone, key phrases, and distinctive language
   - Capture all material numbers, guidance figures, and strategic points

3. A "Q&A" section preserving each question-answer exchange:
   - Show the analyst's name and firm
   - Summarize their question
   - Summarize management's response, preserving the flavor and key phrases of the original language
   - Keep each Q&A pair as a distinct block

Style requirements:
- Self-contained HTML with all CSS inline in a <style> tag in the <head>
- No external dependencies (no CDN links, no external fonts)
- Clean, readable typography: system font stack, ~60-70ch line width, comfortable line spacing
- Light background, dark text, subtle section dividers
- Responsive layout that reads well on any screen width

Output ONLY valid HTML. No markdown. No code fences. No explanation text. Start with <!DOCTYPE html>.
```

Write to `server/prompt.txt`.

- [ ] **Step 2: Commit**

```bash
git add server/prompt.txt
git commit -m "feat: add Claude CLI prompt template for transcript summarization"
```

---

### Task 5: Local Express Server

**Files:**
- Create: `server/server.js`

- [ ] **Step 1: Write server.js**

```javascript
const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const open = require('open');
const os = require('os');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = 3210;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const PROMPT_PATH = path.resolve(__dirname, 'prompt.txt');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// CORS for extension requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/summarize', async (req, res) => {
  const { transcript, company, quarter, year } = req.body;

  if (!transcript) {
    return res.status(400).json({ success: false, error: 'Missing transcript text' });
  }

  try {
    // Read prompt template
    const promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf-8');

    // Compose full prompt: template + transcript
    const fullPrompt = `${promptTemplate}\n\n---\n\nTRANSCRIPT:\n\n${transcript}`;

    // Write to temp file (transcripts can be too large for shell args)
    const tmpFile = path.join(os.tmpdir(), `bamsec-transcript-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, fullPrompt, 'utf-8');

    // Spawn Claude CLI
    const html = await new Promise((resolve, reject) => {
      const child = execFile('claude', ['-p', fs.readFileSync(tmpFile, 'utf-8')], {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000 // 5 minute timeout
      }, (error, stdout, stderr) => {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch (e) {}

        if (error) {
          reject(new Error(`Claude CLI failed: ${error.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });

    // Build filename
    const ticker = (company || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const q = quarter || 'QX';
    const y = year || new Date().getFullYear();
    const filename = `${ticker}-${q}-${y}.html`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    // Save HTML
    fs.writeFileSync(outputPath, html, 'utf-8');

    // Open in browser
    await open(outputPath);

    console.log(`Saved: ${outputPath}`);
    res.json({ success: true, path: outputPath, filename });

  } catch (error) {
    console.error('Summarization failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`BamSEC Summarizer server running at http://localhost:${PORT}`);
});
```

Write to `server/server.js`.

**Note on Claude CLI invocation:** The `-p` flag accepts the prompt as a string argument. For very large transcripts, this may hit OS argument length limits. If this happens during testing, switch to piping via stdin: `echo fullPrompt | claude -p -`. This is a known risk documented in the spec — test with a real transcript and adjust if needed.

- [ ] **Step 2: Test server starts**

Run: `cd server && node server.js`
Expected: `BamSEC Summarizer server running at http://localhost:3210`

- [ ] **Step 3: Test health endpoint**

Run: `curl http://localhost:3210/health`
Expected: `{"status":"ok"}`

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "feat: add Express server with /health and /summarize endpoints"
```

---

### Task 6: End-to-End Integration Test

**Files:**
- No new files — testing existing components together

- [ ] **Step 1: Start the server**

Run: `cd server && node server.js`
Expected: Server starts on port 3210.

- [ ] **Step 2: Load extension in Brave**

1. Open `brave://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `Reader/extension/` directory
Expected: Extension appears with icon in toolbar.

- [ ] **Step 3: Navigate to a BamSEC transcript**

Open: `https://www.bamsec.com/transcripts/c81fe194-11e5-42df-80a7-48b757993a0e` (SoFi Q4 2025)

- [ ] **Step 4: Click the extension toolbar button**

Click the extension icon in Brave's toolbar.
Expected:
1. Badge shows `...` (blue) while processing
2. Server logs show the request received
3. Claude CLI runs and produces HTML output
4. HTML file opens in a new browser tab
5. Badge shows `OK` (green)

- [ ] **Step 5: Verify HTML output**

Check `Reader/output/` for the generated file.
Verify:
- File exists with expected name pattern
- HTML is valid and self-contained
- Prepared remarks section is present with speaker attribution
- Q&A section shows analyst questions paired with management responses
- Styling is clean and readable

- [ ] **Step 6: Test error handling**

1. Stop the server, click extension → badge should show `OFF`
2. Navigate to a non-BamSEC page, click extension → badge should show `ERR`

- [ ] **Step 7: Commit any fixes from integration testing**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end integration testing"
```

---

### Task 7: Polish and Cleanup

**Files:**
- Possibly modify: `extension/content.js`, `server/server.js`, `server/prompt.txt`

- [ ] **Step 1: Review generated HTML quality**

Read the generated HTML summary. If the prompt needs tuning (e.g., summaries too long/short, missing tone preservation, poor formatting), adjust `server/prompt.txt`.

- [ ] **Step 2: Handle edge cases discovered during testing**

Fix any issues found:
- Transcript parsing edge cases (unusual speaker formats, missing sections)
- Server timeout for very long transcripts
- Large file handling

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: polish prompt and fix edge cases from testing"
```
