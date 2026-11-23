#!/bin/bash
# Shared by squad.sh (the CS button) and agent-here.sh (the header terminal button): the folder picker's list of recent
# repos, the last folder used, and making a new project. Source it; it only defines variables and functions.
state="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agent-usage-tabs/squad-dir"
is_repo() { [[ -n $1 ]] && git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
# Squad branches from HEAD, so a fresh repo needs a first commit.
init_repo() { git -C "$1" init -q && git -C "$1" commit -q --allow-empty -m "Initial commit"; }

# The picker has three things: recent git repos, "Create a new project", and "Browse" for anywhere else.
# Recent = repos you picked before, plus the git repos in ~/Projects, newest first. Backups and desktop files are
# hidden (hidden folders, *backup*/*.bak*, date-stamped or before-/pre- copies, *.desktop, Desktop).
PROJECTS="${SQUAD_PROJECTS:-$HOME/Projects}"
recent="$(dirname "$state")/squad-recent"
is_hidden() { case "/$1/" in */.*|*backup*|*Backup*|*.bak*|*-before-*|*-pre[a-z]*/|*-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*|*.desktop/|*/Desktop/*) return 0 ;; esac; return 1; }
nice() { local p=$1; [[ $p == "$PROJECTS"/* ]] && echo "${p#"$PROJECTS"/}" || echo "${p/#$HOME/\~}"; }
recent_repos() {
  { [[ -f $recent ]] && cat "$recent"
    find "$PROJECTS" -maxdepth 3 -name .git -prune -printf '%T@ %h\n' 2>/dev/null | sort -nr | cut -d' ' -f2-
  } | awk 'NF && !seen[$0]++' | while IFS= read -r d; do
    is_repo "$d" && ! is_hidden "$(nice "$d")" && echo "$d"
  done | head -8
}
remember() { mkdir -p "$(dirname "$recent")"; { echo "$1"; grep -vxF "$1" "$recent" 2>/dev/null; } | head -8 >"$recent.new" && mv "$recent.new" "$recent"; }
