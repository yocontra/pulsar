# Presence checks

Some commands change who can reach your agents or how you prove you are you:

- `pulsar mesh allow|deny|forget <node>`
- `pulsar mesh owner <login>`
- `pulsar passkeys remove <id>`

Anyone on the machine can run them, agents included. A terminal is not needed. Before the change, the daemon asks the person to confirm it. It asks in two ways at the same time, and the first answer counts:

1. **The operating system's prompt**, shown by the daemon itself:
   - macOS: Touch ID, Apple Watch, or the login password (LocalAuthentication, `LAPolicyDeviceOwnerAuthentication`).
   - Windows: Windows Hello (`UserConsentVerifier`).
   - Linux desktop: polkit, only with Pulsar's polkit action installed (below).
2. **A confirm card in the Pulsar app**: in Needs You, on the agent that asked (a request from a terminal shows on "operator"), with a push to subscribed phones. You answer it in one of two ways:
   - with your passkey (Face ID, Touch ID, Windows Hello or the device PIN), signed for that one card;
   - in this machine's app, with the browser's passkey session, like any other prompt on this machine (one Face ID per session).

   The daemon checks the answer either way. A session answer must carry the card's hash, which covers the action and the card text, so it applies only to the card you saw. It is recorded as "passkey session".

Both name the exact change and who asked. The macOS prompt text is the reason Pulsar passes; macOS adds the asking app's name (expected to be "osascript"; not yet confirmed live):

> "osascript" is trying to confirm a Pulsar change: forget pulsar-meshnode and its machine id (pulsar mesh) (asked by agent claude@pulsar (claude) on studio).

If you say no in either place, the change is refused. If nobody answers in 3 minutes, it times out. If the command stops (Ctrl-C), the prompt and the card go away. When there is no system prompt and the app can't answer (it is off, or this machine has no passkey), there is one last resort, for a person at a real terminal only: the daemon writes a word to that terminal and you type it back. This is for a headless tagged server reached over SSH, before it has an owner (`pulsar mesh owner`). The daemon refuses a process with no terminal, or with a terminal that has an agent harness anywhere in its process tree. An agent's request never falls back to the word: it is refused with a pointer to `pulsar mesh on --prove`.

## Why the daemon can't be fooled by a client

- The command is one call: `pool.change` or `passkeys.remove`. The daemon works out the change, asks the person, and applies the change only when its own check passed. The request has no field that says "confirmed". The old `pool.confirm` call and its typed word are gone.
- The daemon starts the OS prompt itself, as its own child process (`/usr/bin/osascript` on macOS). The action text goes in as an argument, never as code. An agent can run osascript too, but the daemon never reads anything from it.
- The app card is opened by the daemon only. An agent can open its own `confirm` dialog with `interaction.ask`, but the daemon acts only on the card it opened for this check. Agents can't answer cards: only the human, with a passkey assertion whose challenge covers the card's id, the hash of the action and card text, the answer and the expiry.
- Inside the daemon, the code that applies a change needs a one-time proof object from the check, made for that op. A plain object never passes.
- Only one check runs at a time. After two denials in an hour, the next check waits 15 s, then 30 s, 60 s and so on (up to 30 minutes). An agent can't keep showing prompts until you say yes without looking.
- Every request and outcome goes in the `audit` table. Pool changes and passkey removals are also announced in open app tabs and pushed as security notices.

## Why a passkey session counts as a human check

A session token is issued only after a WebAuthn ceremony with user verification (Prove Human: Face ID, Touch ID, Windows Hello or the device PIN). Only the token's hash is stored. The token stays in the browser's memory (on a desktop) and works only from the Tailscale node that started it.

An agent can't get one:
- The socket has no op that issues a session.
- The HTTP API issues one only for a verified assertion.
- A token copied to another node is refused.

So a session answer still means a person proved themselves with their device's biometrics or PIN. It means that within the session's lifetime: 12 hours in a desktop browser, 7 days in the installed app on a phone. It does not mean a new Face ID for this card.

The cost: anyone who can use your unlocked, proven browser or phone can confirm without a new biometric check. That is the trade the operator chose (one Face ID per session). A process that drives your browser is the same-user limit below.

A prompt on another machine still needs that machine's passkey signature: a session never crosses machines.

## What it doesn't stop

- **Same-user processes.** A program running as you can edit the daemon's database, replace the installed Pulsar, or drive your GUI. That is the same-user limit in [SECURITY.md](../SECURITY.md). The check stops agents' tool calls from making these changes without you. It does not stop malware.
- **A reflexive yes.** The prompt names the change and the agent. Read it. If you didn't start the change, say no.
- **Who asked.** The name comes from the daemon's registry for that connection. A client that skips `hello` shows as "a terminal".
- **Other machines.** A card for a request from a terminal is shown on "operator", which only this machine's app lists. A request from an agent shows wherever that agent shows.

## Per platform

| Platform | System prompt | Shown when | Notes |
| --- | --- | --- | --- |
| macOS | Touch ID / Apple Watch / password, through `osascript -l JavaScript` (LocalAuthentication) | The daemon runs in your login session (the launchd agent, or a daemon started from a shell in it) | No compiled helper, no npm dependency. The dialog should name "osascript" as the asking app (to confirm live). Over SSH there is no GUI session, so the app path is used. |
| Windows | Windows Hello, through Windows PowerShell 5 (WinRT `UserConsentVerifier`) | Windows Hello is set up | Not verified live yet. |
| Linux | polkit `dev.pulsar.confirm`, `pkcheck --allow-user-interaction` | A graphical session (`DISPLAY` or `WAYLAND_DISPLAY`), not over SSH, and the action is installed | Without the action, polkit can only show a stock "run as the super user" message that doesn't name the change, so Pulsar uses the app. Not verified live yet. |
| Other, headless, SSH, containers | none | | The app card; with no passkey either, the word on your terminal (a person at a terminal only). |

`PULSAR_NATIVE_PRESENCE=off` turns the system prompt off (tests set it). The variable can only take a way to ask away. It can never say yes.

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

## Live check

`scripts/presence-live.ts` (after `bun run build`) never touches the real daemon or HOME. These modes show a real prompt, so run them only when the person at the machine expects one:

- `direct`: the provider, from the calling process.
- `kill`: the dialog must close when its child is killed.
- `daemon`: a throwaway daemon in-process.
- `launchd`: a throwaway daemon run by launchd as a LaunchAgent job in the GUI session, the real design.

`launchd-dry` and `launchd-probe` check the launchd plumbing without a prompt.
