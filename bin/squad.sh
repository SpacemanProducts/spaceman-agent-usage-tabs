#!/bin/bash
# The Squad button: run Claude Squad (`cs`) with one agent, in a git repo folder.
# Usage: squad.sh <agent-cli>...    squad.sh --install   (install Claude Squad)
# With several agents, the first runs in this terminal and each other gets a terminal of its own.
# The folder: $SQUAD_DIR, else the last one used, else the newest git repo under ~/Work. With none, you pick
# a folder or create a new project here; either way it is made a git repo (with a first commit) if it isn't one.
arg=${1:?usage: squad.sh <agent-cli>... | --install}
export PATH="$HOME/.local/bin:$PATH"
INSTALL='curl -fsSL https://raw.githubusercontent.com/smtg-ai/claude-squad/main/install.sh | bash'

install_cs() {
  echo "Installing Claude Squad (needs tmux and git):"
  echo "  $INSTALL"
  echo
  bash -c "$INSTALL"
  hash -r
}
pause() { read -rn1 -p "Press any key to close "; }

if [[ $arg == --install ]]; then install_cs; command -v cs >/dev/null && echo "Done: cs is installed." || echo "cs still not found."; pause; exit; fi
clis=("$@")

if ! command -v cs >/dev/null; then
  echo "Squad needs Claude Squad (cs)."
  gum confirm "Install it now?" || exit 130
  install_cs
  command -v cs >/dev/null || { echo "cs still not found; see github.com/smtg-ai/claude-squad"; pause; exit 1; }
fi

state="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agent-usage-tabs/squad-dir"
is_repo() { [[ -n $1 ]] && git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
# Squad branches from HEAD, so a fresh repo needs a first commit.
init_repo() { git -C "$1" init -q && git -C "$1" commit -q --allow-empty -m "Initial commit"; }

dir=${SQUAD_DIR:-}
[[ -z $dir && -f $state ]] && dir=$(<"$state")
if ! is_repo "$dir"; then
  dir=$(find "$HOME/Work" -maxdepth 3 -name .git -printf '%T@ %h\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
fi
if ! is_repo "$dir"; then
  choice=$(gum choose --header "Squad needs a git repo folder" "Pick a folder" "Create a new project") || exit 130
  if [[ $choice == "Pick a folder" ]]; then
    dir=$(gum file --directory --header "Choose a folder" "$HOME") || exit 130
    [[ -n $dir ]] || exit 130
    if ! is_repo "$dir"; then
      gum confirm "That folder isn't a git repo. Run git init there?" || exit 130
      init_repo "$dir" || { echo "git init failed in $dir"; pause; exit 1; }
    fi
  else
    name=$(gum input --header "New project name" --placeholder "my-project") || exit 130
    [[ -n $name && $name != */* && $name != .* ]] || { echo "Use a plain folder name."; pause; exit 1; }
    dir="$HOME/Work/$name"
    mkdir -p "$dir" && init_repo "$dir" || { echo "Couldn't create $dir"; pause; exit 1; }
  fi
fi
mkdir -p "$(dirname "$state")" && printf '%s\n' "$dir" >"$state"

# Every other agent: its own terminal in the same folder (the folder is settled now, so nothing asks again).
for extra in "${clis[@]:1}"; do
  SQUAD_DIR="$dir" omarchy-launch-tui bash "$0" "$extra"
done
cd "$dir" && exec cs -p "${clis[0]}"
