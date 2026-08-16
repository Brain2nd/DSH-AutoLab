#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
dsh_bin="${DSH_BIN:-}"
if [[ -z "$dsh_bin" ]]; then
  dsh_bin="$(command -v dsh 2>/dev/null || true)"
fi
smoke_parent="${TMPDIR:-/tmp}"
smoke_parent="${smoke_parent%/}"
[[ -n "$smoke_parent" ]] || smoke_parent='/tmp'
smoke_root="$(mktemp -d "$smoke_parent/dsh-local-session-messaging.XXXXXX")"
smoke_home="$smoke_root/home"
pack_dir="$smoke_root/pack"
server_log="$smoke_root/web.log"
composed_config="$smoke_root/cordis.composed.yml"
removed_config="$smoke_root/cordis.removed.yml"
tar_listing="$smoke_root/tar.contents"
server_pid=''

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "${KEEP_DSH_SMOKE:-0}" == '1' ]]; then
    printf 'Preserved smoke directory: %s\n' "$smoke_root"
    return
  fi
  case "$smoke_root" in
    "$smoke_parent"/dsh-local-session-messaging.*) rm -rf -- "$smoke_root" ;;
    *) printf 'Refusing to clean unexpected path: %s\n' "$smoke_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

fail() {
  printf 'dsh install smoke failed: %s\n' "$1" >&2
  if [[ -f "$server_log" ]]; then
    tail -n 120 "$server_log" >&2
  fi
  exit 1
}

[[ -x "$dsh_bin" ]] || fail 'dsh executable was not found'
[[ "$($dsh_bin --version)" == '0.1.0-rc.6' ]] || fail 'this fixture requires DSH 0.1.0-rc.6'
for executable in node npm pnpm tar curl; do
  command -v "$executable" >/dev/null 2>&1 || fail "$executable executable was not found"
done

pnpm --dir "$project_root" build
mkdir -p "$pack_dir"
tarball_name="$(cd "$project_root" && npm pack --silent --pack-destination "$pack_dir")"
[[ "$tarball_name" == "${tarball_name##*/}" && "$tarball_name" == *.tgz ]] \
  || fail "npm pack returned an unexpected filename: $tarball_name"
tarball_path="$pack_dir/$tarball_name"
[[ -f "$tarball_path" ]] || fail "npm pack did not create $tarball_path"
tar -tzf "$tarball_path" >"$tar_listing"

for required_path in \
  package/package.json \
  package/cordis.patch.yml \
  package/lib/service.js \
  package/lib/local.js \
  package/lib/tool.js \
  package/lib/command.js \
  package/lib/prompt.js
do
  grep -Fxq "$required_path" "$tar_listing" \
    || fail "npm tarball omitted $required_path"
done

DSH_HOME="$smoke_home" "$dsh_bin" plugin --profile web add "$tarball_path"
DSH_HOME="$smoke_home" "$dsh_bin" --profile web --dump-config >"$composed_config"

for plugin_name in \
  dsh-local-session-messaging/local \
  dsh-local-session-messaging/tool \
  dsh-local-session-messaging/command \
  dsh-local-session-messaging/prompt
do
  grep -Fq "name: $plugin_name" "$composed_config" \
    || fail "composed web profile omitted $plugin_name"
done

port="$(node -e "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close() })")"
DSH_HOME="$smoke_home" "$dsh_bin" web --host 127.0.0.1 --port "$port" >"$server_log" 2>&1 &
server_pid=$!

ready=0
for _attempt in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || fail 'web process exited before readiness'
  sleep 0.2
done
[[ "$ready" == '1' ]] || fail 'web profile did not return HTTP 200 within 20 seconds'

if grep -Ei '(error|failed).*[dD][sS][hH]-local-session-messaging|[dD][sS][hH]-local-session-messaging.*(error|failed)' "$server_log" >/dev/null; then
  fail 'plugin load error appeared in the web log'
fi

kill -TERM "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=''

state_root="$smoke_home/local-session-messaging"
[[ -d "$state_root" ]] || fail 'provider did not create its owner-only state directory'
node -e '
  const { statSync } = require("node:fs")
  const mode = statSync(process.argv[1]).mode & 0o777
  if ((mode & 0o077) !== 0) {
    console.error(`state directory permissions are ${mode.toString(8)}, expected owner-only`)
    process.exit(1)
  }
' "$state_root" || fail 'provider state directory permissions are not owner-only'

DSH_HOME="$smoke_home" "$dsh_bin" plugin --profile web remove dsh-local-session-messaging
DSH_HOME="$smoke_home" "$dsh_bin" --profile web --dump-config >"$removed_config"
if grep -Fq 'dsh-local-session-messaging' "$removed_config"; then
  fail 'package-name uninstall left plugin rows in the composed profile'
fi
if grep -Fq 'dsh-local-session-messaging' "$smoke_home/profiles/web/package.json"; then
  fail 'package-name uninstall left the dependency or bundle registration in the profile manifest'
fi
[[ -d "$state_root" ]] || fail 'uninstall unexpectedly deleted the durable mailbox state'

printf 'DSH rc.6 tarball install/start/uninstall smoke passed on http://127.0.0.1:%s/\n' "$port"
