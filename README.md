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
| `remember` / `recall` / `forget` | Save, search and delete memories |
| `run_command` | Any zsh command. **Always asks you first**, shows the exact command. 30s default timeout (max 300s). |

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
  index.ts          CLI / REPL
  agent.ts          agent loop (think → tool calls → repeat)
  llm.ts            LLM interface + Ollama backend
  config.ts
  memory/store.ts   SQLite memory
  prompts/system.ts
  tools/            one file per tool group; register in tools/index.ts
```

## Next

- Process manager (start/stop services, tail logs)
- Save conversation history
- Project scan / summary on startup
- Eval set of real questions to compare models
