# Pulsar design system

One system for both apps. The phone (Ionic React, iOS mode) and the desktop
(shadcn/ui + Radix, Tailwind v4) share the tokens, the primitives and the
conversation. Owner: the design-system worktree. Shells consume; they don't
edit `src/styles/tokens.css`, `src/styles/ds.css`, `src/styles/conversation.css`,
`src/components/ui/*`, `src/session/*` or `src/approval/ApprovalDetails.tsx`.
Ask for changes instead.

## Entry points

| Import | What | Weight |
| --- | --- | --- |
| `src/ds/index.ts` | `AgentAvatar`, `HarnessGlyph`, `harnessKey`, `harnessName`, `StatusDot`, `StatusBadge`, `NeedsBadge`, `CountBadge`, `Skeleton`, `SkeletonText`, `SkeletonAvatar`, `SkeletonGroup`, `Kbd`, format helpers (`plural`, `noun`, `needYou`, `num`, `badgeCount`, `ago`, `since`, `duration`, `clock`, `timer`, `shortModel`, `STATUS_LABEL`), wake copy (`WAKE_TAG`, `WAKE_WHY`, `wakeSummary`) | light, OK on the initial route: no Radix, no Streamdown, no tailwind-merge (classes join with `lib/cx.ts`) |
| `src/ds/conversation.ts` | `Transcript`, `ConversationView`, `JumpToLatest`, `TranscriptSkeleton`, `ToolCard`, `SubagentCard`, `ReasoningRow`, `WorkingRow`, `CodeBlock`, `TerminalBlock`, `CopyButton`, `Diff`, `InlineCode`, `useTokens`, `langForPath`, `ApprovalDetails`, `Exact`, `Marked`, `visible`, `buildItems`, `mergeHistory`, `mergeLive` | heavy (Streamdown, Radix Collapsible, lazy Shiki): import from a lazy route chunk |
| `src/components/ui/*` | shadcn/Radix primitives (button, badge, dialog, dropdown-menu, select, tooltip, command, hover-card, collapsible, input, textarea, separator, spinner) | desktop; import each file directly |
| `src/styles/tokens.css` | every `--ds-*` token, light + dark + forced, phone type scale | loaded by `globals.css` |
| `src/styles/ionic-theme.css` | `--ion-*` variables from the tokens | the phone imports it after Ionic core CSS |

## Theme and platform switches

- Theme follows the system. `<html data-theme="light|dark">` forces one.
  Tailwind's `dark:` variant follows the same rule.
- Platform: tokens default to the desktop scale (px). Set
  `<html data-platform="phone">` (or put `.ds-phone` on a subtree) for the iOS
  scale in rem (17 px body, follows Dynamic Type through the root font).
  `<Transcript variant="phone">` adds `.ds-phone` itself.
- Desktop root font size: the desktop shell should set `html { font-size: 16px }`
  so Tailwind's rem sizes are true (13 px roots made everything tiny). DS
  components size from tokens in px and don't depend on it.

## Tokens (names to use)

- Text: `--ds-text`, `--ds-text-2` (secondary), `--ds-text-3` (tertiary, AA),
  `--ds-text-4` (decorative only).
- Surfaces: `--ds-bg`, `--ds-bg-sunken` (grouped list background),
  `--ds-surface`, `--ds-surface-2`, `--ds-surface-3`, `--ds-surface-hover`,
  `--ds-surface-active`, `--ds-surface-selected`, `--ds-material` +
  `--ds-material-filter` (blurred bars), `--ds-overlay`.
- Lines: `--ds-border`, `--ds-border-strong`, `--ds-hairline`.
- Brand / needs you: `--ds-accent`, `--ds-accent-text`, `--ds-accent-soft`.
  Actions and links: `--ds-primary`, `--ds-primary-soft`, `--ds-link`,
  `--ds-focus`, `--ds-focus-ring` (a box-shadow).
- Status: `--ds-busy`, `--ds-busy-text` (busy words on `--ds-busy-soft`),
  `--ds-idle`, `--ds-needs`, `--ds-needs-text`, `--ds-needs-badge` +
  `--ds-on-needs` (the amber count badge, AA),
  `--ds-offline`, `--ds-danger(-text|-soft)`, `--ds-success(-text|-soft)`,
  `--ds-peer(-text|-soft)`. Always with a shape (`StatusDot`) and a word.
- Type: `--ds-font-sans`, `--ds-font-display`, `--ds-font-mono`;
  `--ds-text-{caption,footnote,secondary,body,prose,code,headline,title3,title2,title1,large}`
  (+ `-lh` for caption…code). Monospace only for code, paths and commands.
- Space: `--ds-space-{1,2,3,4,5,6,8,10,12}` (4 pt grid), `--ds-gutter`,
  `--ds-measure` (conversation column), `--ds-hit` (min control size: 28 px
  desktop, 44 px phone).
- Radius: `--ds-radius-{xs,sm,md,lg,xl,bubble,full}`. Depth:
  `--ds-shadow-{xs,sm,md,lg}`. Motion: `--ds-ease-out`, `--ds-ease-ios`,
  `--ds-dur-fast`, `--ds-dur`, `--ds-dur-slow` (0 with reduced motion).
- shadcn variables (`--background`, `--primary`, …) and the legacy
  `--bg`/`--fg`/… names are aliases of these.

## Primitives

- `<AgentAvatar harness="claude-code" size="xs|sm|md|lg" status? label? />`:
  harness mark in a tinted rounded square (Claude, Codex, OpenCode, pi, omp,
  Cursor, Gemini; others get their initial). xs/sm/md/list/lg = 18/24/32/40/44 px.
- `<AgentStatus state since? needsReason? now? variant="plain|soft" />`: the
  ready-made row/header status: "Working" (pulses), "Idle 40m", "Needs you" /
  "Waiting for approval", "Offline". Pass `now` from the shared clock.
- `<StatusDot state="busy|idle|needs-you|offline|failed|done" live? label? />`:
  shape + color. `<StatusBadge state live variant="soft|plain">Working</StatusBadge>`.
  Use `STATUS_LABEL[state]` for words ("Working", "Idle", "Needs you",
  "Offline") and `since(ts)` for "40m".
- `<NeedsBadge count label="2 need you" />`: the amber count; nothing at 0.
  `<CountBadge count />`: neutral.
- Skeletons: build from the real row's markup and swap text for
  `<SkeletonText w={1..10} />` (one line box tall, so heights match exactly)
  and avatars for `<SkeletonAvatar size />`. Wrap in `<SkeletonGroup label>`.
- `<Kbd keys={["mod","K"]} />`: ⌘K on Apple, Ctrl K elsewhere.
- Copy: always `plural(n, "machine")` → "1 machine", "2 machines";
  `needYou(n)` → "1 needs you", "3 need you".

## Conversation

```tsx
<ConversationView variant="desktop|phone" pill={<JumpToLatest … />}>
  {loading && !events.length && <TranscriptSkeleton variant=… />}
  <Transcript
    events={events}            // TranscriptEvent[], oldest first
    variant="desktop|phone"    // split diffs + 760 px column | unified diffs + 17 px type
    agent={{ name, harness }}  // names and marks the agent's turns
    streamingIds={set}         // ids whose text is still growing
    working={bool}             // "Working…" row under the last turn
  />
</ConversationView>
```

Shell insets: a shell whose bars overlay the conversation sets
`--ds-conv-inset-top` and `--ds-conv-inset-bottom` (lengths) on an ancestor of
`ConversationView`. The column pads by them, `scrollIntoView` clears them
(`scroll-padding-top`), and the jump pill sits above the bottom inset. The
legacy phone shell sets `--ds-conv-inset-top: var(--m-nav)` on `.session.mobile`.

Contrast: `web/test/ds.test.ts` checks every text/background token pair at
4.5:1 in light and dark. Add a pair there when you put a new combination on screen.

`Transcript` is pure: no store, no API (images fetch through the hardened
`useApiImage`). `src/session/SessionView.tsx` is the reference container
(loading, paging, live merge, header, composer). Stable test hooks:
`.transcript .ev`, `.ev.msg`, `.r-user`, `.ev.peer`, `.ev.thinking[data-state]`,
`.ev.tool[data-tool]`, `.tool-summary`, `.diff .add/.del`, `.new-pill`,
`.transcript-image`, `.tool-images`.

Markdown goes through Streamdown with the hardened config in
`src/session/streamdown.tsx` (sanitize, harden, link and image policy). Don't
render agent text any other way.

## Shared test helpers

- `web/e2e/copy.ts`: `expectCleanCopy(page, where, root?)` fails on rookie copy
  ("1 machines", "...", raw enums, raw ids, leaked `undefined`). Salvaged from
  pool-ui-polish; use it on every screen you own.
- `web/e2e/conversation.shared.ts`: the conversation suite, run on desktop and
  iPhone (`ds-conversation.*.e2e.ts`): authorship, sans verbs with mono
  targets, highlighted Bash, clean copy, and a skeleton that keeps the column
  in place.

## Approval details

`<ApprovalDetails approval agent variant showRules />` renders who asks, the
tool, every argument exactly (`visible()` markers), where (cwd, branch, input
hash) and the session rules. The decision flow stays in `ApprovalCard`. Never
syntax-highlight approval arguments.

---

# Phone design notes (pre-redesign)

The phone layout (below 1024 px) follows Apple's Human Interface Guidelines so
the installed app feels like an iOS app. The desktop layout keeps its own dense
style. Phone tokens and components live in `src/styles/ios.css`. Every phone
rule is either inside `@media (max-width: 1023px)` or uses an `m-` class that
only the phone layout renders.

## Principles

- **Native first.** Use the iOS pattern when one exists: large titles, inset
  grouped lists, sheets, swipe actions, context menus, segmented controls,
  switches, action sheets.
- **Content over chrome.** Bars are translucent and blurred. Screens scroll
  under them, and a hairline shows only once content passes beneath.
- **Shape and color together.** A status glyph always has its own shape, and a
  word appears next to it where space allows.
- **Quiet by default.** Only needs-you is amber, and only the live status dot
  pulses. Red means Stop, Deny, or failure.

## Color

These are iOS system colors. A few text colors are darkened in light mode to
reach WCAG AA (4.5:1). Those are marked AA.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--m-bg` | `#F2F2F7` | `#000000` | systemGroupedBackground |
| `--m-cell` | `#FFFFFF` | `#1C1C1E` | secondarySystemGroupedBackground |
| `--m-cell-2` | `#F2F2F7` | `#2C2C2E` | tertiary (insets, code) |
| `--m-plain` | `#FFFFFF` | `#000000` | systemBackground (session) |
| `--m-label` | `#000000` | `#FFFFFF` | label |
| `--m-label-2` | `#6C6C70` (AA) | `rgba(235,235,245,.6)` | secondaryLabel |
| `--m-label-3` | `rgba(60,60,67,.3)` | `rgba(235,235,245,.3)` | tertiaryLabel |
| `--m-sep` | `rgba(60,60,67,.29)` | `rgba(84,84,88,.65)` | separator |
| `--m-fill` | `rgba(120,120,128,.2)` | `rgba(120,120,128,.36)` | systemFill |
| `--m-fill-3` | `rgba(118,118,128,.12)` | `rgba(118,118,128,.24)` | tertiarySystemFill (search, segmented) |
| `--m-tint` | `#0068DA` (AA) | `#0A84FF` | tint, links, plain buttons |
| `--m-tint-fill` | `#0068DA` | `#0A72E8` | filled buttons, outgoing bubbles (white text AA) |
| `--m-orange` | `#FF9500` | `#FF9F0A` | needs-you glyphs and tiles |
| `--m-orange-text` | `#B25000` (AA) | `#FF9F0A` | needs-you text |
| `--m-red` | `#D70015` (AA) | `#FF453A` | destructive, failed |
| `--m-green` | `#248A3D` (AA text) / `#34C759` (switch) | `#30D158` | allowed, success |
| `--m-purple` | `#8944AB` (AA) | `#BF5AF2` | peer messages |
| `--m-gray` | `#8E8E93` | `#8E8E93` | idle, offline |

Bar material: `rgba(249,249,249,.78)` light and `rgba(29,29,31,.72)` dark, with
`backdrop-filter: saturate(180%) blur(20px)`.

## Type

The root follows Dynamic Type through `font: -apple-system-body`, which is
17 px at the default size. Every size below is in `rem`, so the whole scale
follows the user's text-size setting. Numbers that count or tick use
`font-variant-numeric: tabular-nums`.

| Style | Size / line | Weight | rem |
| --- | --- | --- | --- |
| Large Title | 34 / 41 | 700 | 2 |
| Title 2 | 22 / 28 | 700 | 1.294 |
| Title 3 | 20 / 25 | 600 | 1.176 |
| Headline | 17 / 22 | 600 | 1 |
| Body | 17 / 22 | 400 | 1 |
| Callout | 16 / 21 | 400 | 0.941 |
| Subheadline | 15 / 20 | 400 | 0.882 |
| Footnote | 13 / 18 | 400 | 0.765 |
| Caption 1 | 12 / 16 | 400 | 0.706 |
| Caption 2 | 11 / 13 | 400 | 0.647 |

Code uses `ui-monospace` (SF Mono) at Footnote size. Code scrolls sideways and
never wraps, so the columns stay intact on a 375 px screen.

## Layout

- **Margins:** 16 px from the screen edge, plus the safe-area inset. All
  insets go through `--sat`, `--sab`, `--sal` and `--sar`, which wrap
  `env(safe-area-inset-*)`.
- **Grid:** spacing comes in 4 px steps: 4, 8, 12, 16, 20, 24 and 32.
- **Rows:** at least 44 px tall. Two-line rows are 60 px, scaled with the
  text size. A separator starts where the row's text starts.
- **Inset grouped sections:** 16 px side margin and a 12 px corner radius. A
  prominent header is Title 3, and a footer is Footnote in secondary color.
- **Bars:** a nav bar is 44 px tall, plus the top inset. A large title adds
  52 px. The toolbar is 49 px tall, plus the bottom inset.
- **Hairlines:** 1 device pixel (`--hair`: 0.333 px at 3x, 0.5 px at 2x).

## Radii

| Element | Radius |
| --- | --- |
| Grouped section, card | 12 |
| Sheet top corners | 12 at the large detent, 16 elsewhere |
| Search field | 10 |
| Segmented control | 9 (thumb 7) |
| Bubble | 18 |
| Icon tile | 7 |
| Buttons | 12 (large); capsule (small) |

## Motion

| What | Duration | Curve |
| --- | --- | --- |
| Push / pop | 0.5 s | `cubic-bezier(0.32, 0.72, 0, 1)`. The screen below moves 30 % left and dims |
| Sheet present / dismiss | 0.5 s / 0.35 s | same curve |
| Interactive release (swipe-back, sheet drag) | 0.35 s | same curve, starting from the finger's velocity |
| Pressed state | 0 s in, 0.2 s out | ease |
| Large title to inline title | 0.2 s | ease |

Animations change only `transform` and `opacity`. With
`prefers-reduced-motion`, pushes and sheets cross-fade for 0.2 s, and nothing
slides or pulses.

## Components

- **Nav bar:** back chevron with the previous screen's title, an inline title,
  and trailing buttons. The large title collapses into the bar as you scroll,
  driven by an IntersectionObserver, not a scroll handler.
- **Toolbar** (home): Needs you with a badge, the pool status in the middle,
  and compose (broadcast) on the right.
- **Search field:** tertiary fill and a magnifier icon. While it has focus, a
  Cancel button slides in.
- **Segmented control:** a sliding thumb with a shadow. Each segment is a
  `role="radio"`.
- **Switch:** 51 × 31, green when on, built on `<input type="checkbox">`.
- **Buttons:** filled, tinted, plain and destructive.
- **Sheet:** grabber, medium and large detents, and a dimmed backdrop. Drag the
  grabber or header to move it, and fling down to dismiss. Closing the sheet
  goes back in history.
- **Action sheet:** confirms destructive actions, such as Stop.
- **Swipe actions:** swipe a tree row left. Agent rows show Stop (only
  when the agent can stop), Pin and Message. Machine and project rows show
  Pin and Message. A full swipe runs Message. Stop always asks first in an
  action sheet. A touch anywhere else closes the open row.
- **Context menu:** press and hold a tree row for about half a second. The
  row lifts over a blurred backdrop with a menu under it: Open Session, Pin
  and Stop Turn for agents; Message Everyone, Expand or Collapse and Pin for
  groups. Escape or a tap outside closes it.
- **Pull to refresh:** pull the home list down from the top. An iOS-style
  8-spoke spinner fills in as you pull and spins while the pool reloads.
- **Edge swipe-back:** drag from the left edge of a pushed screen. The screen
  follows the finger and the one below slides in. Past half the width, or on
  a fling, it goes back.
- **Status glyphs:** needs you is an amber triangle, busy is a blue dot (it
  pulses in the session header), idle is a grey ring, offline is a grey cross,
  and failed is a red mark.
- **Skeletons:** loading rows use shimmering placeholders shaped like the real
  row, not a spinner.

## Feel

- `-webkit-tap-highlight-color: transparent`. Every control has its own
  pressed state.
- `touch-action: manipulation` on controls, so taps have no delay.
- `overscroll-behavior: contain` on scrollers.
- `user-select: none` on chrome.
- Focus rings show only for `:focus-visible`.
- VoiceOver labels say what a row holds ("studio, machine, 42 agents, 3 need
  you, collapsed").

## Gestures in code

All gestures live in `src/components/gestures.ts`, which loads after first
paint, so it adds nothing to the first route. They use touch events, so a
vertical scroll stays native until a gesture claims the touch. Sheets use
pointer events on the grabber and header. `e2e/ios.e2e.ts` tests every
gesture in WebKit with the iPhone 13 mini profile.

## Home Screen app

- **Icon:** `public/icon.svg` is the master. `bun web/scripts/icons.ts`
  renders `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` and a
  maskable 512. The PNGs are committed.
- **Status bar:** `apple-mobile-web-app-status-bar-style` is `default`.
  `black-translucent` forces white text, which you cannot read on the light
  background, and WebKit marks it deprecated. We expect iOS to tint the
  `default` bar from `theme-color`, but this is not yet checked on a device.
- **theme-color:** `#F2F2F7` light and `#000000` dark on the phone, the same
  as `--m-bg`. The desktop keeps its own colors.

