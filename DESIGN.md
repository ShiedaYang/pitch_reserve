---
name: Pitch Reserve
description: A familiar Chinese workbench for local pitch monitoring.
colors:
  ground: "#f3f5f7"
  surface: "#fff"
  ink: "#253344"
  muted: "#536478"
  line: "#d7dfe8"
  blue: "#365e86"
  blue-hover: "#284a6b"
  blue-soft: "#eaf0f6"
  green: "#1b654e"
  green-soft: "#edf6f1"
  amber: "#855a19"
  amber-soft: "#fbf4e6"
  red: "#a13434"
typography:
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    fontSize: "19px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  button:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.6
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  tag: "4px"
  control: "6px"
  notice: "7px"
  mobile-table: "8px"
  surface: "12px"
spacing:
  compact: "8px"
  small: "12px"
  medium: "16px"
  row: "20px"
  section: "24px"
  panel: "28px"
  desktop-gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-secondary-hover:
    backgroundColor: "{colors.blue-soft}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    typography: "{typography.button}"
    padding: "5px 0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
    width: "100%"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    padding: "12px 1px 14px"
  tab-selected:
    textColor: "{colors.blue}"
  tag:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    rounded: "{rounded.tag}"
    padding: "2px 8px"
  tag-warning:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  available-cell:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
---

# Design System: Pitch Reserve

## Overview

**Creative North Star: "标准工作台"**

Pitch Reserve uses the familiar language of a working console: cool neutral ground, white working surfaces, slate text and muted blue actions. Aligned information, compact controls and clear state labels support repeated comparison. The product name and Chinese interface remain the visual and verbal anchors.

Flat surfaces, fine rules and tabular numerals make dates, observations and prices easy to scan. Color identifies action and operational state; it does not replace the text that explains uncertainty, freshness or user takeover. Native system fonts and inline line icons keep this local tool lightweight.

**Key Characteristics:**

- Familiar top tabs and compact forms.
- Cool neutral surfaces with muted blue actions.
- Flat containers, fine dividers and aligned tabular data.
- Explicit observation, uncertainty and takeover labels.
- Chinese interface copy and system typography.

## Colors

The palette is restrained and cool, with semantic green and amber reserved for monitoring states. Frontmatter values are normative and use the names from the implemented CSS.

### Primary

- **Muted workbench blue** (`blue`): primary actions, selected tabs, links and checkbox accent. `blue-hover` deepens primary buttons on hover; `blue-soft` supports notices, readonly status and secondary hover.

### Neutral

- **Cool gray ground** (`ground`): the application background.
- **White working surface** (`surface`): header, inputs, data table and administrative panels.
- **Slate ink** (`ink`): primary text and neutral controls.
- **Muted slate** (`muted`): supporting labels, timestamps and instructions.
- **Fine cool rule** (`line`): control outlines, panel boundaries and section dividers.

### Operational states

- **Observed green** (`green`, `green-soft`): available observations and normal monitoring tags.
- **Caution amber** (`amber`, `amber-soft`): unknown observations, stale notes and manual/warning tags.
- **Error red** (`red`): connection and operation errors.

**The Explicit State Rule.** Pair every operational color with its visible state text. Unknown, unread and unreleased observations must stay distinguishable from unavailable inventory.

## Typography

Use the system stack recorded in frontmatter throughout. No external fonts or display face ship. Numerals are tabular across the interface so dates, prices and timestamps align.

The headline role is the page heading; the title role serves section headings and the prominent observed price. Body text carries instructions and forms, with smaller muted metadata. Venue headings use a compact intermediate size (16px). The brand uses a modest stronger size (21px), rather than an oversized display treatment.

At the mobile breakpoint, the page heading reduces to (25px), brand to (18px), observed price to (18px), and header status to (11px). Some metadata and table legends also use (11px). Preserve readable Chinese line-height and natural wrapping; do not introduce uppercase labels or decorative tracking.

## Layout

The shared header, tabs and main container align within a centered maximum width (1440px). Horizontal gutters step from desktop (40px), to (24px) at a maximum viewport width of (1000px), to (16px) at (640px). Spacing is compact around controls and more generous around section boundaries.

The implemented calendar is a date-by-venue matrix: dates down the rows and GGCB, Stepney Green, Westferry and Poplar across four columns. Keep the date column and table header sticky within the local scrolling region. The table's minimum width is (860px), reducing to (790px) on mobile; the date column changes from (174px) to (130px). The scrolling surface has a minimum height (260px) and maximum height (65vh), changing to (64vh) on mobile. Preserve horizontal scrolling instead of compressing the four venue columns into unreadable cells.

At (1000px), resource rows reduce from three columns to two and show the horizontal-scroll hint. At (640px), resource rows, credentials, date fields and activity entries stack; the toolbar becomes vertical, shortcut links take a full row, and account actions wrap. The five top tabs remain in a single distributed row. The local-operation header text hides while the readonly status stays visible.

## Elevation & Depth

The interface uses no shadows. White surfaces, cool ground, thin borders and occasional tinted state areas establish grouping. Table headers and the date column use stacking only to preserve orientation during scrolling; they do not acquire decorative depth. Focus is an explicit outline (3px solid `#517cab`, offset 3px), not a shadow.

**The Flat Surface Rule.** Use boundaries, alignment and tonal surfaces to express hierarchy; retain the implemented shadow-free treatment.

## Shapes

Controls and observation cells have modest rounded corners using `control`; grouped panels use `surface`. Compact tags use `tag`, notices use `notice`, and the table becomes slightly tighter with `mobile-table` on narrow screens. Controls and panels carry thin borders; table cells use fine internal dividers, with a stronger horizontal rule at week boundaries. Inline icons are simple strokes. No raster assets ship.

## Components

PlayFootball's existing account action row includes Ordinary browser verification. While the human-owned window is open, the button reads “普通浏览器验证中”, conflicting browser actions and login submission are disabled, and the attention message asks the user to verify then close that dedicated window. Pause remains available; other provider controls stay usable. Reuse the same wrapping button row and amber operational notice, with no new tokens.

### Buttons

Primary buttons carry muted blue with white text and a deeper blue hover. Secondary buttons are white with slate text and a cool outline, gaining a pale blue hover. Both have a minimum height (40px). Disabled buttons use a muted gray fill, slate text and a default cursor; preserve the disabled state during pending work. Text actions use blue text, no border and an underline on hover, with minimum height (36px). Keep visible keyboard focus for every variant.

### Inputs / Fields

Fields are white, full-width, cool outlined controls with a minimum height (42px). Labels sit above fields with a compact gap (7px). Checkbox controls are native, blue accented and sized (17px). The account username remains plain visible text; saved passwords use the fixed saved mask rather than exposing credentials. Credential actions wrap and the two-column form becomes one column on mobile.

### Navigation

Top tabs use muted labels, with blue selected text and a bottom indicator (3px). Hover changes text color; focus retains the shared outline. Preserve the tab roles, selected states and arrow/Home/End navigation. The selected indicator animates only when reduced motion is not requested, using the short (160ms) clipped reveal in the sidecar. Other controls have no added motion.

### Tags and notices

Compact green tags identify normal monitoring status; amber tags identify warnings or manual takeover. The readonly header label uses pale blue. Notices use pale blue with dark blue text; errors use a pale red surface with error-red text. Tags and notices always include actual text, with no color-only status.

### Panels and rows

Resources, account groups, settings and activity use white bordered containers. Grouped rows have internal rules rather than separate elevated cards. Keep the three independent account groups visible in the account view, including the shared PlayFootball group, and preserve explicit manual takeover, session checking and monitoring controls. State copy explains automatic recovery after one idle minute; explicit pause retains its meaning. Disclosure sections hold credentials, coverage detail and council defaults without competing with the page heading.

### Observation cells

Available cells are pale green links. The price is the strongest line, followed by actual duration, checked time, stale warning where applicable, and the underlined official-site action with a small inline external-link icon. Unknown cells use amber text; unreleased cells use a pale neutral fill. Both use the leading label “暂无信息”; release dates and reasons remain alongside it or in the tooltip. Nearby alternatives count as unavailable at the requested venue. All cells retain minimum height (62px), including nonavailable and mobile cells, while available cells grow with their evidence.

Keep observed prices and durations exact. Missing values read “价格待核实” or “结束时间待核实”; stale observations carry “历史观察 · 需重新查验”. Links open the official site in the visiting user's browser, so their presentation must not imply a reservation or guaranteed inventory.

### Notification list

Notification history inherits the flat bordered list treatment, wrapping content on mobile. Each row displays the date, venue, observed quote, discovery times, a text status and a native official-site link. Each pending or failed row has a manual-send action; it targets saved enabled recipients without enabling automatic delivery. Already confirmed targets are skipped. Per-recipient delivery receipts and manual reconciliation actions appear where relevant. Pending, retry, review-required, cancelled and expired records remain visible. Pagination exposes older records rather than silently dropping history.

Feishu settings live in a collapsed disclosure at the top of the notification list, using the established bordered settings panel, labeled fields, native recipient-type selects, explicit enabled checkboxes and shared action buttons. The secret field stays empty with a saved-state placeholder. Recipient rows use four columns on desktop, two below 1000px, and one below 640px. A text preview is a disclosure; it does not send a message. Keep the automatic-send consent and non-sending credential-validation copy visible beside their controls.

## Do's and Don'ts

### Do:

- **Do** keep Chinese copy, system typography and tabular numerals.
- **Do** align operational information in flat surfaces with fine borders and compact controls.
- **Do** keep prices, duration, freshness and uncertainty beside the observation they describe.
- **Do** retain visible focus, keyboard navigation and the local table scroll region on narrow screens.
- **Do** keep saved usernames visible, passwords masked and account takeover explicit.

### Don't:

- **Don't** replace the chosen workbench with promotional decoration, external fonts or raster imagery.
- **Don't** add shadows or use color alone to distinguish operational states.
- **Don't** present unread, unknown, stale or unreleased data as confirmed unavailability.
- **Don't** invent prices, durations, current availability or a successful booking state.
- **Don't** hide the readonly monitoring boundary or imply that opening an observation holds inventory.

Operational recovery: an amber global notice names the affected provider, explains manual verification and links to the Accounts tab. Administrator targets remain in the existing Feishu disclosure; resend actions and their history remain aligned with each notification. No new palette or layout system.

Accounts keep Restart browser beside the existing provider actions, with an immediate disabled “正在重启…” state. The operation affects only that provider browser; account preservation and previous pause/manual mode are explained in the recovery path. No new visual tokens.

Monitoring preferences use the existing native select for lookahead (1 week, 2 weeks, 1 month, default 2 months, 3 months). Readonly date inputs show tomorrow in London and the calculated end date, updated by polling as the London date changes. Saving applies the lookahead and interval; polling preserves unfinished edits. The helper explains daily rolling and unsaved changes. Existing spacing, colors, type and mobile date-field stacking remain unchanged; no new design tokens.
Runtime history uses the existing flat event list with level and provider filters, 50-record cursor pages, and preserved technical-detail disclosures. Rows show level in words as well as color, provider/stage, reason, remedy and compact numeric counts. The Accounts tab adds one compact server-browser section with configuration status, a connection check and a native new-tab viewer link. Existing palette, native selects, visible focus and mobile stacking remain the visual authority.
