#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Agent Replay Library"
LABEL="com.local.agent-replay-library"
PORT="${AGENT_REPLAY_PORT:-7331}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

say() { printf '%s\n' "$*"; }
run() {
  if (( DRY_RUN )); then printf 'DRY RUN  '; printf '%q ' "$@"; printf '\n';
  else "$@"; fi
}

[[ "$(uname -s)" == "Darwin" ]] || { say "$APP_NAME currently supports macOS."; exit 1; }
command -v node >/dev/null || { say "Node.js 18 or newer is required."; exit 1; }
command -v npm >/dev/null || { say "npm is required."; exit 1; }

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 18 )) || { say "Node.js 18 or newer is required."; exit 1; }

say "Installing claude-replay 0.11.0"
run npm install -g claude-replay@0.11.0

NPM_ROOT="$(npm root -g)"
PACKAGE_ROOT="$NPM_ROOT/claude-replay"
[[ -d "$PACKAGE_ROOT" || $DRY_RUN -eq 1 ]] || { say "Could not locate the global claude-replay package."; exit 1; }

say "Installing Agent Replay Library"
run mkdir -p "$HOME/.local/share/agent-replay-library" "$HOME/.local/bin" "$HOME/.config/claude-replay" "$HOME/Library/LaunchAgents"
run cp "$ROOT/src/server.mjs" "$HOME/.local/share/agent-replay-library/server.mjs"
run cp "$ROOT/config/high-contrast.json" "$HOME/.config/claude-replay/high-contrast.json"
run cp "$ROOT/src/overrides/player.html" "$PACKAGE_ROOT/template/player.html"
run cp "$ROOT/src/overrides/codex.mjs" "$PACKAGE_ROOT/src/formats/codex.mjs"
run cp "$ROOT/src/overrides/claude-replay.mjs" "$PACKAGE_ROOT/bin/claude-replay.mjs"
run cp "$ROOT/bin/agent-replay-live" "$HOME/.local/bin/agent-replay-live"
run cp "$ROOT/bin/agent-replay-library" "$HOME/.local/bin/agent-replay-library"
run chmod 755 "$HOME/.local/share/agent-replay-library/server.mjs" "$HOME/.local/bin/agent-replay-live" "$HOME/.local/bin/agent-replay-library"
run ln -sf "$HOME/.local/bin/agent-replay-live" "$HOME/.local/bin/claude-replay-live"
run ln -sf "$HOME/.local/bin/agent-replay-live" "$HOME/.local/bin/codex-replay-live"

NODE_PATH="$(command -v node)"
REPLAY_PATH="$(command -v claude-replay 2>/dev/null || true)"
BIN_PATH="$(dirname "$NODE_PATH"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
[[ -z "$REPLAY_PATH" ]] || BIN_PATH="$(dirname "$REPLAY_PATH"):$BIN_PATH"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if (( DRY_RUN )); then
  say "DRY RUN  write $PLIST"
else
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_PATH</string>
    <string>$HOME/.local/share/agent-replay-library/server.mjs</string>
    <string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BIN_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/tmp/agent-replay-library.log</string>
  <key>StandardErrorPath</key><string>/tmp/agent-replay-library.err</string>
</dict></plist>
EOF
fi

UID_VALUE="$(id -u)"
run launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || true
run launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
run launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

say ""
say "$APP_NAME is running at http://127.0.0.1:$PORT"
if (( ! DRY_RUN )); then open "http://127.0.0.1:$PORT"; fi
