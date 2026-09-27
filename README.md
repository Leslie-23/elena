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
| `ELENA_MODEL` | unset | Force one model for every task (overrides `/model`) |
| `ELENA_NUM_CTX` | `16384` | Context window sent to Ollama |
| `ELENA_MAX_STEPS` | `12` | Tool-call rounds per question |
| `ELENA_THINK` | unset | `1` turns on Qwen3 reasoning mode (smarter, ~7x slower) |
| `ELENA_REVIEW_THINK` | on | `0` turns off thinking mode for reviews (faster, misses more) |
| `ELENA_REVIEW_MAX_CHARS` | `16000` | Max diff size sent for a review |
| `ELENA_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded between questions |
| `ELENA_MAX_TOOL_OUTPUT` | `4000` | Characters of tool output sent back to the model |
| `ELENA_DEBUG` | unset | `1` prints tool output previews |
| `ELENA_HOME` | `~/.elena` | Where the memory database (`elena.db`) lives |
| `ELENA_NOTIFY` | on | `0` turns off macOS notifications |
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
| `delegate` | Hand an investigation to a read-only subagent, in the foreground or background |
| `mac_open` | Open an app ("vscode", "chrome"), a URL (`localhost:6969/docs`) or a project file/folder. External websites ask first. |
| `mac_status` | Battery, disk, memory, CPU load, volume, uptime, front app |
| `mac_control` | Volume, mute/unmute, screenshot to the Desktop, lock screen (asks first) |
| `clipboard` | Copy text; reading the clipboard asks first |
| `remember` / `recall` / `forget` | Save, search and delete memories |
| `run_command` | Any zsh command. **Always asks you first**, shows the exact command. 30s default timeout (max 300s). |

## Commands (inside Elena)

| Command | |
|---|---|
| `/scan` or "scan the project" | Scan in the background; keep chatting while it runs |
| `/project` | Show the saved project summary |
| `/review` or "review my changes" | Review uncommitted changes |
| `/model` | Installed models, and which one each task uses |
| `/model <name>` / `/model <task> <name>` | Use a model for everything, or for one task |
| `/model auto` | Let Elena choose per task again |
| `/pull <name>` | Download a model in the background, with progress |
| `/ps` | Background processes Elena started |
| `/logs <name> [n]` | Last n lines of a process's output |
| `/stop <name>` | Stop a process |
| `/bg <task>` | Send a subagent to investigate in the background; keep chatting |
| `/tasks`, `/result <n>` | Background tasks, and a finished task's report |
| `/resume` | Recent conversations in this project; `/resume <n>` or `/resume last` continues one |
| `/new` | Start a fresh conversation |
| `/mac` | Mac health |
| `/memories`, `/forget <id>` | See and delete memories |
| `exit` | Quit. Stops any processes Elena started. |

Background events (scan progress, a server coming up, a crash) are printed above the prompt without losing what you're typing.

## Models

Elena sorts each message into a task, with no model call, and uses the best installed model for it:

| Task | Used for | Preferred models, best first |
|---|---|---|
| `chat` | questions, git, ports, processes | qwen3:30b, qwen3:14b, gpt-oss:20b, qwen3:8b, llama3.1:8b, qwen3:4b |
| `code` | explaining, debugging, writing code | qwen3-coder:30b, qwen3:30b, devstral:24b, qwen2.5-coder:14b, qwen3:14b, qwen3:8b |
| `review` | `/review` | qwen3:30b, gpt-oss:20b, qwen3:14b, qwen3-coder:30b, qwen3:8b (thinking-capable first) |

- Only installed models that support tool calling are used; models too big for your RAM are skipped.
- If a better model isn't installed, Elena uses the best one you have and suggests `/pull <name>` once per session. She never downloads on her own.
- Short follow-ups ("and line 40?") stay on the previous model, so it isn't swapped mid-thread. Switching models takes a few seconds to load.
- Choices made with `/model` are saved in `~/.elena/elena.db`.
- Override the preference lists in `~/.elena/models.json`, e.g. `{"code": ["devstral:24b", "qwen3:14b"]}`.
- At startup, and after a scan, the chat model reads Elena's instructions in the background (~14s), so the first reply takes under a second instead.

## Subagents

A subagent is a separate, short-lived Elena with its own context and **read-only** tools: files, search, git, ports, process logs, Mac status and memory search. It can't run commands, start processes, change anything or ask you questions. It returns a short report with file:line evidence.

- **Why:** the model's context is small (16k tokens) and reading input is slow (~120 tokens/s), so letting a subagent read ten files and hand back a paragraph keeps Elena's own conversation short and fast.
- **Foreground:** Elena calls `delegate` herself for digging-heavy questions (or when you say "use a subagent to…"), and uses the report in her answer.
- **Background:** `/bg <task>` (or Elena with `background: true`) runs it while you keep chatting. Its tool calls show as `[#1] → …` lines, you get a message (and a macOS notification if you're elsewhere) when it's done, `/result <n>` shows the report, and Elena gets it with your next message.
- At most 2 run in the background at once. They share the GPU with the main chat; in testing a quick answer took 2.4s instead of ~0.5s while one was running.
- Subagents can't start subagents.

## Conversations

Every conversation is saved to `~/.elena/elena.db`, per project. `/resume` lists the last 10 and `/resume last` picks up the most recent one, showing where you left off. Long conversations load only the latest messages that fit the model's context (about 34k characters with the default `ELENA_NUM_CTX`), always starting at one of your messages.

## macOS

- The startup screen shows battery, free disk, memory and CPU load, in yellow if something needs attention.
- When the terminal isn't the front app, Elena sends a macOS notification when she needs your approval, when a server comes up or crashes, when a model download finishes, and when an answer took more than 20 seconds. Nothing is sent while you're watching the terminal.
- Screenshots need Screen Recording permission for your terminal (System Settings → Privacy & Security).

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
  models.ts         per-task model choice and task classifier
  conversations.ts  history trimming for /resume
  mac.ts            macOS status, notifications, volume, app names
  subagents.ts      read-only subagents, foreground and background
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

- `elena dev`: start a project's services from its scan in one go
- Eval set of real questions to compare models
