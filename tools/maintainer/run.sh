#!/usr/bin/env bash
set -Eeuo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state=${PUFFER_MAINT_STATE:-"$HOME/.pi/agent/maintenance/pufferpanel"}
umask 077
mkdir -p "$state"
if [[ -x "$HOME/.local/share/pi-node/current/bin/node" ]]; then
  export PATH="$HOME/.local/share/pi-node/current/bin:$PATH"
fi
node=${PUFFER_MAINT_NODE:-node}
"$node" -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node >=24 required")'
export TMPDIR=${TMPDIR:-/tmp}
# One process owns SQLite; the process-group deadline includes subprocesses and release checks.
exec flock --nonblock "$state/maintain.lock" timeout --signal=TERM --kill-after=30s 2h "$node" "$module/maintain.mjs" "$@"
