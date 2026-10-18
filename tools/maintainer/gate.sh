#!/usr/bin/env bash
# Host-owned release gate; never execute the candidate's copy of this file.
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'usage: gate.sh WORKTREE RUN_DIR' >&2; exit 64; }
worktree=$(realpath -e "$1")
run_dir=$(realpath -e "$2")
case "$run_dir" in "$worktree"|"$worktree"/*) echo 'run directory must be outside worktree' >&2; exit 64;; esac
state_dir=$(dirname "$(dirname "$run_dir")")
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
mkdir -p "$run_dir/logs"
rm -f "$run_dir/gate.ok"
puffer_podman_init "$state_dir"
podman=("${PUFFER_MAINT_PODMAN[@]}")
case $(uname -m) in x86_64) platform=linux/amd64;; aarch64) platform=linux/arm64;; *) echo 'unsupported native architecture' >&2; exit 1;; esac
run() { local name=$1; shift; puffer_timed "$run_dir" "$name" "$run_dir/logs/$name.log" "$@"; }
cd "$worktree"
git rev-parse --is-inside-work-tree >/dev/null
if ! git diff --quiet HEAD -- tools/maintainer .github || [[ -n $(git ls-files --others --exclude-standard -- tools/maintainer .github) ]]; then
  echo 'maintainer harness or CI changed' >&2; exit 1
fi
before=$(git diff --binary HEAD | sha256sum | cut -d' ' -f1)
tree=$(git write-tree)
run whitespace git diff --check HEAD -- . ':(exclude)client/frontend/public/js/ace/**'
build_args=(--network host --platform "$platform" --build-arg "BUILDPLATFORM=$platform" --build-arg "TARGETPLATFORM=$platform" --build-arg tags=)
# The node stage itself runs frozen dependency install, JS tests, lint and production build.
run node "${podman[@]}" build "${build_args[@]}" --target node -t localhost/pufferpanel-maintainer-node -f Dockerfile .
# Verify upstream Ace bytes, rather than blindly exempting arbitrary vendor edits from formatting.
run ace "${podman[@]}" run --rm --network none --entrypoint node localhost/pufferpanel-maintainer-node -e '
const fs=require("node:fs"),path=require("node:path");
const pin=require("/build/frontend/package.json").devDependencies["ace-builds"];
const installed=require("/build/node_modules/ace-builds/package.json").version;
if(pin!==installed)throw Error("Ace pin mismatch");
const root="/build/frontend/public/js/ace";
function check(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())check(p);else if(p.endsWith(".js")){const q=path.join("/build/node_modules/ace-builds/src-min-noconflict",path.relative(root,p));if(!fs.readFileSync(p).equals(fs.readFileSync(q)))throw Error("Ace differs: "+p);}}}
check(root);'
# This is glibc-based, contains compiled frontend embeds, gcc, Go, and fetched modules.
run tests-image "${podman[@]}" build "${build_args[@]}" --target tests -t localhost/pufferpanel-maintainer-tests -f Dockerfile .
test_run=("${podman[@]}" run --rm --network host -e TMPDIR=/tmp -e GOCACHE=/tmp/go-cache --entrypoint sh localhost/pufferpanel-maintainer-tests -ec)
run go-normal "${test_run[@]}" 'go test -count=1 ./...'
run go-race "${test_run[@]}" 'go test -race -count=1 ./...'
run go-vet "${test_run[@]}" 'go vet ./...'
# Pinned check tool, without mutating project module files or host caches.
run actionlint "${podman[@]}" run --rm --network host -v "$worktree/.github:/checks/.github:ro" -e TMPDIR=/tmp -e GOCACHE=/tmp/go-cache --entrypoint sh localhost/pufferpanel-maintainer-tests -ec 'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -config-file /checks/.github/actionlint.yaml /checks/.github/workflows/*.yml'
[[ $(git write-tree) == "$tree" && $(git diff --binary HEAD | sha256sum | cut -d' ' -f1) == "$before" && -z $(git ls-files --others --exclude-standard) ]] || { echo 'candidate changed during verification' >&2; exit 1; }
printf '%s\n' "$tree" >"$run_dir/gate.ok"
