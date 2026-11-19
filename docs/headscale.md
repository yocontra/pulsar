# Self-hosted control server (Headscale)

The agent mesh also runs on [Headscale](https://headscale.net), an open-source, self-hosted Tailscale control server. Use it when traffic and device data must stay on your own network. The coordination server runs on your infrastructure, and WireGuard traffic goes directly between your machines. Headscale serves a single tailnet; its authors describe it as suitable for personal use or a small organization ([FAQ](https://headscale.net/stable/about/faq/)).

Pulsar finds out which control server a machine uses from `tailscale debug prefs` (`ControlURL`). `pulsar mesh on` and `pulsar doctor --mesh` print it, for example `control server self-hosted (headscale.corp.example)`. They skip the checks that exist only on tailscale.com: the admin console, the HTTPS Certificates toggle and `tailscale cert`.

## What works the same

- The Tailscale client, `tailscale status` and `tailscale whois`. Pulsar uses them unchanged.
- The addresses. Headscale assigns addresses from Tailscale's ranges (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`). Its config requires subsets of these ranges ([config-example.yaml, `prefixes`](https://github.com/juanfont/headscale/blob/v0.29.7/config-example.yaml)). Pulsar still binds only those addresses.
- Linking. Machines of the same Headscale user link on their own, as described in [federation.md](federation.md). Ownership checks the user's login and the numeric user id. Headscale can give two users the same login (a local user `ada` and an OIDC user `ada` with no email), but never the same id.
- Logins. Headscale names a user by their email, else by the bare user name (`ada`). The `[human operator - <name>]` tag uses the display name, else this login.
- Tagged nodes. A node with ACL tags is owned by `tagged-devices`, as on tailscale.com. It joins only after `pulsar mesh allow <node>` on your machines and `pulsar mesh owner <login>` on the node.

## Before you start

1. **MagicDNS** must be on. In the Headscale config, set `dns.magic_dns: true` and a `dns.base_domain` you control, for example `mesh.corp.example`. Each machine is then `<machine>.mesh.corp.example`. The `server_url` must not be inside the base domain; Headscale refuses that.
2. **Relays.** The default `derp.urls` uses relay servers that Tailscale runs. If no traffic may leave your network, turn on the embedded DERP server (`derp.server.enabled: true`) and remove Tailscale's map from `derp.urls`.
3. **Join each machine:** `tailscale up --login-server https://headscale.corp.example`. Then approve it (`headscale nodes register ...`), or use a pre-auth key (`--authkey`).
4. **Phones.** In the Tailscale app, open the options menu and choose **Use custom coordination server** (iOS) or **Use an alternate server** (Android), then enter your Headscale URL ([iOS](https://headscale.net/stable/usage/connect/apple/), [Android](https://headscale.net/stable/usage/connect/android/)).

## The certificate

Headscale cannot issue certificates: `tailscale cert` needs the control server to publish an ACME DNS record, and Headscale does not implement that endpoint (`/machine/set-dns` returns "not implemented", [noise.go](https://github.com/juanfont/headscale/blob/v0.29.7/hscontrol/noise.go)). So bring your own certificate for each machine's MagicDNS name:

```bash
pulsar mesh on --cert /etc/pulsar/node.crt --key /etc/pulsar/node.key --ca /etc/pulsar/root.crt
```

- `--cert`: PEM, the server certificate first, then any intermediates. Its subject alternative name must be the machine's MagicDNS name, for example `studio.mesh.corp.example`.
- `--key`: its private key. Other users must not read it (`chmod 600`; group-readable for a renewer is allowed with a note).
- `--ca`: the root that issued it, when it is not a public CA. Pulsar on this machine then trusts certificates from that root when it links to the others, so pass it on every machine. On a Node release without `tls.setDefaultCACertificates`, `pulsar mesh on` says so; then also set `NODE_EXTRA_CA_CERTS` to the root for the service.

`pulsar mesh on` checks the files before it saves their paths (in `settings.json` as `tls`): the key matches the certificate, the name matches, the dates are valid, the chain is in order, the certificate allows server authentication, and the root issued it. `pulsar doctor --mesh` runs the same checks at any time. Pulsar reads the files where they are and checks them every minute. When your renewer replaces them, the daemon loads the new certificate without dropping connections. If the new files fail the checks, the daemon keeps the old certificate and logs why.

You can use any internal CA:

- **step-ca** (smallstep): issue short-lived certificates with its ACME server or `step ca certificate studio.mesh.corp.example node.crt node.key`, and renew them with `step ca renew --daemon`.
- **Corporate PKI** (AD CS, Vault PKI and similar): request a TLS server certificate for each MagicDNS name.
- **openssl**: `scripts/live/headscale.sh` creates a root, an intermediate and the leaf certificates for its test rig.

Every device that opens the app must trust the root: on phones, install it through MDM or a configuration profile (on iOS, also turn on full trust under Settings → General → About → Certificate Trust Settings). Apple devices accept a certificate from a private root only if it has a subject alternative name, the server authentication usage, and a validity of 825 days or less ([Apple: requirements for trusted certificates](https://support.apple.com/en-us/103769)). `pulsar doctor` warns about longer certificates.

A certificate of your own also works on tailscale.com. When `tls` is set, Pulsar uses it instead of `tailscale cert`.

## Passkeys and the relying party

The WebAuthn relying party (RP) id is the tailnet's MagicDNS suffix, which every machine shares. On Headscale it is `dns.base_domain`. For `studio.mesh.corp.example` it is `mesh.corp.example`. Pulsar never uses the broader registrable domain (`corp.example`), because every other site under it could then use these passkeys.

Browsers refuse an RP id that is a public suffix or a single label. With a base domain such as `internal`, `lan` or `home.arpa`, Pulsar uses each machine's own name as the RP id. Passkeys then work only on the machine that registered them, and approvals relayed through another machine's app do not work. `pulsar doctor --mesh` says so. Use a base domain under a domain you own to avoid this.

To choose the RP id yourself, run `pulsar mesh on --rp-id <domain>`, or set `rpId` in `settings.json`. The domain must be the machine's MagicDNS name or a domain above it, and must not be a public suffix. Use the same value on every machine. Changing it later makes existing passkeys unusable; register them again with Prove Human.

## ACLs and tags

Pulsar needs only TCP to each machine's app port (7337 by default, or `PULSAR_HTTP_PORT`) between your own machines and from your phone. A Headscale policy that allows your user to reach their own devices is enough:

```json
{
	"tagOwners": { "tag:server": ["ada@"] },
	"acls": [
		{ "action": "accept", "src": ["ada@"], "dst": ["ada@:7337", "tag:server:7337"] },
		{ "action": "accept", "src": ["tag:server"], "dst": ["ada@:7337"] }
	]
}
```

## Test it

`scripts/live/headscale.sh` runs the whole setup in a private Docker network: Headscale (pinned), a test CA, two Linux machines with Pulsar from this checkout and a tagged machine. It then runs the cross-machine checks (`scripts/live/checks.ts`): link, send and reply, Ask, transcripts, Stop refused without a passkey session, and the outbox while a machine is paused. It removes everything it created when it finishes (`KEEP=1` keeps it).
