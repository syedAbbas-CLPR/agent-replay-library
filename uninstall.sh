#!/usr/bin/env bash
set -euo pipefail

LABEL="com.local.agent-replay-library"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/.local/share/agent-replay-library"
rm -f "$HOME/.local/bin/agent-replay-library" "$HOME/.local/bin/agent-replay-live" "$HOME/.local/bin/claude-replay-live" "$HOME/.local/bin/codex-replay-live"
printf '%s\n' "Agent Replay Library was removed. Session logs and browser notes were left untouched."
