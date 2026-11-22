#!/bin/bash
# The Squad button: run Claude Squad (`cs`) with one agent, in a git repo folder.
# Usage: squad.sh <agent-cli>...    squad.sh --install   (install Claude Squad)
# With several agents, the first runs in this terminal and each other gets a terminal of its own.
# The folder: $SQUAD_DIR, else the last one used. Otherwise a picker starts in ~/Projects and lists only git repos
# there (no backups or desktop files), plus "Create a new project", which is git-initialized with a first commit.
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

# Projects live here; the folder picker starts here and lists only git repos in it.
PROJECTS="${SQUAD_PROJECTS:-$HOME/Projects}"
# Backups and desktop files are hidden: hidden folders, *backup*/*.bak*, date-stamped or before-/pre- copies, *.desktop, Desktop.
repo_list() {
  find "$PROJECTS" -maxdepth 3 -name .git -prune -printf '%T@ %h\n' 2>/dev/null | sort -nr | cut -d' ' -f2- |
    while IFS= read -r d; do
      rel=${d#"$PROJECTS"/}
      [[ $rel == "$PROJECTS" ]] && rel=$(basename "$d")
      case "/$rel/" in */.*|*backup*|*Backup*|*.bak*|*-before-*|*-pre[a-z]*/|*-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*|*.desktop/|*/Desktop/*) continue ;; esac
      printf '%s\n' "$rel"
    done
}

dir=${SQUAD_DIR:-}
[[ -z $dir && -f $state ]] && dir=$(<"$state")
if ! is_repo "$dir"; then
  mapfile -t repos < <(repo_list)
  new="+ Create a new project"
  choice=$(printf '%s\n' "${repos[@]}" "$new" | sed '/^$/d' | gum choose --header "Squad: pick a git repo in ${PROJECTS/#$HOME/~}") || exit 130
  if [[ $choice == "$new" ]]; then
    name=$(gum input --header "New project name" --placeholder "my-project") || exit 130
    [[ -n $name && $name != */* && $name != .* ]] || { echo "Use a plain folder name."; pause; exit 1; }
    dir="$PROJECTS/$name"
    mkdir -p "$dir" && init_repo "$dir" || { echo "Couldn't create $dir"; pause; exit 1; }
  else
    dir="$PROJECTS/$choice"
    is_repo "$dir" || { echo "$dir isn't a git repo."; pause; exit 1; }
  fi
fi
mkdir -p "$(dirname "$state")" && printf '%s\n' "$dir" >"$state"

# Every other agent: its own terminal in the same folder (the folder is settled now, so nothing asks again).
for extra in "${clis[@]:1}"; do
  SQUAD_DIR="$dir" omarchy-launch-tui bash "$0" "$extra"
done
cd "$dir" && exec cs -p "${clis[0]}"
