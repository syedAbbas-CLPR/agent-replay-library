# Architecture

The LaunchAgent starts `src/server.mjs` through the copy installed in `~/.local/share/agent-replay-library`.

The server scans Claude and Codex JSONL storage, derives titles and project names from the first useful user message, and assigns each source file a stable identifier. Claude subagent logs are attached to their parent session and merged by timestamp before rendering.

`claude-replay` converts the selected JSONL stream into a self-contained HTML document. The server injects the session rail and live-update watcher into that document, so scrolling remains native and the library does not depend on nested browser frames.

Reader state and comments live in browser local storage under keys derived from the session identity. Export sends those annotations to the local server, which writes the replay, comments, manifest, and source transcripts into a temporary folder and returns a ZIP.

No remote service is required. The HTTP server listens only on `127.0.0.1`.
