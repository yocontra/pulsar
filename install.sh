#!/usr/bin/env bash
{
# pulsar installer: makes sure a recent Node.js exists, then runs `pulsar setup`.
#
#   curl -fsSL https://raw.githubusercontent.com/yocontra/pulsar/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --yes --all-detected
#
# The whole script is one brace group, so bash reads all of it before running
# anything: a download cut off midway is a syntax error, never half an install.
set -euo pipefail

NODE_VERSION="${PULSAR_NODE_VERSION:-24.14.1}"
MIN_MAJOR=22
MIN_MINOR=13
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/pulsar"

say() { printf 'pulsar: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

node_ok() {
	command -v "$1" >/dev/null 2>&1 || return 1
	local v major minor
	v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
	major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
	[ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }
}

install_node() {
	local os arch dir url
	case "$(uname -s)" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		*) die "unsupported OS $(uname -s); install Node.js ${MIN_MAJOR}.${MIN_MINOR}+ and run: npx pulsar setup" ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		*) die "unsupported CPU $(uname -m)" ;;
	esac
	dir="$DATA/node-v${NODE_VERSION}-${os}-${arch}"
	if [ ! -x "$dir/bin/node" ]; then
		url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
		say "installing a private Node.js ${NODE_VERSION} into ${dir}"
		mkdir -p "$DATA"
		curl -fsSL "$url" | tar -xz -C "$DATA"
	fi
	export PATH="$dir/bin:$PATH"
}

main() {
	if node_ok node; then
		say "using $(command -v node) ($(node -v))"
	else
		install_node
	fi
	# Piped into bash, stdin is the script itself: ask the question on the terminal instead.
	if [ ! -t 0 ] && (exec </dev/tty) 2>/dev/null; then
		exec npx --yes pulsar@latest setup "$@" </dev/tty
	fi
	exec npx --yes pulsar@latest setup "$@"
}

main "$@"
}
