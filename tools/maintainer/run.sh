#!/usr/bin/env bash
set -Eeuo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
state=${PUFFER_MAINT_STATE:-"$HOME/.pi/agent/maintenance/pufferpanel"}
umask 077
mkdir -p "$state"
if [[ -x "$HOME/.local/share/pi-node/current/bin/node" ]]; then
  export PATH="$HOME/.local/share/pi-node/current/bin:$PATH"
fi
node=${PUFFER_MAINT_NODE:-node}
export TMPDIR=${TMPDIR:-/tmp}
puffer_podman_init "$state"
puffer_podman_preflight
# One process owns SQLite; the process-group deadline includes subprocesses and release checks.
duration=7200
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
  [[ ${GITHUB_RUN_ATTEMPT:-} == 1 ]] || { echo 'reruns never pay models' >&2; exit 64; }
  : "${PUFFER_MAINT_LEASE:?}"
  duration=$("$node" --input-type=module -e 'import fs from "node:fs"; const lease=JSON.parse(fs.readFileSync(process.env.PUFFER_MAINT_LEASE)); console.log(Math.min(7200,Math.floor((lease.deadline-Date.now())/1000)-90));')
  [[ $duration =~ ^[0-9]+$ ]] && (( duration > 0 )) || { echo 'paid deadline expired' >&2; exit 64; }
fi
exec flock --nonblock "$state/maintain.lock" timeout --signal=TERM --kill-after=30s "${duration}s" "$node" "$module/maintain.mjs" "$@"
