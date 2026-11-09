#!/usr/bin/env bash
# Private Podman storage shared by trusted maintainer scripts.
[[ ${BASH_SOURCE[0]} != "$0" ]] || { echo 'podman.sh must be sourced' >&2; exit 64; }

puffer_podman_init() {
  local state=$1 requested runroot owner mode bytes
  [[ $state == /* ]] || { echo 'Podman state must be absolute' >&2; return 64; }
  umask 077
  mkdir -p "$state/podman/root"
  chmod 700 "$state/podman/root"
  requested=${PUFFER_MAINT_RUNROOT:-"$state/podman/runroot"}
  bytes=$(LC_ALL=C printf %s "$requested" | wc -c)
  if [[ -v PUFFER_MAINT_RUNROOT ]]; then
    [[ $requested == /* && $bytes -le 50 && -d $requested ]] || { echo 'invalid explicit Podman runroot' >&2; return 64; }
  elif [[ $requested != /* || $bytes -gt 50 ]]; then
    local temporary=${TMPDIR:-/tmp}
    temporary=$(realpath -e "$temporary")
    if (( $(LC_ALL=C printf %s "$temporary/pufferpanel-podman.XXXXXX" | wc -c) > 50 )); then temporary=$(realpath -e /tmp); fi
    requested=$(mktemp -d "$temporary/pufferpanel-podman.XXXXXX")
    chmod 700 "$requested"
    PUFFER_MAINT_RUNROOT_CREATED=1
  else
    mkdir -p "$requested"
    chmod 700 "$requested"
  fi
  runroot=$(realpath -e "$requested")
  [[ $runroot == /* ]] || { echo 'Podman runroot must be absolute' >&2; return 64; }
  bytes=$(LC_ALL=C printf %s "$runroot" | wc -c)
  (( bytes <= 50 )) || { echo 'Podman runroot exceeds 50 bytes' >&2; return 64; }
  owner=$(stat -c %u "$runroot")
  mode=$(stat -c %a "$runroot")
  [[ $owner == $(id -u) && $mode == 700 ]] || { echo 'Podman runroot must be user-owned mode 0700' >&2; return 64; }
  PUFFER_MAINT_PODMAN=(podman --root "$state/podman/root" --runroot "$runroot" --storage-driver "${PUFFER_MAINT_STORAGE_DRIVER:-overlay}")
}

# Exports Git tree TREE of WORKTREE's repository into new directory DEST through a private index, never the worktree itself.
# Priming and the gate both build from such exports: a linked worktree's .git pointer file and ignored build outputs
# would otherwise change `COPY . .` and miss every later layer, and the gate now tests exactly the recorded tree.
puffer_export_tree() {
  local worktree=$1 tree=$2 dest=$3 status
  [[ $tree =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ && $dest == /* && ! -e $dest && ! -e $dest.index ]] || { echo 'invalid tree export' >&2; return 64; }
  (umask 077 && mkdir "$dest" && GIT_INDEX_FILE="$dest.index" git -C "$worktree" read-tree "$tree" && GIT_INDEX_FILE="$dest.index" git -C "$worktree" checkout-index --all --prefix="$dest/") && status=0 || status=$?
  rm -f "$dest.index"
  return "$status"
}

# Gate image build flags, shared with the reviewer sandbox so both build identical layers.
puffer_gate_build_args() {
  local platform
  case $(uname -m) in x86_64) platform=linux/amd64;; aarch64) platform=linux/arm64;; *) echo 'unsupported native architecture' >&2; return 1;; esac
  PUFFER_MAINT_BUILD_ARGS=(--network host --platform "$platform" --build-arg "BUILDPLATFORM=$platform" --build-arg "TARGETPLATFORM=$platform" --build-arg tags=)
}

puffer_podman_preflight() {
  local tool node=${PUFFER_MAINT_NODE:-node}
  for tool in "$node" git podman bash flock timeout; do command -v "$tool" >/dev/null || { echo "required runtime tool missing: $tool" >&2; return 1; }; done
  "$node" -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node >=24 required")'
  "${PUFFER_MAINT_PODMAN[@]}" info >/dev/null
}

puffer_gate_event() {
  local run_dir=$1 name=$2 start=$3 end=$4 status=$5
  printf '{"name":"%s","start":"%s","end":"%s","durationMs":%s,"exitCode":%s}\n' "$name" "$start" "$end" "$((end - start))" "$status" >>"$run_dir/gate-events.jsonl"
}

puffer_timed() {
  local run_dir=$1 name=$2 log=$3 start end status
  shift 3
  start=$(date +%s%3N)
  set +e
  "$@" >"$log" 2>&1
  status=$?
  set -e
  end=$(date +%s%3N)
  puffer_gate_event "$run_dir" "$name" "$start" "$end" "$status"
  return "$status"
}

puffer_timed_append() {
  local run_dir=$1 name=$2 log=$3 start end status
  shift 3
  start=$(date +%s%3N)
  set +e
  "$@" >>"$log" 2>&1
  status=$?
  set -e
  end=$(date +%s%3N)
  puffer_gate_event "$run_dir" "$name" "$start" "$end" "$status"
  return "$status"
}
