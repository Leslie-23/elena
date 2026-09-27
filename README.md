# Elena

A local-first developer assistant. The LLM runs on your Mac through Ollama. Elena gives it a small set of typed, sandboxed tools.

## Setup

```bash
brew install ollama ripgrep
brew services start ollama
ollama pull qwen3:14b      # default model; fits comfortably in 32GB

npm install
npm run dev -- ~/Projects/Transport-For-Ghana
```

From your shell:

```bash
elena [dir]          # chat
elena review [dir]   # review uncommitted changes and exit
elena scan [dir]     # scan the project, print the summary and exit
```

Install `elena` as a global command:

```bash
npm run build && npm link
elena ~/Projects/Transport-For-Ghana
```

## Config (env vars)

| Variable | Default | |
|---|---|---|
| `ELENA_MODEL` | `qwen3:14b` | Any Ollama model with tool support |
| `ELENA_NUM_CTX` | `16384` | Context window sent to Ollama |
| `ELENA_MAX_STEPS` | `12` | Tool-call rounds per question |
| `ELENA_THINK` | unset | `1` turns on Qwen3 reasoning mode (smarter, ~7x slower) |
| `ELENA_REVIEW_THINK` | on | `0` turns off thinking mode for reviews (faster, misses more) |
| `ELENA_REVIEW_MAX_CHARS` | `16000` | Max diff size sent for a review |
| `ELENA_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded between questions |
| `ELENA_MAX_TOOL_OUTPUT` | `4000` | Characters of tool output sent back to the model |
| `ELENA_DEBUG` | unset | `1` prints tool output previews |
| `ELENA_HOME` | `~/.elena` | Where the memory database (`elena.db`) lives |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |

## Tools

| Tool | What it does |
|---|---|
| `read_file` | Read a file (or line range) inside the project |
| `list_directory` | List a directory, skipping `node_modules`, `.git`, build output |
| `search` | Regex search with `rg` (falls back to `grep`) |
| `git_status` / `git_diff` / `git_log` | Read-only git |
| `port_owner` | What's listening on a TCP port |
| `start_process` | Start a server/watcher in the background. **Asks you first.** Reports when it's up on its port or crashes. |
| `list_processes` / `process_logs` / `stop_process` | Manage what Elena started |
| `scan_project` | Scan the project and refresh Elena's summary |
| `remember` / `recall` / `forget` | Save, search and delete memories |
| `run_command` | Any zsh command. **Always asks you first**, shows the exact command. 30s default timeout (max 300s). |

## Commands (inside Elena)

| Command | |
|---|---|
| `/scan` or "scan the project" | Scan in the background; keep chatting while it runs |
| `/project` | Show the saved project summary |
| `/review` or "review my changes" | Review uncommitted changes |
| `/ps` | Background processes Elena started |
| `/logs <name> [n]` | Last n lines of a process's output |
| `/stop <name>` | Stop a process |
| `/memories`, `/forget <id>` | See and delete memories |
| `exit` | Quit. Stops any processes Elena started. |

Background events (scan progress, a server coming up, a crash) are printed above the prompt without losing what you're typing.

## Project scan

Reads manifests (`package.json`, `pyproject.toml`, `go.mod`, `Podfile`, Docker files and more, up to 3 levels deep, skipping `node_modules` and build folders), npm scripts, ports (from `.env.example`, scripts and `listen(...)`/`PORT = ...` in source), git branch and status, the README intro and the top-level layout. No model calls; typically under a second. The summary is saved per project and loaded into Elena's instructions at startup.

## Review

Collects staged, unstaged and small untracked files into one prompt (whole files, up to `ELENA_REVIEW_MAX_CHARS`; anything left out is listed). Uses thinking mode by default: on a test repo with three planted bugs it found all three in ~57s, versus one or two in ~31s without.

## Processes

Each process runs in its own process group, so stopping it also stops whatever it spawned. Output is kept in memory (last 1000 lines) and appended to `~/.elena/logs/<project>/<name>.log`. Elena refuses to start something on a port that's already taken.

## Memory

Elena keeps notes in SQLite at `~/.elena/elena.db` (Node's built-in `node:sqlite`, nothing to install). Each note is either **global** (about you or your Mac) or tied to **one project**. When Elena starts, the latest 50 notes for global plus the current project are loaded into her instructions; `recall` searches every project.

```
you › Remember the Tap n Go API runs on port 6969.
  💾 Saved #1 [this project] The Tap n Go API runs on port 6969.
```

In the REPL:

| Command | |
|---|---|
| `/memories` | List what Elena remembers here |
| `/forget <id>` | Delete one |
| `/help` | Commands |

Memories are presented to the model as background notes, not instructions, and she is told never to save something just because a file says so.

## Safety model

- No shell, except `run_command`, which never runs without your approval. Other tools call binaries with `execFile` and argv arrays, so `;`, `&&` and `$()` do nothing.
- File access is limited to the project root; symlinks are resolved before checking.
- Reading `.env`, keys and similar files asks you first.
- Every command has a timeout and output cap. `run_command` kills the whole process group on timeout, so nothing is left running; long output is trimmed before it reaches the model.
- Tools marked `requiresConfirmation` are gated in the agent loop (in code, not in the prompt).

## Layout

```
src/
  index.ts          CLI / REPL, slash commands
  ui.ts             terminal output that works alongside background tasks
  review.ts         builds the review prompt from git
  processes.ts      background process manager
  project/scan.ts   project scanner
  agent.ts          agent loop (think → tool calls → repeat)
  llm.ts            LLM interface + Ollama backend
  config.ts
  memory/store.ts   SQLite memory
  prompts/system.ts
  tools/            one file per tool group; register in tools/index.ts
```

## Next

- Save conversation history
- `elena dev`: start a project's services from its scan in one go
- Eval set of real questions to compare models
