#!/usr/bin/env bash
# Builds this checkout, installs it in the test container as user `dev`, runs
# setup with the agent mesh, and starts the daemon there under tmux (the
# container has no systemd). Then starts the fake agents.
#
#   scripts/live/pack-and-push.sh [N_FAKE_AGENTS]
#
# Touches only the container. Needs: docker, bun, npm on this machine; the
# container with tailscaled up and signed in as you.
set -euo pipefail

C="${CONTAINER:-pulsar-meshnode}"
N="${1:-6}"
# Everything in the container runs with its own state folder and scanners off.
LIVE_ENV='export PULSAR_HOME=$HOME/.pulsar-live PULSAR_NO_SCAN=1;'

# Safety: this script only acts inside the container.
if [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" != "true" ]; then
	echo "container $C is not running" >&2
	exit 2
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== build and pack"
bun run build >/dev/null
TGZ="$(npm pack --silent | tail -1)"
trap 'rm -f "$ROOT/$TGZ"' EXIT

echo "== copy into $C"
docker cp "$TGZ" "$C:/tmp/pulsar.tgz"
docker cp scripts/live/fake-agents.ts "$C:/home/dev/fake-agents.ts"
docker exec "$C" chown dev:dev /home/dev/fake-agents.ts

echo "== install (global npm, as root)"
docker exec "$C" npm install -g /tmp/pulsar.tgz --silent

# `tailscale cert` and `whois` from a non-root user need operator rights.
docker exec "$C" tailscale set --operator=dev

echo "== stop anything running from a previous round"
docker exec -u dev "$C" bash -lc "$LIVE_ENV tmux kill-session -t pulsar 2>/dev/null; tmux kill-session -t fake 2>/dev/null; pulsar stop >/dev/null 2>&1 || true"

echo "== setup as dev (no agents to configure here: --client none, mesh only)"
# The global install, not an older `pulsar` shim on dev's PATH; setup then updates the shim.
PULSAR_BIN="$(docker exec "$C" npm prefix -g)/bin/pulsar"
docker exec -u dev "$C" bash -lc "$LIVE_ENV $PULSAR_BIN setup --yes --client none --mesh" || {
	echo "setup failed; see above"
	exit 1
}

echo "== daemon under tmux (no systemd here)"
# Setup leaves an on-demand daemon running; stop it first so the service daemon starts clean.
docker exec -u dev "$C" bash -lc "$LIVE_ENV pulsar stop >/dev/null 2>&1 || true"
docker exec -u dev "$C" bash -lc "$LIVE_ENV tmux new -d -s pulsar \"env PULSAR_HOME=\$PULSAR_HOME PULSAR_NO_SCAN=1 pulsar daemon --service 2>&1 | tee -a \$PULSAR_HOME/service.log\""

URL="https://$(docker exec "$C" tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'):7337"
echo "== waiting for $URL/api/v1/hello"
for _ in $(seq 1 30); do
	if curl -fsS "$URL/api/v1/hello" >/dev/null 2>&1; then break; fi
	sleep 1
done
curl -fsS "$URL/api/v1/hello" | jq -c '{machine, version, machines, agents}'

echo "== $N fake agents under tmux"
docker exec -u dev "$C" bash -lc "$LIVE_ENV tmux new -d -s fake \"env PULSAR_HOME=\$PULSAR_HOME node ~/fake-agents.ts $N 2>&1 | tee ~/fake-agents.log\""
sleep 3
docker exec -u dev "$C" bash -lc 'tail -3 ~/fake-agents.log'
echo "== done. Watch: docker exec -it -u dev $C tmux attach -t pulsar"
