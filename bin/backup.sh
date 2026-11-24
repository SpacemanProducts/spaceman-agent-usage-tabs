#!/usr/bin/env bash
# Back up the plugin folder and Omarchy's shell.json before editing, into a
# durable place (not /tmp, which vanishes on reboot):
#   ${XDG_DATA_HOME:-~/.local/share}/agent-usage-tabs-backups/<id>-<timestamp>.tar.gz
# Keeps the newest KEEP backups (default 10). Read-only: it only creates the archive.
# PLUGIN_DIR overrides what gets backed up (tests); SHELL_JSON path follows XDG_CONFIG_HOME.
set -euo pipefail

HERE=$(dirname "$(readlink -f "$0")")
ID="spaceman.agent-usage-tabs"
PLUGIN_DIR="${PLUGIN_DIR:-$(dirname "$(dirname "$HERE")")/$ID}"
MEMBER=$(basename "$PLUGIN_DIR")
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/agent-usage-tabs-backups"
KEEP="${BACKUP_KEEP:-10}"
OUT="$DEST/${ID}-$(date +%Y%m%d-%H%M%S).tar.gz"
SHELL_JSON="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/shell.json"

mkdir -p "$DEST"

# Members: <plugin>/... (minus .git/node_modules), plus shell.json at top level when present.
args=(-C "$(dirname "$PLUGIN_DIR")" --exclude="$MEMBER/.git" --exclude="$MEMBER/node_modules" "$MEMBER")
[[ -f $SHELL_JSON ]] && args+=(-C "$(dirname "$SHELL_JSON")" shell.json)
tar -czf "$OUT" "${args[@]}"

# Same-second reruns overwrite the same name — fine for a backup.

ls -1t "$DEST"/${ID}-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done

echo "$OUT"
