#!/usr/bin/env bash
# Install Elena so that typing `elena` works in any terminal.
#
#   From a clone:   ./install.sh
#   From anywhere:  curl -fsSL https://raw.githubusercontent.com/Leslie-23/elena/main/install.sh | bash
#
# Options (environment variables):
#   ELENA_DIR       where the app lives when cloning   (default: ~/.elena/app)
#   ELENA_BIN_DIR   where the `elena` command goes     (default: ~/.local/bin, same as Claude Code)
#   ELENA_REPO      git URL to clone                   (default: the GitHub repo)
#   ELENA_SKIP_PATH=1   don't touch shell startup files
#   ELENA_SKIP_SETUP=1  don't run `elena setup` at the end
#
# Safe to re-run: it updates the app and rewrites the launcher.
set -euo pipefail

REPO="${ELENA_REPO:-https://github.com/Leslie-23/elena.git}"
BIN_DIR="${ELENA_BIN_DIR:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

bold "Installing Elena"

# 1. Requirements: git and Node 22+ (built-in SQLite).
command -v git >/dev/null || fail "git is required (macOS: xcode-select --install)"
command -v node >/dev/null || fail "Node.js 22+ is required: https://nodejs.org, or: nvm install 22"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $(node -v) is too old; Elena needs 22+ (nvm install 22)"
ok "Node $(node -v)"

# 2. The app: this checkout if we're run from one, otherwise clone (or update) into ELENA_DIR.
# When piped from curl there's no script file, so never guess from the current folder.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": "elena"' "$SCRIPT_DIR/package.json"; then
  APP_DIR="$SCRIPT_DIR"
  ok "Using this checkout: $APP_DIR"
else
  APP_DIR="${ELENA_DIR:-$HOME/.elena/app}"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only --quiet
    ok "Updated $APP_DIR"
  else
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --depth 1 --quiet "$REPO" "$APP_DIR"
    ok "Cloned into $APP_DIR"
  fi
fi

# 3. Dependencies and build (the prepare script compiles TypeScript).
(cd "$APP_DIR" && npm install --no-fund --no-audit --loglevel=error)
[ -f "$APP_DIR/dist/index.js" ] || fail "Build failed: $APP_DIR/dist/index.js is missing"
ok "Built"

# 4. The `elena` command. A small launcher rather than a symlink, so it keeps working
#    if your default Node changes (it prefers the Node it was installed with, then any node on PATH).
mkdir -p "$BIN_DIR"
NODE_BIN="$(command -v node)"
cat > "$BIN_DIR/elena" <<EOF
#!/usr/bin/env bash
# Elena launcher, written by install.sh. Re-run the installer to update it.
NODE="$NODE_BIN"
[ -x "\$NODE" ] || NODE="\$(command -v node)"
export ELENA_APP_DIR="$APP_DIR"
exec "\$NODE" "$APP_DIR/dist/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/elena"
ok "Installed the elena command: $BIN_DIR/elena"

# 5. Make sure BIN_DIR is on PATH for new terminals.
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on your PATH" ;;
  *)
    if [ "${ELENA_SKIP_PATH:-}" = "1" ]; then
      printf '  ! %s is not on your PATH (skipped, ELENA_SKIP_PATH=1)\n' "$BIN_DIR"
    else
      case "${SHELL:-}" in
        */zsh) RC="$HOME/.zshrc" ;;
        */bash) RC="$HOME/.bashrc"; [ "$(uname)" = "Darwin" ] && RC="$HOME/.bash_profile" ;;
        *) RC="$HOME/.profile" ;;
      esac
      LINE="export PATH=\"$BIN_DIR:\$PATH\"  # added by Elena's installer"
      grep -qsF "$LINE" "$RC" || printf '\n%s\n' "$LINE" >> "$RC"
      ok "Added $BIN_DIR to PATH in $RC (open a new terminal, or run: source $RC)"
    fi
    ;;
esac

# 6. Check Ollama and a model, and offer to connect Claude Code / Codex.
if [ "${ELENA_SKIP_SETUP:-}" != "1" ] && [ -r /dev/tty ]; then
  "$BIN_DIR/elena" setup < /dev/tty
else
  printf '\nRun `elena setup` to check Ollama and connect Claude Code / Codex.\n'
fi

bold "Done. Type 'elena' in any project folder to start."
