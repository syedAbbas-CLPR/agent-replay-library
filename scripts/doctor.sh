#!/usr/bin/env bash
set -euo pipefail

LABEL="com.local.agent-replay-library"
printf 'Node:          %s\n' "$(node --version 2>/dev/null || echo missing)"
printf 'npm:           %s\n' "$(npm --version 2>/dev/null || echo missing)"
printf 'claude-replay: %s\n' "$(command -v claude-replay 2>/dev/null || echo missing)"
printf 'Claude logs:   %s\n' "$(find "$HOME/.claude/projects" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
printf 'Codex logs:    %s\n' "$(find "$HOME/.codex/sessions" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state =|pid =' || printf 'Service:       not loaded\n'
printf 'URL:           http://127.0.0.1:%s\n' "${AGENT_REPLAY_PORT:-7331}"
