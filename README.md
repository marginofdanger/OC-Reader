# OC Reader

OC Reader is a Brave/Chrome extension plus local Node.js server for turning long-form transcripts into clean, styled HTML reading pages.

It is a Codex-built fork of the original Reader project. It preserves the existing Claude workflow and adds a configurable **processing provider** so jobs can run through either:

- **Claude CLI** — the original `claude -p` pipeline.
- **Codex CLI** — a local `codex exec --ephemeral -` pipeline that can reuse your local Codex / ChatGPT sign-in.

## Supported Sources

- **BamSEC earnings call transcripts** — summarized into structured HTML with key takeaways, financial highlights, prepared remarks, and Q&A.
- **AlphaSense / AlphaSights / Tegus expert calls** — reformatted into investor-focused qualitative notes with expert metadata, key takeaways, topic summaries, and follow-up questions.
- **YouTube videos** — near-verbatim caption cleanup with punctuation, paragraphing, filler removal, question styling, deterministic chapter placement, and timestamp anchors.

All generated pages are written to `output/`, can be bookmarked, and appear on the shared status page at `http://localhost:3220/status`.

## Architecture

1. **Browser extension** (`extension/`) detects the current page, extracts transcript text and metadata, then posts to the local server.
2. **Node.js server** (`server/`) queues jobs, builds the source-specific prompt, sends it to the configured provider, validates the returned HTML/fragment, wraps or patches the result, and writes it to `output/`.
3. **Provider runner** in `server/server.js` chooses either Claude CLI or Codex CLI based on `server/settings.json` or the `/status` settings controls.

## Provider Configuration

The server settings support:

```json
{
  "ecVerbosity": 60,
  "exVerbosity": 30,
  "concurrency": 3,
  "provider": "claude",
  "model": "opus",
  "codexModel": "gpt-5.5"
}
```

- `provider`: `claude` or `codex`.
- `model`: Claude model name used by the Claude CLI path, e.g. `opus`, `sonnet`, `haiku`.
- `codexModel`: Codex model used by the Codex CLI path. Defaults to `gpt-5.5`; other status-page options include `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, and `gpt-5.3-codex-spark`.

Claude path:

```text
claude -p --output-format text --tools "" --model <model>
```

Codex path:

```text
codex exec --ephemeral --skip-git-repo-check [-m <codexModel>] -
```

Codex prompts are wrapped with an instruction telling Codex not to inspect files, run commands, or edit anything; it should behave as a transcript transformation engine and return only the requested output. Earnings and expert-call Codex jobs also receive a small Reader house-style overlay so they better match the terse, table-disciplined Claude Opus output.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /status` | Queue, active workers, provider/model settings, bookmarks, completed history |
| `GET /settings` / `POST /settings` | Server-side settings |
| `POST /summarize` | BamSEC earnings-call transcript |
| `POST /summarize-expert` | Expert-call transcript |
| `POST /summarize-youtube` | YouTube transcript segments |
| `GET /job/:id` | Poll async job status |
| `POST /bookmark` | Toggle bookmark |
| `GET /bookmarks` | Return bookmarks |
| `GET /bookmark/remove?filename=...` | Remove bookmark from status page |
| `POST /share` | Publish output HTML to configured share repo |
| `GET /output/<filename>.html` | Serve generated output |

## Key Files

| File | Description |
|------|-------------|
| `extension/background.js` | Site detection, script injection, YouTube transcript scraping, job polling |
| `extension/content.js` | BamSEC extraction |
| `extension/content-expert.js` | Expert transcript extraction |
| `extension/content-expert-meta.js` | Expert metadata extraction |
| `server/server.js` | Express server, queue, endpoints, provider runners, sharing/bookmarking |
| `server/youtube-helpers.js` | Pure YouTube helpers and renderer |
| `server/prompt.txt` | Earnings-call analytical/formatting instructions |
| `server/prompt-expert.txt` | Expert-call analytical/formatting instructions |
| `server/prompt-youtube.txt` | YouTube cleanup instructions |
| `server/style.css` | Shared Reader visual style |
| `server/earnings-style.css` | Earnings-call visual style |

## Setup

Install server dependencies:

```sh
cd server
npm install
```

For Claude processing, install and authenticate Claude CLI.

For Codex processing, install and authenticate Codex CLI:

```sh
npm i -g @openai/codex
codex
```

When prompted, sign in with ChatGPT or an API key. OC Reader can then reuse the local Codex CLI auth when `provider` is set to `codex`.

Start the server:

```sh
cd server
node server.js
```

Run tests:

```sh
cd server
npm test
```

## Notes

- The browser extension still talks to `http://localhost:3220`.
- `output/`, `server/settings.json`, logs, and installed dependencies are intentionally ignored by git.
- Codex CLI is supported as a local automation backend, but the OpenAI API remains the cleaner option for production-grade model control, retries, and structured output.



