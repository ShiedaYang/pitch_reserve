---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/style.css","public/app.js"]
---

# Local monitoring console

Mode: Operate. Target: public/index.html, public/style.css, public/app.js.

The user chose 标准工作台 after comparing the decision sketches. This is a code-led redesign of the existing local console. Existing login and saved-account behavior, council defaults, readonly monitoring and official-site handoff remain functional.

## Direction contract

THESIS: The familiar workbench puts available dates, venue names and observed prices in one aligned table before administration. No promotional hero or stack of account cards precedes the results.

OWN-WORLD: White working surface, cool gray ground, slate text and one muted blue action color. Native top tabs, modest rounded controls, fine table rules and tabular numerals. This is the user-selected category standard, without ticket decoration.

STORY: The user compares Monday–Thursday 18:00 observations, sees price and freshness together, then opens the official venue in their own browser for confirmation. Separate tabs contain accounts, preferences, the persistent notification history and recent activity. The notification list contains a collapsed Feishu configuration disclosure and individual manual-send actions. Automatic delivery requires explicit enabling; manual delivery uses saved recipients and preserves dedupe and freshness checks. Unavailable inventory includes nearby-only alternatives. Missing/unreleased inventory leads with “暂无信息”, while reasons remain available. Council uses saved defaults automatically; idle manual control returns to monitoring after a minute, with human-verification guards.

FIRST VIEWPORT: At 1440×900 a compact brand header and five top tabs precede a 28px page heading, date-range summary and right-aligned scan action. All target dates are rows and the four venues are columns, as explicitly confirmed by the user. A compact shortcut row surfaces actual upcoming availability and price, followed by the date table. Each available cell includes price, duration and freshness. Mobile keeps the heading, filter and first date visible, with a locally scrolling table and a sticky date column.

FORM: User-selected canon, 标准工作台, from seed:56d5476aa1be809e. The signature interaction is direct comparison across a date row with obvious price and freshness, followed by the existing explicit official-site handoff. Light surfaces support an ordinary desktop/laptop used to organize the team's evening game. No external assets or fonts are needed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Provider faults must be visible from any tab and link to account takeover; remote-browser links are optional deployment configuration. Feishu configuration includes separately enabled administrator recipients. Sent history offers an explicit resend action with independent historical receipts; interrupted resends expose delivery reconciliation. Existing tokens, tab structure and calendar priority remain unchanged.

Accounts offer a scoped Restart browser action with disabled/loading states, preserving saved accounts and the previous pause/manual/automatic mode. The two PlayFootball venues share the same restart boundary.
