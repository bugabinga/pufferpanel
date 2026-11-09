#!/usr/bin/env bash
# Host-owned gate for harness-repair candidates; never execute the candidate's copy of this file.
# It runs the candidate's own harness tests, so it must never share a job or process tree with release credentials.
set -Eeuo pipefail
# BASE is explicit: on the release side the worktree is detached at the candidate, so HEAD is not the base.
[[ $# == 3 && $3 =~ ^[a-f0-9]{40}$ ]] || { echo 'usage: harness-gate.sh WORKTREE RUN_DIR BASE_SHA' >&2; exit 64; }
worktree=$(realpath -e "$1")
run_dir=$(realpath -e "$2")
base=$3
case "$run_dir" in "$worktree"|"$worktree"/*) echo 'run directory must be outside worktree' >&2; exit 64;; esac
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
mkdir -p "$run_dir/logs"
rm -f "$run_dir/gate.ok"
run() { local name=$1; shift; puffer_timed "$run_dir" "$name" "$run_dir/logs/$name.log" "$@"; }
cd "$worktree"
git rev-parse --is-inside-work-tree >/dev/null
# The gated tree is the index; unstaged or untracked leftovers would be gated as something else.
if ! git diff --quiet || [[ -n $(git ls-files --others --exclude-standard) ]]; then
  echo 'harness candidate has unstaged or untracked changes' >&2; exit 1
fi
before=$(git diff --binary HEAD | sha256sum | cut -d' ' -f1)
tree=$(git write-tree)
# Only tools/maintainer/** and honest-annie.yml with frozen on: triggers (scope.mjs): the PR's own workflows run with write tokens.
run harness-scope node "$module/scope.mjs" "$worktree" "$base" "$tree"
# A CLI that silently did nothing would pass; require its explicit verdict.
grep -qx 'harness-scope-ok' "$run_dir/logs/harness-scope.log" || { echo 'harness scope check gave no verdict' >&2; exit 1; }
run harness-whitespace git diff --check "$base" "$tree" -- tools/maintainer .github
context=$(mktemp -d)
trap 'chmod -R u+w "$context" 2>/dev/null; rm -rf "$context"' EXIT
exported=$context/src
puffer_export_tree "$worktree" "$tree" "$exported"
mapfile -t scripts < <(git ls-tree -r --name-only "$tree" -- tools/maintainer .github | grep '\.sh$' || true)
mapfile -t workflows < <(git ls-tree -r --name-only "$tree" -- .github/workflows | grep -E '\.ya?ml$' || true)
(( ${#workflows[@]} )) || { echo 'no workflow files to check' >&2; exit 1; }
cd "$exported/tools/maintainer"
# Candidate code (its npm scripts and tests) runs natively, so it gets an empty environment like model shells:
# no provider keys, GitHub tokens, or runner variables, whichever step invoked this gate.
mkdir "$context/tmp"
candidate=(env -i PATH="$PATH" HOME="$HOME" TMPDIR="$context/tmp" LANG=C.UTF-8 npm_config_cache="$context/npm-cache" npm_config_update_notifier=false)
run harness-npm-ci "${candidate[@]}" npm ci --ignore-scripts --no-audit --no-fund
run harness-test "${candidate[@]}" npm test
cd "$exported"
run harness-shell bash -c 'for script; do bash -n "$script" || exit 1; done' harness-shell "${scripts[@]}"
# YAML syntax with the trusted harness's own parser, not the candidate's dependencies. `yaml` is a locked transitive
# dependency of the pinned pi packages (ci.test.mjs imports it too); a lockfile change that drops it fails this gate closed.
run harness-yaml node --input-type=module -e '
import { createRequire } from "node:module"; import { readFileSync } from "node:fs";
const YAML = createRequire(process.argv[1] + "/")("yaml");
for (const file of process.argv.slice(2)) { const doc = YAML.parseDocument(readFileSync(file, "utf8")); if (doc.errors.length) throw Error(`${file}: ${doc.errors[0].message}`); }' "$module" "${workflows[@]}"
# Pinned actionlint, fetched through the Go module proxy with private caches; needs Go and network, else the gate fails closed.
config=()
[[ -f .github/actionlint.yaml ]] && config=(-config-file .github/actionlint.yaml)
run harness-actionlint env GOPATH="$context/go" GOMODCACHE="$context/go/mod" GOCACHE="$context/go-cache" GOFLAGS=-modcacherw go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 "${config[@]}" "${workflows[@]}"
cd "$worktree"
[[ $(git write-tree) == "$tree" && $(git diff --binary HEAD | sha256sum | cut -d' ' -f1) == "$before" && -z $(git ls-files --others --exclude-standard) ]] || { echo 'candidate changed during verification' >&2; exit 1; }
printf '%s\n' "$tree" >"$run_dir/gate.ok"
