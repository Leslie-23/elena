<p align="center"><img src="assets/icon.svg" width="112" alt="Elena icon: a beige e: on terminal green"></p>

# Elena

A local-first developer assistant. The LLM runs on your Mac through Ollama. Elena gives it a small set of typed, sandboxed tools.

## Install

macOS or Linux, with git and Node 22+. One line:

```bash
curl -fsSL https://raw.githubusercontent.com/Leslie-23/elena/main/install.sh | bash
```

Or from a clone:

```bash
git clone https://github.com/Leslie-23/elena.git && cd elena && ./install.sh
```

The installer:

1. checks git and Node 22+;
2. clones Elena into `~/.elena/app` (or uses the clone you ran it from) and builds it;
3. puts an `elena` command in `~/.local/bin`, the same place Claude Code installs `claude`, and adds that folder to your PATH in `~/.zshrc` / `~/.bashrc` if it isn't there already;
4. runs `elena setup`, which checks Ollama and a model (suggesting one that fits your RAM) and offers to connect Elena to Claude Code and Codex.

Then type `elena` in any project folder. Re-running the installer is safe. `elena update` pulls the latest version and rebuilds. To uninstall, delete `~/.local/bin/elena` and `~/.elena` (which also deletes Elena's memory and history).

Installer options: `ELENA_DIR` (where the app goes), `ELENA_BIN_DIR` (where the command goes), `ELENA_SKIP_PATH=1`, `ELENA_SKIP_SETUP=1`.

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
elena setup          # check this machine; connect Elena to Claude Code / Codex
elena mcp [dir]      # run as an MCP server (Claude Code and Codex launch this)
elena update         # update to the latest version
elena --help         # usage; elena --version for the version
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
| `port_owner` | What's listening on one TCP port |
| `calculate` | Exact arithmetic (a parser, not eval) |
| `listening_ports` | Every listening TCP port with its process, pid, localhost-only or not, and what it probably is |
| `start_process` | Start a server/watcher in the background. **Asks you first.** Reports when it's up on its port or crashes. |
| `list_processes` / `process_logs` / `stop_process` | Manage what Elena started |
| `scan_project` | Scan the project and refresh Elena's summary |
| `delegate` | Hand an investigation to a read-only subagent, in the foreground or background |
| `ask_expert` | Hand a heavy task to Claude Code or Codex (asks first) |
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
| `/claude <task>`, `/codex <task>` | Hand a heavy task to a cloud agent, read-only, in the background |
| `/claude edit <task>`, `/codex edit <task>` | Same, but it may edit files (always asks first) |
| `/review claude`, `/review codex` | Review uncommitted changes with a cloud agent |
| `/experts` | Which cloud agents are installed and signed in |
| `/bg <task>` | Send a subagent to investigate in the background; keep chatting |
| `/tasks`, `/result <n>`, `/cancel <n>` | Background tasks, a finished task's report, stop one |
| `/resume` | Recent conversations in this project; `/resume <n>` or `/resume last` continues one |
| `/new` | Start a fresh conversation |
| `/context` | What's filling the context window, by part |
| `/compact` | Trim old tool output and summarise older messages |
| `/reload` | Restart with the latest code, keeping the conversation |
| `/mac` | Mac health |
| `/memories`, `/forget <id>` | See and delete memories |
| `exit` | Quit. Stops any processes Elena started. |

Background events (scan progress, a server coming up, a crash) are printed above the prompt without losing what you're typing.

Type `/` to see every command with a short description; keep typing to narrow the list. The first match is shown in grey after the cursor, and → or Tab takes it. Arguments complete too: `/model ` lists your models, `/logs ` and `/stop ` your processes, `/review ` offers claude and codex.

The prompt always shows how full the context window is (`▰▰▱▱▱▱▱▱▱▱ 20% you ›`); the same bar is on the status line while Elena works, and `/context` has the breakdown.

While Elena works, a status line says what she's doing and for how long (`⠹ Reading your message… 3s`, `⠼ Searching for “calculateFare”…`, `⠧ Thinking… 14s`). It clears when her answer starts, pauses for approval prompts, and is left out when output isn't a terminal.

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

## Claude Code and Codex

For work too big for a local model (large multi-file changes, hard debugging, deep reviews), Elena can hand the task to **Claude Code** (`claude -p`) or **Codex** (`codex exec`), if installed and signed in (`/experts` shows which, and what to run if not).

- **You decide what leaves the Mac.** When Elena wants to escalate, she asks first, showing the service, the task and what it may do. Typing `/claude <task>` yourself counts as asking for read-only work; edit mode always asks.
- **Read-only by default.** Claude gets only Read, Grep and Glob. Codex runs with `--sandbox read-only`.
- **Edit mode:** Claude also gets Edit and Write, but never a shell. Codex uses `--sandbox workspace-write`: it may run commands, but can only write inside the project.
- Runs in the background with live steps (`[#1] Claude Code › Read api/src/server.js`), a notification when done, and the report handed to Elena with your next message (up to 4,000 characters; `/result <n>` shows all of it).
- `/cancel <n>` stops a run, and quitting Elena stops them all, so nothing keeps running on your quota. Runs time out after 15 minutes.
- MCP servers and claude.ai connectors are switched off for these runs (`--strict-mcp-config`). In testing that cut a small question from ~$0.46 to ~$0.01 API-equivalent. On a Claude plan this is usage against your plan, not a charge.

## Claude Code and Codex using Elena (MCP)

The other direction: `elena mcp` runs Elena as an MCP server, so Claude Code, Codex or any MCP client can hand her work. `elena setup` registers her; to do it by hand:

```bash
claude mcp add --scope user elena -- "$(which node)" /path/to/elena/dist/index.js mcp
codex mcp add elena -- "$(which node)" /path/to/elena/dist/index.js mcp
```

Absolute paths are used because agents don't always share your shell's PATH (nvm, for example).

| Tool | For the calling agent |
|---|---|
| `elena_ask` | Hand Elena a small task to do locally with read-only tools. Free and private, but slower and weaker than Claude. Optional background mode. |
| `elena_review` | A free second-opinion review of uncommitted changes by the local model (background by default) |
| `elena_task` | Status and result of a background `elena_ask` / `elena_review` |
| `elena_memory` | Recall, list or add the user's saved notes (shared with Elena in the terminal) |
| `elena_project` | The project scan summary (saved, or `refresh: true`) |
| `elena_process` | Start dev servers with port readiness, read logs, list, stop |
| `elena_mac` | Mac status, open apps/URLs, and a notification to the user when the agent finishes |

- The project is the client's workspace (from MCP roots, else the folder it launched Elena in), or `project_dir` on any call.
- The client (e.g. Claude Code's permission prompt) approves each tool call. When Elena works through a whole task for the client (`elena_ask`, `elena_review`), nobody can approve her individual steps, so she only gets read-only tools.
- Processes started this way stop when the client's session ends.
- Elena in the terminal and Elena as an MCP server share `~/.elena/elena.db` safely (SQLite WAL mode).

## How smart is Elena? (`npm run eval`)

`evals/` builds a small ride-booking project with known answers, a decoy file, a prompt injection and three planted bugs, then asks the same 10 questions (18 checks) of each runner and scores the answers automatically:

```bash
npm run eval                                 # elena, elena-think, claude
npm run eval -- --runners elena --only fare  # a subset
```

Results on an M1 Pro (32 GB), qwen3:14b:

| Runner | Score | Avg time | Cost |
|---|---|---|---|
| Claude Code (read-only) | 18/18 (100%) | 16s | ~$0.31 for the run |
| Elena, first version | 7/18 (39%) | 19s | free |
| Elena with thinking on everything, first version | 9/18 (50%) | 121s | free |
| **Elena now** | **17/18 (94%)** | 23s | free |

What moved Elena from 39% to 94% was behaviour, not the model: a file list in her instructions; rules to look at the code before answering, to retry failed searches with looser patterns, to prefer source over tests, and to answer "how do I…" without running it; a `calculate` tool; a hint when a search finds nothing; and a nudge when she says "let me check…" without doing it.

The remaining miss: asked what `calculateFare(0.5, 1)` returns, she computes 6.55 and skips the `minimum` clamp. Tracing every branch of code is a real limit of a 14B model. Claude is also far better on open-ended work (design, large refactors), which this suite doesn't measure; that's what `/claude` is for.

## Context window and updates

- **Live view:** every reply ends with a meter, e.g. `(4.2s · qwen3:14b · context ▰▰▰▱▱▱▱▱▱▱ 31% of 16k)`, green, then yellow past 60% and red past 80%. The count is Ollama's own (the full prompt, cached or not), estimated from the measured tokens-per-character between replies. `/context` breaks it down: instructions, tool definitions (the 24 tools alone are about 2.6k tokens), your messages, Elena's replies and tool results.
- **Compaction:** at 75% full (`ELENA_COMPACT_AT`), Elena first shortens tool output older than the last two turns (she already used it), then, only if that isn't enough and there's enough old conversation for it to pay off, replaces the older messages with a short summary that keeps decisions, facts, paths, ports, errors, open tasks and your preferences. A summary that wouldn't be meaningfully shorter is discarded, and an earlier summary's facts are carried into the next one. `/compact` does it on demand. This matters: if a prompt overflows, Ollama silently drops its start, which is Elena's instructions. The saved conversation in `~/.elena/elena.db` keeps everything.
- **Updates without losing your place:** when Elena's code changes on disk (after `elena update` or a rebuild), she says so; `/reload` restarts her in place with the new code and carries the conversation over. Running servers and background tasks are stopped, after asking.

## Conversations

Every conversation is saved to `~/.elena/elena.db`, per project. `/resume` lists the last 10 and `/resume last` picks up the most recent one, showing where you left off. Long conversations load only the latest messages that fit the model's context (about 34k characters with the default `ELENA_NUM_CTX`), always starting at one of your messages.

## macOS

- The startup screen shows battery, free disk, memory and CPU load, in yellow if something needs attention.
- When the terminal isn't the front app, Elena sends a macOS notification when she needs your approval, when a server comes up or crashes, when a model download finishes, and when an answer took more than 20 seconds. Nothing is sent while you're watching the terminal.
- Notifications come from **Elena.app** (`~/.elena/Elena.app`), a tiny windowless app built from `native/notify.swift` the first time it's needed, so they show Elena's name and `e:` icon instead of Script Editor's. macOS asks once whether Elena may send notifications. Building it needs Swift (Xcode or `xcode-select --install`); without it, or if you turn Elena's notifications off in System Settings, Elena falls back to plain `osascript` notifications.
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

## Brand

`assets/icon.svg` (green, the main icon), `assets/icon-light.svg` (beige, for light backgrounds), `assets/icon-macos.svg` (on Apple's icon grid), PNGs from 16 to 1024px in `assets/png/`, and `assets/elena.icns`. In the terminal Elena uses your theme's own green plus beige (`src/brand.ts`), and the startup banner draws the same `e:` in half-block characters.

## Layout

```
src/
  index.ts          CLI / REPL, slash commands
  ui.ts             terminal output that works alongside background tasks
  brand.ts          colours and the e: banner
  review.ts         builds the review prompt from git
  models.ts         per-task model choice and task classifier
  conversations.ts  history trimming for /resume
  mac.ts            macOS status, notifications, volume, app names
  notifier.ts       builds Elena.app and posts notifications through it
  subagents.ts      read-only subagents and the background task list
  experts.ts        running Claude Code and Codex headless
  escalate.ts       choosing an expert, approval, background tracking
  mcp.ts            Elena as an MCP server for Claude Code, Codex and others
  setup.ts          `elena setup`: machine checks and MCP registration
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
