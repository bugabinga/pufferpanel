#!/usr/bin/env bash
# Host-owned, fail-closed publisher. No registry outage is treated as an absent tag.
set -Eeuo pipefail
[[ $# == 3 ]] || { echo 'usage: publish.sh WORKTREE VERSION RUN_DIR' >&2; exit 64; }
worktree=$(realpath -e "$1"); version=$2; run_dir=$(realpath -e "$3")
[[ "$version" =~ ^[1-9][0-9]*\.[1-9][0-9]*\.[1-9][0-9]*$ ]] || { echo 'version must be numeric SemVer' >&2; exit 64; }
[[ -f "$run_dir/gate.ok" && $(cat "$run_dir/gate.ok") == "$(git -C "$worktree" rev-parse 'HEAD^{tree}')" ]] || { echo 'successful gate for exact committed tree required' >&2; exit 1; }
[[ -z $(git -C "$worktree" status --porcelain) ]] || { echo 'worktree must be clean' >&2; exit 1; }
sha=$(git -C "$worktree" rev-parse HEAD)
state_dir=$(dirname "$(dirname "$run_dir")")
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
mkdir -p "$run_dir/logs"
puffer_podman_init "$state_dir"
podman=("${PUFFER_MAINT_PODMAN[@]}")
case $(uname -m) in x86_64) platform=linux/amd64;; aarch64) platform=linux/arm64;; *) echo 'unsupported native architecture' >&2; exit 1;; esac
registry=${PUFFER_MAINT_REGISTRY:-registry.bugabinga.net/pufferpanel}
[[ "$registry" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?/[a-z0-9/_.-]+$ ]] || { echo 'invalid registry image name' >&2; exit 64; }
host=${registry%%/*}; repository=${registry#*/}
image="$registry:$version"; latest="$registry:latest"
accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
log() { puffer_timed_append "$run_dir" publish-podman "$run_dir/logs/publish.log" "$@"; }
local_id() {
  local value
  value=$("${podman[@]}" image inspect "$image" --format '{{.Id}}')
  value=${value#sha256:}
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || { echo 'invalid local image ID' >&2; exit 1; }
  printf '%s\n' "$value"
}
json() { node -e 'const fs=require("node:fs"); let v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for(const k of process.argv[2].split("/")) v=v?.[k]; if(typeof v!=="string")process.exit(1); process.stdout.write(v)' "$1" "$2"; }
manifest() {
  local tag=$1 output=$2 code
  code=$(curl --max-time 30 -sS -o "$output" -w '%{http_code}' -H "Accept: $accept" "https://$host/v2/$repository/manifests/$tag") || return 1
  case "$code" in 200) return 0;; 404) return 4;; *) echo "registry returned HTTP $code for $tag" >&2; return 1;; esac
}
labels() {
  local file=$1 config digest
  digest=$(json "$file" config/digest) || return 1
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'invalid remote config digest' >&2; exit 1; }
  config="$file.config"
  curl --max-time 30 -fsS -o "$config" "https://$host/v2/$repository/blobs/$digest" || return 1
  remote_sha=$(json "$config" config/Labels/org.opencontainers.image.revision) || return 1
  remote_version=$(json "$config" config/Labels/org.opencontainers.image.version) || return 1
}
version_manifest="$run_dir/version.manifest.json"
if manifest "$version" "$version_manifest"; then
  labels "$version_manifest"
  [[ "$remote_sha" == "$sha" && "$remote_version" == "$version" ]] || { echo 'immutable version collision' >&2; exit 1; }
  if [[ -f "$run_dir/expected-image-id" ]]; then
    [[ "sha256:$(cat "$run_dir/expected-image-id")" == "$(json "$version_manifest" config/digest)" ]] || { echo 'remote version differs from built image' >&2; exit 1; }
  fi
  log "${podman[@]}" pull "$image"
else
  code=$?; [[ $code == 4 ]] || exit "$code"
  : "${TMPDIR:?publisher requires OS-temporary TMPDIR}"
  context=$(mktemp -d "$TMPDIR/pufferpanel-context.XXXXXXXX")
  trap 'rm -rf "$context"' EXIT
  git -C "$worktree" archive --format=tar HEAD | tar -x -C "$context"
  # A retained local image is reused after an interrupted push; do not silently rebuild different bytes.
  if [[ -f "$run_dir/expected-image-id" ]]; then
    [[ $(local_id) == "$(cat "$run_dir/expected-image-id")" ]] || { echo 'saved release image unavailable' >&2; exit 1; }
  else
    log "${podman[@]}" build --network host --platform "$platform" --build-arg "BUILDPLATFORM=$platform" --build-arg "TARGETPLATFORM=$platform" --build-arg tags= --build-arg "version=$version" --build-arg "sha=$sha" --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.version=$version" --label org.opencontainers.image.source=https://github.com/bugabinga/pufferpanel -t "$image" -f "$context/Dockerfile" "$context"
    "${podman[@]}" run --rm --entrypoint /pufferpanel/bin/pufferpanel "$image" version >"$run_dir/binary-version" 2>>"$run_dir/logs/publish.log"
    [[ $(cat "$run_dir/binary-version") == "PufferPanel $version ($sha)" ]] || { echo 'built binary version mismatch' >&2; exit 1; }
    local_id >"$run_dir/expected-image-id"
  fi
  log "${podman[@]}" push --format oci --digestfile "$run_dir/version.digest" "$image"
  manifest "$version" "$version_manifest"
  labels "$version_manifest"
  [[ "$remote_sha" == "$sha" && "$remote_version" == "$version" && "$(json "$version_manifest" config/digest)" == "sha256:$(cat "$run_dir/expected-image-id")" ]] || { echo 'remote version verification failed' >&2; exit 1; }
fi
version_digest="sha256:$(sha256sum "$version_manifest" | cut -d' ' -f1)"
if [[ -f "$run_dir/version.digest" ]]; then [[ $(cat "$run_dir/version.digest") == "$version_digest" ]] || { echo 'remote version digest mismatch' >&2; exit 1; }; fi
printf '%s\n' "$version_digest" >"$run_dir/version.digest"
# Check before promotion; a distributed race still requires a registry-side lock/CAS.
latest_manifest="$run_dir/latest.manifest.json"
if manifest latest "$latest_manifest"; then
  labels "$latest_manifest"
  if [[ "$remote_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    [[ $(printf '%s\n%s\n' "$remote_version" "$version" | sort -V | tail -n1) == "$version" ]] || { echo 'latest is newer; refusing rollback' >&2; exit 1; }
    [[ "$remote_version" != "$version" || "$remote_sha" == "$sha" ]] || { echo 'latest version collision' >&2; exit 1; }
  fi
else
  code=$?; [[ $code == 4 ]] || exit "$code"
fi
[[ $(git -C "$worktree" rev-parse HEAD) == "$sha" && -z $(git -C "$worktree" status --porcelain) ]] || { echo 'source changed before latest promotion' >&2; exit 1; }
log "${podman[@]}" tag "$image" "$latest"
log "${podman[@]}" push --format oci --digestfile "$run_dir/latest.digest" "$latest"
manifest latest "$latest_manifest"
latest_digest="sha256:$(sha256sum "$latest_manifest" | cut -d' ' -f1)"
[[ "$latest_digest" == "$version_digest" && $(cat "$run_dir/latest.digest") == "$version_digest" ]] || { echo 'remote tags have different digests' >&2; exit 1; }
printf 'revision=%s\nversion=%s\ndigest=%s\n' "$sha" "$version" "$version_digest" >"$run_dir/remote-proof"
printf '%s\n' "$sha" >"$run_dir/publish.ok"
