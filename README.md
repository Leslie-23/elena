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
| `ELENA_DEBUG` | unset | `1` prints tool output previews |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |

## Tools

| Tool | What it does |
|---|---|
| `read_file` | Read a file (or line range) inside the project |
| `list_directory` | List a directory, skipping `node_modules`, `.git`, build output |
| `search` | Regex search with `rg` (falls back to `grep`) |
| `git_status` / `git_diff` / `git_log` | Read-only git |
| `port_owner` | What's listening on a TCP port |
| `run_command` | Any zsh command. **Always asks you first**, shows the exact command. 30s default timeout (max 300s). |

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
  prompts/system.ts
  tools/            one file per tool group; register in tools/index.ts
```

## Next

- Process manager (start/stop services, tail logs)
- SQLite memory (`node:sqlite`)
- Project scan / summary on startup
- Eval set of real questions to compare models
