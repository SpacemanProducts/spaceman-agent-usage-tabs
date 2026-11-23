#!/bin/bash
# Run a launcher command and confirm a window of the given app-id really appeared (on any workspace).
# Usage: launch-wait.sh <app-id> <seconds> <command...>
# Exit 0 when a new window with that app-id exists; otherwise print why on stderr and exit 1 (the panel shows that line).
# The command's own output is kept (last lines) so a launch that dies can say what went wrong.
app=$1; secs=$2; shift 2
count() { hyprctl clients -j 2>/dev/null | grep -o "\"class\": \"$app\"" | wc -l; }
before=$(count)
log=$(mktemp); trap 'rm -f "$log"' EXIT
"$@" >"$log" 2>&1 &
pid=$!
end=$((SECONDS + secs))
while ((SECONDS < end)); do
  (($(count) > before)) && exit 0
  if ! kill -0 "$pid" 2>/dev/null; then       # the launcher ended: give a window a moment to map, then judge
    wait "$pid"; code=$?
    for _ in 1 2 3 4 5 6; do (($(count) > before)) && exit 0; sleep 0.5; done
    detail=$(grep -vE '^(info|debug)' "$log" | tail -2 | tr '\n' ' ')
    echo "The terminal didn't open (launcher exit $code).${detail:+ $detail}" >&2; exit 1
  fi
  sleep 0.3
done
echo "The terminal didn't open within ${secs}s." >&2; exit 1
