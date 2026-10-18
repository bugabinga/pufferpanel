#!/usr/bin/env bash
# Trusted CI bridge; model job never receives Git write or registry credentials.
set -Eeuo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
if [[ ${1:-} == init ]]; then
  : "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GITHUB_ENV:?}"
  umask 077
  temporary=$(realpath -e "${TMPDIR:-/tmp}")
  if (( $(LC_ALL=C printf %s "$temporary/pufferpanel-podman.XXXXXX" | wc -c) > 50 )); then temporary=$(realpath -e /tmp); fi
  runroot=$(mktemp -d "$temporary/pufferpanel-podman.XXXXXX")
  chmod 700 "$runroot"
  [[ $(LC_ALL=C printf %s "$runroot" | wc -c) -le 50 ]] || { rm -rf -- "$runroot"; echo 'unable to allocate short Podman runroot' >&2; exit 1; }
  {
    printf 'PUFFER_MAINT_SOURCE=%s\n' "$GITHUB_WORKSPACE"
    printf 'PUFFER_MAINT_STATE=%s/honest-annie-state\n' "$RUNNER_TEMP"
    printf 'PUFFER_MAINT_RUNROOT=%s\n' "$runroot"
    printf 'PUFFER_MAINT_RUNROOT_PREFIX=%s/pufferpanel-podman.\n' "$temporary"
    printf 'PUFFER_MAINT_STORAGE_DRIVER=overlay\n'
    printf 'HONEST_ANNIE_ARTIFACT=%s/honest-annie-candidate\n' "$RUNNER_TEMP"
    printf 'PI_CODING_AGENT_DIR=%s/honest-annie-agent\n' "$RUNNER_TEMP"
    printf 'PUFFER_MAINT_RESULT=%s/honest-annie-result.json\n' "$RUNNER_TEMP"
    printf 'PUFFER_MAINT_LEASE=%s/annie-lease/lease.json\n' "$RUNNER_TEMP"
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
case "${1:-}" in
  preflight)
    puffer_podman_init "$state"
    puffer_podman_preflight
    ;;
  cleanup)
    : "${PUFFER_MAINT_RUNROOT:?}" "${PUFFER_MAINT_RUNROOT_PREFIX:?}"
    if [[ -e $PUFFER_MAINT_RUNROOT ]]; then
      runroot=$(realpath -e "$PUFFER_MAINT_RUNROOT")
      suffix=${runroot#"$PUFFER_MAINT_RUNROOT_PREFIX"}
      [[ $runroot == "$PUFFER_MAINT_RUNROOT_PREFIX"* && $suffix != */* && $suffix != "$runroot" ]] || { echo 'refusing unsafe Podman runroot cleanup' >&2; exit 64; }
      [[ $(stat -c %u "$runroot") == $(id -u) && $(stat -c %a "$runroot") == 700 ]] || { echo 'refusing unowned Podman runroot cleanup' >&2; exit 64; }
      rm -rf -- "$runroot"
    fi
    if [[ -n ${REGISTRY_AUTH_FILE:-} ]]; then rm -f -- "$REGISTRY_AUTH_FILE"; fi
    ;;
  prepare)
    : "${PI_CODING_AGENT_DIR:?}"
    mkdir -p "$PI_CODING_AGENT_DIR" "$state"
    puffer_podman_init "$state"
    puffer_podman_preflight
    cp "$module/ci-settings.json" "$PI_CODING_AGENT_DIR/settings.json"
    git -C "$source" config user.name honest_annie
    git -C "$source" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    git -C "$source" remote add upstream https://github.com/pufferpanel/pufferpanel.git
    ;;
  registry-login)
    node "$module/ci-source.mjs" authorize-publication
    : "${REGISTRY_USERNAME:?}" "${REGISTRY_PASSWORD:?}" "${REGISTRY_AUTH_FILE:?}"
    registry=${PUFFER_MAINT_REGISTRY:-registry.bugabinga.net/pufferpanel}
    [[ $registry =~ ^[A-Za-z0-9.-]+(:[0-9]+)?/[a-z0-9/_.-]+$ ]] || { echo 'invalid registry image name' >&2; exit 64; }
    puffer_podman_init "$state"
    printf '%s' "$REGISTRY_PASSWORD" | "${PUFFER_MAINT_PODMAN[@]}" login --username "$REGISTRY_USERNAME" --password-stdin "${registry%%/*}"
    ;;
  export|import|gate|push|publish|management-check|management|feedback)
    node "$module/ci-source.mjs" "$1"
    ;;
  *) echo 'usage: ci.sh init|prepare|preflight|cleanup|export|import|gate|push|registry-login|publish|management-check|management|feedback' >&2; exit 64;;
esac
