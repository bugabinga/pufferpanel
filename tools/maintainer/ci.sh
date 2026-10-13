#!/usr/bin/env bash
# Trusted CI bridge; model job never receives Git write or registry credentials.
set -Eeuo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == init ]]; then
  : "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GITHUB_ENV:?}"
  {
    printf 'PUFFER_MAINT_SOURCE=%s\n' "$GITHUB_WORKSPACE"
    printf 'PUFFER_MAINT_STATE=%s/honest-annie-state\n' "$RUNNER_TEMP"
    printf 'HONEST_ANNIE_ARTIFACT=%s/honest-annie-candidate\n' "$RUNNER_TEMP"
    printf 'PI_CODING_AGENT_DIR=%s/honest-annie-agent\n' "$RUNNER_TEMP"
    printf 'PUFFER_MAINT_RESULT=%s/honest-annie-result.json\n' "$RUNNER_TEMP"
    printf 'REGISTRY_AUTH_FILE=%s/honest-annie-registry-auth.json\n' "$RUNNER_TEMP"
    printf 'TMPDIR=%s\n' "$RUNNER_TEMP"
  } >>"$GITHUB_ENV"
  exit 0
fi
: "${PUFFER_MAINT_SOURCE:?}" "${PUFFER_MAINT_STATE:?}" "${HONEST_ANNIE_ARTIFACT:?}" "${GITHUB_SHA:?}"
source=$(realpath -e "$PUFFER_MAINT_SOURCE")
state=$PUFFER_MAINT_STATE
artifact=$HONEST_ANNIE_ARTIFACT
umask 077
metadata() {
  node --input-type=module - "$artifact/result.json" "$GITHUB_SHA" <<'JS'
import { readFileSync } from 'node:fs';
const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (run.phase !== 'publishing' || !/^\d{4}-\d{2}-\d{2}$/.test(run.day) ||
    run.version !== run.day.split('-').map(Number).join('.') ||
    !/^[1-9]\d*\.[1-9]\d*\.[1-9]\d*$/.test(run.version) ||
    ![run.commit, run.base, run.tree].every(value => /^[a-f0-9]{40}$/.test(value)) ||
    run.base !== process.argv[3]) throw Error('invalid CI release metadata');
console.log([run.commit, run.base, run.tree, run.version, run.day].join('\n'));
JS
}
load_metadata() {
  local values
  values=$(metadata) || return
  mapfile -t fields <<<"$values"
  commit=${fields[0]}; base=${fields[1]}; tree=${fields[2]}; version=${fields[3]}; day=${fields[4]}
  run_dir="$state/runs/$day"
}
verify() {
  [[ $(git -C "$worktree" rev-parse HEAD) == "$commit" && $(git -C "$worktree" rev-parse HEAD^) == "$base" && $(git -C "$worktree" rev-parse 'HEAD^{tree}') == "$tree" ]] || { echo 'candidate identity mismatch' >&2; exit 1; }
  [[ -z $(git -C "$worktree" status --porcelain) && $(cat "$artifact/gate.ok") == "$tree" ]] || { echo 'clean, gated candidate required' >&2; exit 1; }
  git -C "$worktree" diff --quiet "$base" "$commit" -- tools/maintainer .github || { echo 'candidate changed trusted harness or CI' >&2; exit 1; }
}
case "${1:-}" in
  prepare)
    : "${PI_CODING_AGENT_DIR:?}"
    mkdir -p "$PI_CODING_AGENT_DIR" "$state"
    cp "$module/ci-settings.json" "$PI_CODING_AGENT_DIR/settings.json"
    git -C "$source" config user.name honest_annie
    git -C "$source" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    git -C "$source" remote add upstream https://github.com/pufferpanel/pufferpanel.git
    ;;
  export)
    : "${PUFFER_MAINT_RESULT:?}" "${GITHUB_OUTPUT:?}"
    mkdir -p "$artifact"
    cp "$PUFFER_MAINT_RESULT" "$artifact/result.json"
    if node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1]));process.exit(r.phase==="published"&&r.commit===null?0:1)' "$artifact/result.json"; then
      printf 'candidate=false\n' >>"$GITHUB_OUTPUT"
      exit 0
    fi
    load_metadata
    worktree="$state/worktree"
    cp "$run_dir/gate.ok" "$artifact/gate.ok"
    verify
    git -C "$worktree" bundle create "$artifact/candidate.bundle" HEAD "^$base"
    printf 'candidate=true\n' >>"$GITHUB_OUTPUT"
    ;;
  import)
    load_metadata
    [[ $(git -C "$source" rev-parse HEAD) == "$base" ]] || { echo 'trusted checkout is not candidate base' >&2; exit 1; }
    git -C "$source" bundle verify "$artifact/candidate.bundle"
    git -C "$source" fetch "$artifact/candidate.bundle" HEAD:refs/heads/honest-annie-candidate
    mkdir -p "$state" "$run_dir"
    worktree="$state/worktree"
    git -C "$source" worktree add --detach "$worktree" "$commit"
    verify
    # Model-job receipts identify a candidate, but never authorize a release.
    rm -f "$run_dir/gate.ok"
    ;;
  gate)
    load_metadata
    worktree="$state/worktree"
    verify
    bash "$module/gate.sh" "$worktree" "$run_dir"
    ;;
  push)
    load_metadata
    worktree="$state/worktree"
    verify
    [[ -f "$run_dir/gate.ok" && $(cat "$run_dir/gate.ok") == "$tree" ]] || { echo 'independent release gate required' >&2; exit 1; }
    origin=$(git -C "$source" remote get-url origin)
    # Credentials remain in step environment, never in repository config or bundle.
    authenticated_git=(git -C "$source" -c credential.helper= -c 'credential.helper=!f() { printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f')
    remote=$("${authenticated_git[@]}" ls-remote "$origin" refs/heads/trunk | cut -f1)
    if [[ "$remote" == "$base" ]]; then
      "${authenticated_git[@]}" push "$origin" "$commit:refs/heads/trunk"
    elif [[ "$remote" != "$commit" ]]; then
      echo 'trunk advanced; refusing stale release or history overwrite' >&2; exit 1
    fi
    ;;
  publish)
    load_metadata
    worktree="$state/worktree"
    verify
    bash "$module/publish.sh" "$worktree" "$version" "$run_dir"
    ;;
  *) echo 'usage: ci.sh init|prepare|export|import|gate|push|publish' >&2; exit 64;;
esac
