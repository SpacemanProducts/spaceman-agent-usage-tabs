#!/bin/bash
# The header terminal button: start Omarchy's default agent in a folder picked in the panel.
# The panel runs it inside a terminal (omarchy-launch-tui --app-id=org.omarchy.agent, the stock agent window, tiled).
# Environment: AGENT_DIR = start in this folder; AGENT_NEW = create this project in ~/Projects first (git set up).
# The folder list is the same one the CS button uses (bin/folders.sh): a git repo opened here becomes the "last one" there too.
# The bar's right-click and the keyboard shortcut don't come here: they run omarchy-agent straight away, with no picker.
HERE=$(dirname "$(readlink -f "$0")")
export PATH="$HOME/.local/bin:$PATH"
source "$HERE/folders.sh"
pause() { read -rn1 -p "Press any key to close "; }
pick_state="$(dirname "$state")/start-picks"
# Every folder started from the Start picker is remembered, repo or not, so the picker can keep it visible.
remember_pick() { [[ -n $1 && $1 != "$HOME" ]] || return 0; mkdir -p "$(dirname "$pick_state")"; { echo "$1"; grep -vxF "$1" "$pick_state" 2>/dev/null; } | head -20 >"$pick_state.new" && mv "$pick_state.new" "$pick_state"; }

dir=${AGENT_DIR:-}
if [[ -n ${AGENT_NEW:-} ]]; then      # a plain folder name, made in ~/Projects with git set up
  [[ $AGENT_NEW != */* && $AGENT_NEW != .* ]] || { echo "Use a plain folder name."; pause; exit 1; }
  dir="$PROJECTS/$AGENT_NEW"
  if ! is_repo "$dir"; then mkdir -p "$dir" && init_repo "$dir" || { echo "Couldn't create $dir"; pause; exit 1; }; fi
fi
[[ -n $dir && -d $dir ]] || { echo "No such folder: ${dir:-(none)}"; pause; exit 1; }
remember_pick "$dir"

# Only a git repo goes on the recent list (a plain folder is fine for an agent, but the list is of repos).
if is_repo "$dir"; then
  remember "$dir"
  mkdir -p "$(dirname "$state")" && printf '%s\n' "$dir" >"$state"
fi

cd "$dir" || { echo "Couldn't open $dir"; pause; exit 1; }
# --inline: this terminal is the agent's window. --pick: with no default agent set, offer the choice instead of an error.
exec omarchy-agent --inline --pick
