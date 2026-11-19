# Design review

Critique passes for the redesign. Each pass lists what the screenshots
showed and what changed. Screenshots come from
`bunx playwright test -c web/playwright.desktop-shots.config.ts` (Chromium,
1440×900 and 1280×800, light and dark, mock pool of 200 machines and
3,040 agents).

## Desktop

### Pass 0: the shipped desktop (before)

- Everything is 13 px, and ids, names, the session title and the approval
  card use monospace. It reads as a terminal, not a product.
- The sidebar repeats rollup numbers on every machine and project
  ("42 1! 15●"), plus a status dot per group and "+140m" tails. None of
  this is actionable. It is the noise the operator called out.
- "pulsar pool" is lowercase in the title. The top bar repeats
  "2,841 agents · 200 machines" on every screen.
- The home pane is one sentence and a button. There is no overview of
  what needs you or what is running.
- The palette is a plain list with a mono hint line. There are no actions
  and no keyboard hints.
- Broadcast puts six facet rows, a raw selector field and the message in
  one dense modal. Facet names are uppercase labels and the selector is
  always in view.
- Settings is a narrow modal with stacked paragraphs and no structure.
- The approval is an inline card in the transcript. Its buttons look
  disabled even when they are not, and the hierarchy is flat.
- Failure and first-run screens are bare text on the page background.

### Pass 1: new shell, first build

What changed: a type base of 14/20 px in the system sans, with Tailwind
rem at 16 px on desktop. A new sidebar with Home, Search (⌘K) and
Broadcast (⌘⇧B), a filter with a `/` hint, and a tree whose group rows show
only an amber needs-you count or a reachability word ("Asleep",
"Offline", "Update Pulsar"). Agent rows show the harness mark, the name, a
status word and one line of activity. Also new: a Home page (greeting,
needs-you list, recently active, shortcut hints), a Raycast-style palette
with Ask, a settings window with a section list, a session header with
live status and Stop, the approval as a dialog, and the broadcast flow as
"who + message".

Critique of the pass 1 screenshots:

1. **Loading.** The tree skeleton is a single row, so the sidebar jumps
   when the first page lands. It needs a full set of rows with the exact
   boxes of the real ones.
2. **Home and Needs you.** Four or more solid amber "Review" buttons stack
   into a wall of orange. Amber should mark what waits, and the action
   button should stay calm.
3. **Composer.** Autofocus draws a strong 2 px blue ring around the
   composer on every visit. It reads as an error state.
4. **Composer and transcript widths.** The composer card is wider than
   the transcript content column by about 36 px on the right.
5. **Sidebar.** The Machines/Projects switch sits tight under the last
   needs-you row. It needs a little more air and a quiet section label.
6. **Avatars.** At 20 px the single-letter mark is about 9 px and reads
   as lowercase. It needs a larger glyph ratio and a heavier weight.
7. **Transcript (owned by ds).** "PEER from codex@apparish" is uppercase
   monospace, and "you via pulsar (studio)" is lowercase. I sent both to
   ds; they belong to the shared `<Conversation/>`.

### Pass 2: on the design system

What changed since pass 1: the shell now reads the shared tokens
(`--ds-*`) and uses the ds AgentAvatar (real harness marks), StatusBadge,
NeedsBadge, Kbd and Skeleton through one adapter
(`components/desktop/kit.tsx`). The sidebar draws a full set of
placeholder rows. A shell skeleton shows before the pool answers, and a
header skeleton shows while the session chunk loads. Three Playwright
tests (`e2e/desktop-skeleton.e2e.ts`) check that each skeleton box matches
the loaded box within 1 px. Review buttons are neutral, and an amber badge
on the avatar marks what waits. The composer's focus ring is quieter.

Critique of the pass 2 screenshots:

1. **Sidebar names truncate** ("apparish…", "codex@app…") because the
   status word shares line 1. Fixed: line 1 is the name only; activity
   and status share line 2, and the sidebar is 296 px wide.
2. **Band under the transcript.** The main pane was pure white and the
   conversation off-white, so a light band showed above the composer.
   Fixed: the main pane uses `--ds-bg`, and cards and layers use
   `--ds-surface`.
3. **Tree stuck on its loading rows** in about 7 of 10 fresh loads after
   the merge with the phone branch. Cause: the minifier dropped the bare
   `treeVersion.value;` read, so the tree never subscribed to tree
   changes. Fixed in `treeRows.ts` and `ScopeView.tsx`.
4. **Palette:** the highlighted row kept a 2 px blue stripe from the old
   `.row.focused` rule. Removed.
5. **First run:** the logo sat left of the centered text, and the lead
   line wrapped one word. Fixed.
6. **Filter field:** the `/` hint was not centered vertically in the
   field. Fixed.

### Pass 3

Critique of the pass 3 screenshots at 1440×900 and 1280×800, in light
and dark:

1. Every screen keeps the same type ramp: 14/20 body, 13 secondary,
   12 captions, titles 15 (pane headers) and 26 (page titles). Monospace
   appears only in code, commands, paths and the selector.
2. Amber means "waits on you" in every place it appears: the sidebar
   section badge, group counts, the avatar badge, the header pill and the
   transcript notice. Blue appears only as the live "Working" dot and on
   focus.
3. At 1280×800 the broadcast dialog keeps its facets and recipients side
   by side with no clipping. Settings keeps its section list, and the
   session header keeps every meta item.
4. After the ds merge the transcript and the composer share one column;
   the 36 px offset from pass 1 is gone.

### Pass 4: states I had not looked at

New screenshots: Stop confirm, broadcast confirm, type-the-count,
broadcast results, project scope, inline confirm, context menu, selection,
the ids view, palette with no match, and the lower Settings sections.

1. **Escape left the session.** With a dialog open on `#/a/<id>`, Escape
   closed the dialog and the shell's own Escape also went back a page.
   `n`, `?` and `j`/`k` also acted behind dialogs. Fixed: the shortcut
   handler runs in the capture phase and stands down while a layer is
   open. An e2e test covers Settings and Approval.
2. **A spinner flashed at the top** while a layer's chunk loaded (QR,
   palette, settings, help, broadcast). Fixed: those layers draw nothing
   until their chunk is in.
3. **Broadcast results** used the old monospace receipt rows and grey
   buttons. Fixed: names in sans, states as colored words, a bordered
   scrolling list, and standard buttons.
4. **Ids view** had the old header. It now matches the scope header.
   The selection bar wrapped "2 agents selected" onto two lines; it now
   reads "2 selected".
5. **Palette Ask.** Tab was trapped in the input, so the answers could
   not be reached by keyboard, and the footer still said Move and Open.
   Fixed: in Ask mode, Tab moves on to the answers, and the footer
   explains Ask.
6. **Contrast.** `--ds-text-3` on the sunken sidebar was 4.3:1 for 12 px
   text (below AA). Tertiary text in the sidebar now leans toward
   `--ds-text-2`: 5.1:1 on the sidebar and 4.7:1 on a selected row.
7. **Live data.** Settings (sessions, passkeys), the scope preview and
   every relative time now come from the data layer (`useSessions`,
   `usePasskeys`, `useAgents`, and the shared `useNow` clock, which now
   lives in `data/clock.ts` so it adds no TanStack to the initial route).
8. **Home skeleton.** A fourth bounding-box test covers the home page
   head, the section head and the card rows.

## Design system and conversation (ds)

Each pass: screenshots (Playwright: Chromium 1440×900 and 1280×800, WebKit
iPhone 13 mini; light and dark) of the mock's `apparish-auth` session, which
holds every transcript shape (prose, Mermaid, math, table, code, images, every
tool-card kind, reasoning, subagent, peer). Critique against the brief and the
references (Claude/ChatGPT apps, iOS Messages, Linear), then fixes.

### Pass 0: before

Screenshot: `web/screenshots/desktop-session.png` (pre-redesign).

- Everything reads like a terminal: monospace names (`apparish-auth`), a
  monospace tool title `$`, mono `fix-1378 · PR #1402`.
- 13 px root makes the Tailwind `text-sm` prose 11.4 px.
- Tool cards are grey one-liners with the raw tool name ("Read", "Edit", "$")
  and a status icon on every row. Bash isn't highlighted anywhere.
- Diffs are unified only, with no syntax colors and red and green text on
  tinted rows. A "RESULT" heading (shouting caps) repeats "The file has been
  updated." under every edit.
- Authorship is lowercase `assistant`, `you via pulsar (studio)` and `PEER`.
- Code blocks use the GitHub themes, which don't match the warm-grey palette.

### Pass 1

Built tokens (warm greys, Pulsar amber, system blue, status colors, a
CSS-variable Shiki theme) and the new Transcript, ToolCard, CodeBlock, Diff and
ApprovalDetails components.

Problems found in the screenshots:

1. **Layout bug.** The scroller didn't clip, so the whole page scrolled and
   the session header went off screen. Fix: `overflow: hidden` on
   `.ds-scroller`, and the inner scroller fills it.
2. **Phone content under the nav bar.** The old phone CSS padded the
   transcript for the overlay bar; the prune removed it. Fix: shells set
   `--ds-conv-inset-top/bottom`; `scroll-padding-top` keeps
   `scrollIntoView` clear of the bar.
3. **Mermaid has two frames**: Streamdown's card with a mono "mermaid" label
   around a second bordered box. Fix: one frame like a code block, labelled
   "Diagram".
4. **`=>` renders as a ⇒ ligature** in a code font that has ligatures. Fix:
   ligatures off for all code.
5. **Failed Bash shows "Command" and "Error" as two separate boxes** with
   repeated headers, which reads as busy. Fix: one TerminalBlock (`$` prompt,
   highlighted command, dashed rule, output), titled with the agent's own
   description ("Diff stat against main, then the full suite"), with "Exit 1"
   in the header.
6. **A new file showed as a diff**: every line `+` on green, hard to read.
   Fix: new files show as a code block with the file name, line numbers and
   syntax colors.
7. **"0 steps"** on a subagent whose steps are outside the render window.
   Fix: the count is left out at 0, and the spinner shows that it runs.

### Pass 2

- Terminal block: right weight. Dark in both schemes, so commands look like
  commands. The tokens switch to their dark values inside it, so the Bash
  colors stay AA on dark.
- Split diff (desktop): pairs removed and added lines, and a hatched cell
  where one side has nothing. It reads like GitHub's split view.
- **The red ✕ repeated the "1 failed · exit 1" summary.** Fix: the ✕ shows
  only when there is no summary.
- **Diff showed an unchanged last line as removed and added** (a trailing
  newline on one side only). Fix: both sides get the same line ending before
  diffing. A unit test covers it.
- **Desktop session header** was still the old mono stack. Fix: avatar
  (harness mark), name in the display face at 17 px, a status pill (shape +
  word + timer, pulsing only while working), one quiet meta line ("Claude
  Code · fable-5.2 · studio / apparish · fix-1378 · PR #1402 · wt-7").
- Phone: 44 pt tool rows, 17 px prose, and tool rows press-highlight instead
  of hover. The copy action under each reply is quieter (tertiary color).

### Pass 3

- **Status pill read "Waiting for approval04:25"** (no gap before the
  timer). Fix: a 6 px gap and a quieter timer.
- **The diagram label was lowercase**, from Streamdown's `lowercase`
  utility. Fix: "Diagram", matching the code-block header weight.
- **Phone diagrams were tiny.** The pan/zoom stack took a lane and the
  sequence diagram shrank to fit what was left. Fix: no pan/zoom stack on
  phone (fullscreen covers zooming), so the diagram gets the full width.
- **The phone approval sheet had no side margins** (the old `.m-group`
  padding went with the old markup). Fix: 16 pt gutters plus safe areas;
  inset grouped "Where" and "Session rules" lists on the surface color,
  with 44 pt rows.
- **"Also on studio's screen; first answer wins." showed twice** on the
  desktop card (details and footer). Fix: it shows once, in the details.
- **`=>` still showed as a ligature inside diffs**: the rule covered only
  `pre`/`code`, and diff lines are spans. Fix: ligatures off on every code
  surface (`.ds-diff`, `.ds-code`, `.ds-term`).
- Loading: the transcript skeleton uses the real turn markup (author line,
  three prose lines, a tool row, a bubble), so nothing moves when the page
  lands. Each skeleton line is one line box (`1lh`) tall.

Left to the shells: the sidebar tree, the composer, the phone nav bar and
approval banner, and the approval decision buttons (ApprovalCard).

## Pass 4 (audit)

- **Phone tokens stopped at `.ds-conv`.** The scroller column and the approval
  sheet resolved the desktop scale: a 24 px gutter, and 14 px body text on the
  approval sheet. Fix: `.ds-scroller--phone` and `.ds-approval--phone` take
  the phone scale too. The gutter is now 16 pt and the sheet text is 17 pt.
- **Phone targets under 44 pt**: reasoning row, code copy, "Show all",
  "Load earlier", jump pill, diff fold, Streamdown code and diagram actions.
  Fix: all 44 pt.
- **Contrast, now computed in `ds.test.ts`** for 26 text/background pairs in
  both themes. Fixed: `--ds-text-3` on light grey surfaces (4.1 → 4.95), busy
  words on the busy pill (new `--ds-busy-text`), success text, light code
  comments (3.5 → 4.7), the needs badge (white on amber was 3.05; it now uses
  `--ds-needs-badge`/`--ds-on-needs`, 4.8 in light and 8.7 in dark), and
  white on the dark primary (3.3 → 4.8).
- **Ligatures were still on in Markdown code.** The `font` shorthand on
  `pre` reset `font-variant-ligatures`. Fix: `!important` on every code
  surface.
- **The table toolbar** (copy only) added an empty band over each table.
  Fix: no table toolbar; tables are plain bordered grids.
- **The CSS prune went too far** and removed `.session .text-sm/.text-xs`,
  which the composer uses. Fix: restored. The other pruned selectors are only
  used by the old transcript markup (checked with grep).
- Newly screenshotted: Markdown code block, table, math, image bubble.

---

# Design review: phone (Ionic shell)

Device: WebKit "iPhone 13 Mini" (375×812), light and dark, plus Larger Text
(root 23 px). Screenshots: `bunx playwright test -c web/playwright.shots.config.ts`
(`web/e2e/phone.shots.ts`). Review page: `design-review/phone.html`.

## Pass 0: before (custom iOS-styled React shell)

- Looked iOS-like but was hand-built: custom nav stack, custom sheet, custom
  gestures (`MobileLayout`, `Sheet`, `gestures.ts`), so swipe-back, detents
  and swipe actions each behaved slightly unlike iOS.
- Machine and project rows carried rollup counts (amber triangle + number,
  blue dot + number) and a trailing broadcast icon on every row: noise.
- "pulsar" lowercase in titles and copy; a status bar at the bottom repeated
  "2,841 agents · 200 machines".
- Approval sheet actions sat below the fold; Where cells stacked icon over
  text.

## Pass 1: first Ionic build

Rebuilt on Ionic React 9 (iOS mode): IonNav driven by the router's history
stack (swipe-back pops IonNav, history follows), IonHeader with condensing
large titles, IonSearchbar, IonSegment, IonItem rows in inset groups,
IonItemSliding swipe actions, IonRefresher, IonModal card and sheet modals,
IonActionSheet long-press menus, IonToast.

Critique:
- Large title and nav titles had no side padding: Tailwind's preflight
  (`* { padding: 0 }`) beats Ionic's `:host` padding. Fixed by restoring the
  flattened host boxes (found by diffing computed styles with and without
  preflight).
- Search field sat 4 px inside the list's left edge. Aligned to 16 px.
- Needs-you rows truncated "Allow Bash? · opencode…". Now the agent is the
  title and the request (tool in amber, command in mono with invisible
  characters shown as markers) is the second line.
- Expanded machines kept a right-pointing chevron: Ionic moves `aria-*` to
  its inner button, so the CSS keyed on `aria-expanded` never matched. Rows
  carry `data-expanded` now; the chevron turns down.
- Agent page title overlapped the back button (same preflight cause).
- Settings and Needs You headers rendered as big bold text inside the list;
  restyled as iOS footnote-caps group headers outside inset lists, with
  tinted icon squares in Settings.
- Sheets logged "<ion-modal> must be used inside ion-content" and could
  unmount mid-animation; sheet bodies now sit in IonContent and closing
  sheets stay mounted until `ionModalDidDismiss`.

## Pass 2: every screen, both themes, Larger Text

Screens: Home (loaded, scrolled, skeleton, Larger Text), Search, expanded
tree, Needs You (and empty), group sheet, Agent (plus approval banner,
Larger Text, keyboard), Broadcast, Approval (read-only, Face ID, passkey
step), Settings, Ask (empty and answered), Offline, Pulsar not running,
First run, long-press menu.

Critique:
- Skeleton and loaded Home disagreed by 9 px: the Needs You header grew to
  fit "See All"'s 32 px button. "See All" is now a text button on the
  header's line box with an invisible 44 pt hit area, so section headers
  have one height whatever they hold. A WebKit test now checks the skeleton
  boxes against the loaded rows within 1 px.
- Home didn't re-render when its first tree page arrived through the data
  layer (the branch map isn't a signal). It reads the tree version now.
- A build flag that dropped "pure" property reads also dropped
  `treeVersion.value;` dependency reads, so expanding a project spun
  forever. Removed the flag; Ionic React's classes are made tree-shakable
  in the build plugin instead (initial JS 146 KB, budget 150).
- Long-press action sheets were white in dark mode: themed with iOS
  materials (`--background`, pressed states) in both modes.
- Status screens: list headers had no padding (preflight again) and step
  numbers touched their text. Headers are footnote caps outside the inset
  lists; steps keep 14 px from the text. The raw failure code ("offline
  (0)") shows only for unexpected HTTP errors.
- Ask answers were tiny grey lines on grey; now an inset group with
  secondary-label evidence lines and a filled "Ask them directly" button.
- Agent title collided with the back button at Larger Text; title padding
  is in rem now.
- Dark segmented control had no visible selection (indicator matched the
  track): indicator is iOS dark grey `#636366`.

## Pass 3: polish check

- Agent title at Larger Text: the status line was clipped on both sides
  (centered overflow). It ellipsizes inside the title box now.
- Known gaps, not fixed in this pass: the Broadcast sheet's "Advanced"
  selector field still shows on the phone (shared Builder; belongs behind a
  disclosure), and the synthetic-touch tests can't run two swipe gestures
  on one page (Ionic gives an open item's next touch to closing it), so
  leading and trailing swipe actions are separate tests.
- After merging pool: rows use the ds `AgentAvatar` (harness glyphs, 40 pt),
  `AgentStatus` (shape + word: pulsing Working, ring Idle 40m, triangle Needs
  you) and `NeedsBadge`; Ionic reads `styles/ionic-theme.css`. Search and
  segment paint with the first frame (no stand-ins); first route 157 KB of
  170.

## Pass 4: lead review

- Scrolled states showed content through the bars: Ionic's translucent
  toolbar sat at ~64% effective opacity, and headless WebKit renders no
  backdrop blur. Bars are a 97% opaque material now (Ionic's blur still
  sits behind them on devices); the agent page's bar is opaque, since its
  conversation doesn't scroll under it.
- Copy icons under every assistant turn looked unfinished. Long-press a
  message for an action sheet with Copy (exact Markdown for assistant
  turns), as in Messages; the pressed turn highlights.
- Broadcast on the phone keeps to filters and chips: the raw selector field
  is desktop-only.

## Pass 5: lead review, round 2

- 97% bars still ghosted titles and icons under the bar and through the
  status-bar area in shots. Bars are solid now; content scrolls under the
  header and never shows through it or behind its buttons.
- The copy icon came from the shared Transcript. It renders no action row
  by default; `messageActions` lets each platform surface actions (phone:
  long-press action sheet with Copy for every turn; desktop: its own
  hover/focus button). Turns carry `data-msg-id`.
