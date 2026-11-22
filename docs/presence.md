# Presence checks

Some commands change who can reach your agents, or how you prove you are you:

- `pulsar mesh allow|deny|forget <node>`
- `pulsar mesh owner <login>`
- `pulsar passkeys remove <id>`

Anyone on the machine can run them, agents included. An agent runs with your permissions, so it must never be able to let a new machine in, or remove your passkey, on its own. Before the change, Pulsar asks you to confirm it. It asks in two places at once, and the first answer counts:

- **On the machine**: Touch ID (or Apple Watch, or your login password) on macOS, Windows Hello on Windows, polkit on a Linux desktop.
- **In the Pulsar app**: a confirm card in Needs you, with a push to your phone. Answer it with your passkey, or with a browser you already proved in ([Prove Human](app.md#prove-human)).

Both name the exact change and who asked. For example, on macOS:

> "osascript" is trying to confirm a Pulsar change: forget pulsar-meshnode and its machine id (pulsar mesh) (asked by agent claude@pulsar (claude) on studio).

Say no in either place and the change is refused. With no answer in 3 minutes, it times out. Every check asks again; a past yes never counts for the next change.

On a headless server reached over SSH, with no system prompt and no app yet, a person at a real terminal can confirm by typing back a word the daemon prints. An agent's request never gets this fallback.

## Why an agent can't confirm

- Only the daemon decides that a change is confirmed. Nothing a client sends can mark it so.
- The daemon shows the system prompt itself. Only a passkey signature for that card, or a session from Prove Human, answers the app card. An agent can't produce either.
- After two denials in an hour, each next check waits longer (up to 30 minutes), so an agent can't keep asking until you say yes without looking.
- Every request and outcome is audited. Pool changes and passkey removals show in open app tabs and are pushed as security notices.

## What it doesn't stop

- **Same-user processes.** A program running as you can edit the daemon's database, replace the installed Pulsar, or drive your GUI. That is the same-user limit in [SECURITY.md](../SECURITY.md). The check stops agents' tool calls from making these changes without you. It does not stop malware.
- **A reflexive yes.** The prompt names the change and the agent. Read it. If you didn't start the change, say no.
- **Who asked.** The name comes from the daemon's registry for that connection. A client that skips `hello` shows as "a terminal".
- **Other machines.** A card for a request from a terminal is shown on "operator", which only this machine's app lists. A request from an agent shows wherever that agent shows.

## Per platform

| Platform | System prompt | Shown when | Notes |
| --- | --- | --- | --- |
| macOS | Touch ID / Apple Watch / password, through `osascript -l JavaScript` (LocalAuthentication) | The daemon runs in your login session (the launchd agent, or a daemon started from a shell in it) | Over SSH there is no GUI session, so the app path is used. |
| Windows | Windows Hello, through Windows PowerShell 5 (WinRT `UserConsentVerifier`) | Windows Hello is set up | |
| Linux | polkit `dev.pulsar.confirm`, `pkcheck --allow-user-interaction` | A graphical session (`DISPLAY` or `WAYLAND_DISPLAY`), not over SSH, and the action is installed | Without the action, polkit can only show a stock "run as the super user" message that doesn't name the change, so Pulsar uses the app. |
| Other, headless, SSH, containers | none | | The app card; with no passkey either, the word on your terminal (a person at a terminal only). |

`PULSAR_NATIVE_PRESENCE=off` turns the system prompt off. The variable can only take a way to ask away. It can never say yes.

### The polkit action (Linux, optional)

Save as `/usr/share/polkit-1/actions/dev.pulsar.confirm.policy` (needs root):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <action id="dev.pulsar.confirm">
    <description>Confirm a Pulsar change</description>
    <message>Pulsar: $(action)</message>
    <defaults>
      <allow_any>no</allow_any>
      <allow_inactive>no</allow_inactive>
      <allow_active>auth_self</allow_active>
    </defaults>
  </action>
</policyconfig>
```

`auth_self` asks for your own password (or fingerprint, with fprintd's PAM module). It does not ask for the administrator's.
