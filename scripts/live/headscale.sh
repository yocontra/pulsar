#!/usr/bin/env bash
# Live test of the agent mesh on a self-hosted control server (Headscale),
# entirely inside a private Docker network:
#
#   pulsar-hs-net      internal bridge network (no route out)
#   pulsar-hs-control  Headscale (pinned), TLS from a test CA, embedded DERP
#   pulsar-hs-a / -b   Linux nodes: tailscaled joined with pre-auth keys for
#                      user `ada`, Pulsar from this checkout, own CA-issued certs
#   pulsar-hs-tagged   a tagged node (tag:server), tailscaled only
#
#   scripts/live/headscale.sh [all|up|install|checks|down]   (default: all)
#
# `all` runs up, install, checks, then down (KEEP=1 keeps everything running).
# It never touches your tailnet, your daemon or other containers: it creates
# and removes only the Docker objects named above (and image pulsar-hs-node).
# Generated files (CA, configs, logs, JSON samples) go to $HS_WORK.
set -euo pipefail

HEADSCALE_IMAGE=headscale/headscale:v0.29.7
NODE_IMAGE=pulsar-hs-node:test
NET=pulsar-hs-net
CONTROL=pulsar-hs-control
NODES=(pulsar-hs-a pulsar-hs-b)
TAGGED=pulsar-hs-tagged
BASE_DOMAIN=mesh.corp.example
USER_NAME=ada
PORT=7337
N_FAKE="${N_FAKE:-6}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/live/headscale"
HS_WORK="${HS_WORK:-${TMPDIR:-/tmp}/pulsar-headscale-live}"
LIVE_ENV='export PULSAR_HOME=$HOME/.pulsar-live PULSAR_NO_SCAN=1;'

log() { printf '== %s\n' "$*"; }
dx() { docker exec "$@"; }

down() {
	log "remove containers, network and image (exact names only)"
	for c in "$TAGGED" "${NODES[@]}" "$CONTROL"; do
		docker rm -f "$c" >/dev/null 2>&1 || true
	done
	docker network rm "$NET" >/dev/null 2>&1 || true
	docker image rm "$NODE_IMAGE" >/dev/null 2>&1 || true
}

# A two-level test PKI: root → intermediate → leaf. Leaf files carry the
# chain (leaf, intermediate); devices trust only the root.
make_ca() {
	local d="$HS_WORK/pki"
	rm -rf "$d"
	mkdir -p "$d"
	(
		cd "$d"
		openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.crt -days 3650 \
			-subj "/CN=Pulsar Headscale Test Root" \
			-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
		openssl req -newkey rsa:2048 -nodes -keyout int.key -out int.csr -subj "/CN=Pulsar Headscale Test Intermediate" 2>/dev/null
		printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' >int.ext
		openssl x509 -req -in int.csr -CA root.crt -CAkey root.key -CAcreateserial -out int.crt -days 1825 -extfile int.ext 2>/dev/null
	)
	for name in "$CONTROL" "${NODES[@]/%/.$BASE_DOMAIN}"; do
		leaf "$name"
	done
}

leaf() {
	local d="$HS_WORK/pki" n="$1"
	(
		cd "$d"
		openssl req -newkey rsa:2048 -nodes -keyout "$n.key" -out "$n.csr" -subj "/CN=$n" 2>/dev/null
		printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$n" >"$n.ext"
		openssl x509 -req -in "$n.csr" -CA int.crt -CAkey int.key -CAcreateserial -out "$n.leaf" -days 397 -extfile "$n.ext" 2>/dev/null
		cat "$n.leaf" int.crt >"$n.crt"
		chmod 644 "$n.key"
	)
}

up() {
	command -v docker >/dev/null && command -v openssl >/dev/null
	down
	mkdir -p "$HS_WORK/samples"
	log "test CA and certificates in $HS_WORK/pki"
	make_ca

	log "network $NET (internal: no route out)"
	docker network create --internal "$NET" >/dev/null

	log "headscale ($HEADSCALE_IMAGE)"
	local cfg="$HS_WORK/headscale"
	rm -rf "$cfg"
	mkdir -p "$cfg/tls"
	cp "$HERE/config.yaml" "$HERE/policy.hujson" "$cfg/"
	cp "$HS_WORK/pki/$CONTROL.crt" "$cfg/tls/control.crt"
	cp "$HS_WORK/pki/$CONTROL.key" "$cfg/tls/control.key"
	docker run -d --name "$CONTROL" --hostname "$CONTROL" --network "$NET" \
		-v "$cfg:/etc/headscale:ro" "$HEADSCALE_IMAGE" serve >/dev/null
	for _ in $(seq 1 30); do
		dx "$CONTROL" headscale users list >/dev/null 2>&1 && break
		sleep 1
	done
	dx "$CONTROL" headscale users create "$USER_NAME" >/dev/null
	local uid
	uid="$(dx "$CONTROL" headscale users list -o json | jq -r ".[] | select(.name==\"$USER_NAME\") | .id")"

	log "node image $NODE_IMAGE"
	docker build -q -t "$NODE_IMAGE" -f "$HERE/Dockerfile.node" "$HERE" >/dev/null

	for n in "${NODES[@]}"; do
		log "node $n"
		docker run -d --name "$n" --hostname "$n" --network "$NET" \
			--cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun \
			"$NODE_IMAGE" sleep infinity >/dev/null
		docker cp "$HS_WORK/pki/root.crt" "$n:/usr/local/share/ca-certificates/pulsar-hs-root.crt"
		dx "$n" update-ca-certificates >/dev/null 2>&1
		dx -d "$n" sh -c 'tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1'
		local key
		key="$(dx "$CONTROL" headscale preauthkeys create --user "$uid" -e 1h -o json | jq -r .key)"
		for _ in $(seq 1 20); do
			dx "$n" tailscale status >/dev/null 2>&1 && break
			dx "$n" tailscale up --login-server "https://$CONTROL" --authkey "$key" --hostname "$n" --timeout 20s >/dev/null 2>&1 && break
			sleep 1
		done
	done

	log "tagged node $TAGGED (tag:server)"
	local tkey
	tkey="$(dx "$CONTROL" headscale preauthkeys create --tags tag:server -e 1h -o json | jq -r .key)"
	docker run -d --name "$TAGGED" --hostname "$TAGGED" --network "$NET" \
		--cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun \
		"$NODE_IMAGE" sleep infinity >/dev/null
	docker cp "$HS_WORK/pki/root.crt" "$TAGGED:/usr/local/share/ca-certificates/pulsar-hs-root.crt"
	dx "$TAGGED" update-ca-certificates >/dev/null 2>&1
	dx -d "$TAGGED" sh -c 'tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1'
	for _ in $(seq 1 20); do
		dx "$TAGGED" tailscale up --login-server "https://$CONTROL" --authkey "$tkey" --hostname "$TAGGED" --timeout 20s >/dev/null 2>&1 && break
		sleep 1
	done

	log "MagicDNS and reachability"
	local a="${NODES[0]}" b="${NODES[1]}"
	for _ in $(seq 1 30); do
		dx "$a" tailscale ping -c 1 "$b.$BASE_DOMAIN" >/dev/null 2>&1 && break
		sleep 1
	done
	dx "$a" tailscale ping -c 1 "$b.$BASE_DOMAIN"
	dx "$a" getent hosts "$b.$BASE_DOMAIN"

	log "JSON samples in $HS_WORK/samples"
	dx "$a" tailscale status --json >"$HS_WORK/samples/status-a.json"
	dx "$a" tailscale debug prefs >"$HS_WORK/samples/prefs-a.json" || true
	local bip tip
	bip="$(dx "$b" tailscale ip -4)"
	tip="$(dx "$TAGGED" tailscale ip -4)"
	dx "$a" tailscale whois --json "$bip:1" >"$HS_WORK/samples/whois-b.json"
	dx "$a" tailscale whois --json "$tip:1" >"$HS_WORK/samples/whois-tagged.json"
	dx "$CONTROL" headscale nodes list
}

install() {
	log "build and pack this checkout"
	cd "$ROOT"
	bun run build >/dev/null
	local tgz
	tgz="$(npm pack --silent | tail -1)"
	trap 'rm -f "$ROOT/$tgz"' RETURN
	for n in "${NODES[@]}"; do
		local dns="$n.$BASE_DOMAIN"
		log "install on $n"
		docker cp "$tgz" "$n:/tmp/pulsar.tgz"
		docker cp scripts/live/fake-agents.ts "$n:/home/dev/fake-agents.ts"
		dx "$n" mkdir -p /home/dev/tls
		docker cp "$HS_WORK/pki/$dns.crt" "$n:/home/dev/tls/node.crt"
		docker cp "$HS_WORK/pki/$dns.key" "$n:/home/dev/tls/node.key"
		docker cp "$HS_WORK/pki/root.crt" "$n:/home/dev/tls/root.crt"
		dx "$n" sh -c 'chown -R dev:dev /home/dev && chmod 600 /home/dev/tls/node.key'
		dx "$n" npm install -g /tmp/pulsar.tgz --silent --offline --no-audit --no-fund
		# `whois` from a non-root user needs operator rights.
		dx "$n" tailscale set --operator=dev
		dx -u dev "$n" bash -lc "$LIVE_ENV tmux kill-session -t pulsar 2>/dev/null; tmux kill-session -t fake 2>/dev/null; true"
		log "setup on $n (bring-your-own certificate)"
		dx -u dev "$n" bash -lc "$LIVE_ENV pulsar setup --yes --client none --mesh --cert ~/tls/node.crt --key ~/tls/node.key --ca ~/tls/root.crt" |
			tee "$HS_WORK/setup-$n.log"
		dx -u dev "$n" bash -lc "$LIVE_ENV tmux new -d -s pulsar \"env PULSAR_HOME=\$PULSAR_HOME PULSAR_NO_SCAN=1 pulsar daemon --service 2>&1 | tee -a \$PULSAR_HOME/service.log\""
	done
	for n in "${NODES[@]}"; do
		local url="https://$n.$BASE_DOMAIN:$PORT"
		for _ in $(seq 1 30); do
			dx "${NODES[0]}" curl -fsS "$url/api/v1/hello" >/dev/null 2>&1 && break
			sleep 1
		done
		dx "${NODES[0]}" curl -fsS "$url/api/v1/hello" | jq -c '{machine, version, machines}'
	done
	local a="${NODES[0]}" b="${NODES[1]}"
	# Both machines need agents to show in each other's pool tree; the checks
	# message only the ones on $b.
	log "$N_FAKE fake agents on $b, 2 on $a"
	dx -u dev "$b" bash -lc "$LIVE_ENV tmux new -d -s fake \"env PULSAR_HOME=\$PULSAR_HOME node ~/fake-agents.ts $N_FAKE 2>&1 | tee ~/fake-agents.log\""
	dx -u dev "$a" bash -lc "$LIVE_ENV tmux new -d -s fake \"env PULSAR_HOME=\$PULSAR_HOME FAKE_NAMES=docs-writer,infra node ~/fake-agents.ts 2>&1 | tee ~/fake-agents.log\""
	sleep 3
	for n in "${NODES[@]}"; do
		log "doctor --mesh on $n"
		dx -u dev "$n" bash -lc "$LIVE_ENV pulsar doctor --mesh" | tee "$HS_WORK/doctor-$n.log" || true
	done
}

# The certificate's notAfter that $b serves, as seen from $a.
served_until() {
	dx -u dev -e NODE_EXTRA_CA_CERTS=/home/dev/tls/root.crt "${NODES[0]}" node -e '
		const s = require("tls").connect({ host: process.argv[1], port: +process.argv[2], servername: process.argv[1] }, () => {
			console.log(s.getPeerCertificate().valid_to); s.end();
		});' "${NODES[1]}.$BASE_DOMAIN" "$PORT"
}

checks() {
	local a="${NODES[0]}" b="${NODES[1]}"
	log "cross-machine checks (requests start inside $a, as user $USER_NAME)"
	cd "$ROOT"
	VIA_CONTAINER="$a" VIA_CA=/home/dev/tls/root.crt \
		MAC_URL="https://$a.$BASE_DOMAIN:$PORT" REMOTE_URL="https://$b.$BASE_DOMAIN:$PORT" \
		REMOTE_MACHINE="$b" CONTAINER="$b" \
		bun scripts/live/checks.ts | tee "$HS_WORK/checks.log"

	log "certificate renewal on $b: a bad file is refused, a good one is loaded"
	local before after dns="$b.$BASE_DOMAIN" failed=0
	before="$(served_until)"
	# A certificate for another name first: the daemon must keep the old one.
	leaf "wrong.$BASE_DOMAIN"
	docker cp "$HS_WORK/pki/wrong.$BASE_DOMAIN.crt" "$b:/home/dev/tls/node.crt.new"
	docker cp "$HS_WORK/pki/wrong.$BASE_DOMAIN.key" "$b:/home/dev/tls/node.key.new"
	dx "$b" sh -c 'cd /home/dev/tls && chown dev:dev node.*.new && chmod 600 node.key.new && mv node.key.new node.key && mv node.crt.new node.crt'
	local i
	for i in $(seq 1 90); do
		dx -u dev "$b" bash -lc 'grep -q "new certificate not loaded" ~/.pulsar-live/daemon.log' && break
		sleep 1
	done
	after="$(served_until)"
	if [ "$after" = "$before" ] && [ "$i" -lt 90 ]; then
		echo "PASS  wrong-name renewal refused, old certificate kept ($after)"
	else
		echo "FAIL  wrong-name renewal ($before → $after)"
		failed=1
	fi
	# Now a good one with a new expiry.
	sleep 2
	leaf "$dns"
	docker cp "$HS_WORK/pki/$dns.crt" "$b:/home/dev/tls/node.crt.new"
	docker cp "$HS_WORK/pki/$dns.key" "$b:/home/dev/tls/node.key.new"
	dx "$b" sh -c 'cd /home/dev/tls && chown dev:dev node.*.new && chmod 600 node.key.new && mv node.key.new node.key && mv node.crt.new node.crt'
	for i in $(seq 1 90); do
		dx -u dev "$b" bash -lc 'grep -q "certificate reloaded" ~/.pulsar-live/daemon.log' && break
		sleep 1
	done
	after="$(served_until)"
	if [ "$i" -lt 90 ] && [ -n "$after" ] && [ "$after" != "$before" ]; then
		echo "PASS  renewed certificate loaded without a restart (now valid to $after)"
	else
		echo "FAIL  renewed certificate not loaded ($before → $after)"
		failed=1
	fi
	return "$failed"
}

mkdir -p "$HS_WORK"
case "${1:-all}" in
up) up ;;
install) install ;;
checks) checks ;;
down) down ;;
all)
	[ "${KEEP:-}" = 1 ] || trap down EXIT
	up
	install
	checks
	;;
*)
	echo "usage: $0 [all|up|install|checks|down]" >&2
	exit 2
	;;
esac
