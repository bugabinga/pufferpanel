#!/usr/bin/env bash
# Host-owned reviewer sandbox; never execute the candidate's copy of this file.
set -Eeuo pipefail
module=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$module/podman.sh"
usage() { echo 'usage: sandbox.sh version STATE | prime STATE SNAPSHOT LOG SECONDS VISUAL | probe STATE SNAPSHOT IMAGE | run STATE SNAPSHOT go|node IMAGE PROFILE NAME SECONDS COMMAND | vprobe STATE IMAGE PROFILE | visual STATE IMAGE PROFILE NAME SECONDS INPUT | kill STATE NAME' >&2; exit 64; }
[[ $# -ge 2 ]] || usage
# One pinned runroot per process: Podman's storage database rejects a different runroot for the same root.
[[ -n ${PUFFER_MAINT_RUNROOT:-} ]] || { echo 'pinned Podman runroot required' >&2; exit 64; }
mode=$1 state=$(realpath -e "$2")
puffer_podman_init "$state"
podman=("${PUFFER_MAINT_PODMAN[@]}")
name_pattern='^annie-review-[a-z0-9]{8,32}$'
profile_pattern='^(limits|nolimits),(unsetenv-all|unsetenv-image),(ro-tmpfs|default-tmpfs)$'
base_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
go_env=(--env "PATH=/usr/local/go/bin:/go/bin:$base_path" --env GOPATH=/go --env GOMODCACHE=/go/pkg/mod --env GOCACHE=/tmp/go-cache --env GOFLAGS=-mod=readonly --env GOPROXY=off --env GOSUMDB=off --env GOTOOLCHAIN=local)
node_env=(--env "PATH=$base_path" --env npm_config_offline=true)
# The visual container runs as an unprivileged uid with a fixed locale and timezone, and mounts nothing from the host.
visual_env=(--env "PATH=$base_path" --env TZ=UTC --env LANG=C.UTF-8)
visual_user=65534:65534
run_user=
# Throwaway panel: tmpfs config, sqlite database, and a per-run random admin password, created with the panel's own CLI.
# Only loopback exists (--network=none); the daemon and its SFTP listener stay off. Setup failures become a JSON error line.
read -r -d '' visual_setup <<'EOF' || true
set -eu
umask 077
d=/tmp/panel
mkdir -p "$d/data" /tmp/home
key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
od -An -N24 -tx1 /dev/urandom | tr -d ' \n' >"$d/password"
printf '{"logs":"%s/logs","web":{"host":"127.0.0.1:8080"},"panel":{"database":{"dialect":"sqlite3","url":"file:%s/panel.db?cache=shared"},"web":{"files":""},"sessionKey":"%s"},"daemon":{"enable":false,"data":{"root":"%s/data"}}}' "$d" "$d" "$key" "$d" >"$d/config.json"
cd "$d"
panel() { /opt/annie/pufferpanel --config "$d/config.json" "$@"; }
if ! { panel db upgrade >"$d/setup.log" 2>&1 || [ $? = 9 ]; } || ! panel user add --name annie --email annie@example.com --password "$(cat "$d/password")" --admin >>"$d/setup.log" 2>&1 || ! grep -q 'User added' "$d/setup.log"; then
  echo '{"error":"candidate panel seeding failed (db upgrade or user add)"}'; exit 0
fi
panel run >"$d/panel.log" 2>&1 &
exec node /opt/annie/ui-driver.mjs "$1"
EOF

# Flags every profile keeps: no network, read-only root and source, no capabilities, explicit environment only, timeouts.
# A profile may only drop cgroup limits or swap a flag for its Podman 4.9 equivalent.
container_args() {
  local profile=$1 name=$2 seconds=$3 snapshot=$4 image=$5 limits envmode tmpfs key
  shift 5
  local env=("$@") explicit=' HOME TMPDIR '
  IFS=, read -r limits envmode tmpfs <<<"$profile"
  for key in "${env[@]}"; do [[ $key == --env ]] || explicit+="${key%%=*} "; done
  args=(run --rm --name "$name" --label pufferpanel.annie.review=1 --pull=never --network=none --read-only)
  [[ $tmpfs == ro-tmpfs ]] && args+=(--read-only-tmpfs=false)
  args+=(--tmpfs /tmp:rw,exec,nosuid,nodev,size=4g,mode=1777)
  [[ $snapshot == - ]] || args+=(-v "$snapshot:/src:ro")
  if [[ $envmode == unsetenv-all ]]; then args+=(--unsetenv-all); else
    for key in container TERM $("${podman[@]}" image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1); do
      [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo 'unexpected image environment' >&2; return 1; }
      [[ $explicit == *" $key "* ]] || args+=(--unsetenv "$key")
    done
  fi
  args+=(--http-proxy=false "${env[@]}" --env HOME=/tmp/home --env TMPDIR=/tmp)
  [[ $limits == limits ]] && args+=(--memory 8g --memory-swap 8g --cpus 4 --pids-limit 4096)
  [[ -z $run_user ]] || args+=(--user "$run_user")
  args+=(--cap-drop all --security-opt no-new-privileges --stop-timeout 0 --timeout "$((seconds + 30))" --log-driver none -w /tmp --entrypoint /bin/sh "$image")
}
remove_container() {
  local status
  "${podman[@]}" rm --force --ignore "$1" >/dev/null 2>&1 || true
  set +e
  "${podman[@]}" container exists "$1" 2>/dev/null
  status=$?
  set -e
  [[ $status == 1 ]]
}
podman_version() { local v; v=$("${podman[@]}" version --format '{{.Client.Version}}' 2>/dev/null || true); [[ $v =~ ^[0-9A-Za-z.+~-]{1,32}$ ]] && printf '%s\n' "$v" || echo unknown; }
first_line() { grep -m1 -iE "${1:-.}" | tr -d '\000-\037\177' | cut -c1-160 || true; }

case $mode in
  version)
    [[ $# == 2 ]] || usage
    podman_version
    ;;
  prime)
    [[ $# == 6 && $3 == /* && $4 == /* && $5 =~ ^[1-9][0-9]*$ && $6 =~ ^[01]$ ]] || usage
    snapshot=$(realpath -e "$3") log=$4
    # The fixed gate's own image builds, from the exported snapshot rather than the mutable worktree.
    # They run the candidate's Dockerfile with network but without credentials, before review.
    puffer_gate_build_args
    end=$((SECONDS + $5))
    cd "$snapshot"
    for target in node tests; do
      (( end > SECONDS )) || { echo 'sandbox priming deadline exceeded' >&2; exit 1; }
      timeout --signal=TERM --kill-after=30s "$((end - SECONDS))s" "${podman[@]}" build "${PUFFER_MAINT_BUILD_ARGS[@]}" --target "$target" -t "localhost/pufferpanel-maintainer-$target" -f Dockerfile . >>"$log" 2>&1
    done
    # The visual image adds the browser layer and the candidate's panel binary; its failure only disables ui_snapshot.
    visual=-
    if [[ $6 == 1 ]] && (( end > SECONDS )); then
      context=$(mktemp -d)
      cp "$module/visual.Containerfile" "$context/Containerfile"; cp "$module/ui-driver.mjs" "$context/"
      if timeout --signal=TERM --kill-after=30s "$((end - SECONDS))s" "${podman[@]}" build "${PUFFER_MAINT_BUILD_ARGS[@]}" -t localhost/pufferpanel-maintainer-visual -f "$context/Containerfile" "$context" >>"$log" 2>&1; then
        visual=$("${podman[@]}" image inspect --format '{{.Id}}' localhost/pufferpanel-maintainer-visual)
      fi
      rm -rf "$context"
    fi
    printf '%s %s %s\n' "$("${podman[@]}" image inspect --format '{{.Id}}' localhost/pufferpanel-maintainer-tests)" "$("${podman[@]}" image inspect --format '{{.Id}}' localhost/pufferpanel-maintainer-node)" "$visual"
    ;;
  probe)
    # One trivial container per review proves the profile; output is key=value lines, always exit 0 once parsed.
    [[ $# == 4 && $3 == /* && $4 =~ ^[a-f0-9]{64}$ ]] || usage
    snapshot=$(realpath -e "$3") image=$4
    version=$(podman_version)
    check='if [ "$(grep -c : /proc/net/dev)" != 1 ]; then echo "probe: network not isolated"; exit 1; fi
if touch /src/.annie-probe 2>/dev/null; then echo "probe: source writable"; exit 1; fi
if touch /etc/.annie-probe 2>/dev/null; then echo "probe: root writable"; exit 1; fi
touch /tmp/.annie-probe
for v in $(env | cut -d= -f1); do case $v in PATH|HOME|TMPDIR|HOSTNAME|PWD|SHLVL|OLDPWD|_|GOPATH|GOMODCACHE|GOCACHE|GOFLAGS|GOPROXY|GOSUMDB|GOTOOLCHAIN) ;; *) echo "probe: unexpected environment variable $v"; exit 1;; esac; done
echo sandbox-probe-ok'
    cgroup='cgroup|controller|memory[.]max|memory[.]swap|pids[.]max|cpu[.]max|cpu[.]weight|cpuset|resource limits'
    # Only cgroup v1 rootless Podman runs while ignoring limits; its swap-capability warning still enforces them.
    ignored='resource limits are not supported and ignored'
    limits=limits envmode=unsetenv-all tmpfs=ro-tmpfs status=available reason=
    for _ in 1 2 3 4; do
      profile="$limits,$envmode,$tmpfs" name="annie-review-probe$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
      set +e
      out=$(container_args "$profile" "$name" 30 "$snapshot" "$image" "${go_env[@]}" && "${podman[@]}" "${args[@]}" -ec "$check" sandbox-probe 2>&1)
      code=$?
      set -e
      remove_container "$name" || { status=unavailable reason='probe container cleanup failed'; break; }
      if (( code == 0 )) && [[ $out == *sandbox-probe-ok* ]]; then
        # Cgroup v1 rootless Podman warns and ignores limits instead of failing.
        if [[ $limits == limits ]] && grep -qiE "$ignored" <<<"$out"; then status=limited reason="${reason:+$reason; }cgroup limits ignored: $(first_line "$ignored" <<<"$out")"; fi
        printf 'status=%s\nprofile=%s\nreason=%s\nversion=%s\n' "$status" "$profile" "$reason" "$version"; exit 0
      fi
      # Rootless Podman prints cgroup-worded WARN lines (cgroupfs fallback, no systemd session) before real errors;
      # classify and quote only non-warning lines, so the actual Error/crun line decides.
      errors=$(grep -viE '^(WARN|time=)' <<<"$out" || true)
      if [[ $envmode == unsetenv-all && $errors == *'unknown flag: --unsetenv-all'* ]]; then envmode=unsetenv-image reason="${reason:+$reason; }compat: explicit --unsetenv"; continue; fi
      if [[ $tmpfs == ro-tmpfs && $errors == *'unknown flag: --read-only-tmpfs'* ]]; then tmpfs=default-tmpfs reason="${reason:+$reason; }compat: default read-only tmpfs"; continue; fi
      # Only cgroup resource limits may be dropped; the runner VM remains the outer limit.
      if [[ $limits == limits ]] && grep -qiE "$cgroup" <<<"$errors"; then limits=nolimits status=limited reason="${reason:+$reason; }cgroup limits not delegated: $(first_line "$cgroup" <<<"$errors")"; continue; fi
      status=unavailable reason="probe failed: $(first_line '[^[:space:]]' <<<"${errors:-$out}")"; break
    done
    [[ $status == unavailable ]] || status=unavailable reason='probe attempts exhausted'
    printf 'status=unavailable\nprofile=none\nreason=%s\nversion=%s\n' "$reason" "$version"
    ;;
  run)
    [[ $# == 9 && $3 == /* && $5 =~ ^[a-f0-9]{64}$ && $6 =~ $profile_pattern && $7 =~ $name_pattern && $8 =~ ^[1-9][0-9]{0,3}$ && -n $9 ]] || usage
    snapshot=$(realpath -e "$3") image=$5 profile=$6 name=$7 seconds=$8 command=$9
    case $4 in
      # Generated frontend embeds exist only in the primed image; the committed swagger docs stay as reviewed.
      go)
        setup='mkdir -p /tmp/home /tmp/go-cache /tmp/work; cp -R /src/. /tmp/work/; rm -rf /tmp/work/client/frontend/dist; cp -R /build/pufferpanel/client/frontend/dist /tmp/work/client/frontend/dist; chmod -R u+w /tmp/work; cd /tmp/work; exec sh -c "$1"'
        env=("${go_env[@]}")
        ;;
      node)
        setup='mkdir -p /tmp/home /tmp/work; cp -R /src/client/. /tmp/work/; chmod -R u+w /tmp/work; for d in /build/node_modules /build/*/node_modules; do [ -d "$d" ] || continue; rm -rf "/tmp/work/${d#/build/}"; ln -s "$d" "/tmp/work/${d#/build/}"; done; cd /tmp/work; exec sh -c "$1"'
        env=("${node_env[@]}")
        ;;
      *) usage;;
    esac
    container_args "$profile" "$name" "$seconds" "$snapshot" "$image" "${env[@]}"
    set +e
    "${podman[@]}" "${args[@]}" -ec "$setup" sandbox "$command" 2>&1
    status=$?
    set -e
    # Only a status on fd 3 proves Podman ran; the host treats its absence as infrastructure failure.
    printf '%s\n' "$status" >&3
    ;;
  vprobe)
    # The visual container keeps the probed profile and adds a non-root uid; it must run the browser and the panel binary.
    [[ $# == 4 && $3 =~ ^[a-f0-9]{64}$ && $4 =~ $profile_pattern ]] || usage
    image=$3 profile=$4 run_user=$visual_user name="annie-review-vprobe$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
    check='if [ "$(id -u)" = 0 ]; then echo "vprobe: running as root"; exit 1; fi
if [ "$(grep -c : /proc/net/dev)" != 1 ]; then echo "vprobe: network not isolated"; exit 1; fi
for f in /opt/annie/.probe /etc/.probe; do if touch "$f" 2>/dev/null; then echo "vprobe: root writable"; exit 1; fi; done
for v in $(env | cut -d= -f1); do case $v in PATH|HOME|TMPDIR|HOSTNAME|PWD|SHLVL|OLDPWD|_|TZ|LANG) ;; *) echo "vprobe: unexpected environment variable $v"; exit 1;; esac; done
mkdir -p /tmp/home; cd /tmp
v=$(chromium-browser --version 2>/dev/null) || { echo "vprobe: chromium does not start"; exit 1; }
/opt/annie/pufferpanel version >/dev/null 2>&1 || { echo "vprobe: candidate panel binary does not run"; exit 1; }
[ -r /opt/annie/ui-driver.mjs ] || { echo "vprobe: driver unreadable"; exit 1; }
echo "browser=$v"; echo visual-probe-ok'
    set +e
    out=$(container_args "$profile" "$name" 60 - "$image" "${visual_env[@]}" && "${podman[@]}" "${args[@]}" -ec "$check" visual-probe 2>&1)
    code=$?
    set -e
    remove_container "$name" || { printf 'status=unavailable\nreason=visual probe container cleanup failed\nbrowser=\n'; exit 0; }
    if (( code == 0 )) && [[ $out == *visual-probe-ok* ]]; then
      browser=$(grep -m1 '^browser=' <<<"$out" | cut -d= -f2- | tr -cd '[:alnum:] .+_-' | cut -c1-60)
      printf 'status=available\nreason=\nbrowser=%s\n' "$browser"; exit 0
    fi
    printf 'status=unavailable\nreason=visual probe failed: %s\nbrowser=\n' "$(grep -viE '^(WARN|time=)' <<<"$out" | first_line '[^[:space:]]')"
    ;;
  visual)
    [[ $# == 7 && $3 =~ ^[a-f0-9]{64}$ && $4 =~ $profile_pattern && $5 =~ $name_pattern && $6 =~ ^[1-9][0-9]{0,3}$ && $7 == '{'* ]] || usage
    image=$3 profile=$4 name=$5 seconds=$6 input=$7 run_user=$visual_user
    container_args "$profile" "$name" "$seconds" - "$image" "${visual_env[@]}"
    set +e
    "${podman[@]}" "${args[@]}" -ec "$visual_setup" visual "$input"
    status=$?
    set -e
    printf '%s\n' "$status" >&3
    ;;
  kill)
    [[ $# == 3 && $3 =~ $name_pattern ]] || usage
    remove_container "$3" || { echo 'sandbox container removal unverified' >&2; exit 1; }
    ;;
  *) usage;;
esac
