# Pitch Reserve

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single local user arranging an evening football game in London. The user has confirmed that available dates, venues and prices should lead the interface.

## Product Purpose

Monitor four ordinary pitch-hire entries for Monday–Thursday sessions starting at 18:00, by default from tomorrow in London through two calendar months later, with a preference for one booking per week across all venues. The date range rolls daily; users can choose one/two weeks or one/two/three months ahead.

## Operating Context

A lightweight Windows/Linux console, local-only by default at 127.0.0.1:4318 with explicit subnet-restricted LAN startup, backed by Node.js, Playwright, SQLite and three separate browser/account groups. GGCB and Tower Hamlets have separate accounts; the two PlayFootball venues share one account.

## Capabilities and Constraints

- GGCB half pitch, Stepney Green Third, Westferry ordinary 5v5 and Poplar ordinary 7v7.
- Read-only inventory monitoring; automatic holding and payment are disabled.
- Results distinguish availability, unavailable inventory, release windows, unknown data and stale observations. Website limits must remain visible.
- Prices and duration come from actual observations; missing information must remain unverified.
- Links open the corresponding official venue in the visiting user's browser, without navigating or pausing the server's scanner browser.
- A durable availability-notification outbox records newly observed availability, deduplicates continuous availability, and retains delivery/retry/expiry state. Optional Feishu delivery supports user and group recipients, with explicit enabling, encrypted settings and per-recipient receipts.
- Encrypted local credentials, visible saved usernames, fixed password masks and manual login takeover must remain usable.
- Council monitoring automatically applies saved defaults and the explicitly saved address choice, then reads the calendar. Missing personal data or unchecked consent needs human input. No personal configuration belongs in source control.
- Manual takeover returns to monitoring after one minute without trusted website or console activity, subject to login/challenge checks. Explicit pause stays paused. Calendar cells distinguish unverified dates (“暂未核实”, yellow), confirmed release limits (“暂无信息”, gray), and failed queries (“查询失败”, red), with the reason retained. Confirmed observations keep their existing presentation.
- The console requires an awake computer and running service.

## Brand Commitments

Keep the product name Pitch Reserve and Chinese interface copy. The user has requested a layout redesign; the former green card layout is not binding.

The user chose the conventional “标准工作台” direction: familiar top navigation, a neutral table, and actionable dates, venues and prices in the first viewport.

## Evidence on Hand

The running local console, repository adapters, README.md, docs/website-validation.md and scripts/verify-console.ts. Real inventory changes over time; do not invent current availability or prices for the design.

## Product Principles

1. Put actionable dates and prices before administration.
2. Show uncertainty and freshness next to the observation.
3. Keep user takeover and account saving explicit.
4. Preserve the lightweight local runtime and read-only booking boundary.

Feishu configuration belongs to the Notifications tab. Individual pending/failed notifications support explicit manual delivery to saved enabled recipients, independently of the automatic-delivery switch, with the same freshness, expiry and dedupe protections.

Recovery closes and reopens a timed-out resource tab once; a repeated timeout or human verification requests manual takeover visibly. Feishu has independent administrator recipients and persistent incident dedupe; explicit resends preserve original receipts and label historical inventory. Linux supports Chromium, AES-GCM secret storage and an optional protected remote-desktop link for manual verification.

For PlayFootball challenge loops, an explicit ordinary-browser verification action closes the scanner and opens its dedicated profile without an automation connection. The human verifies and closes that window; idle recovery then reconnects read-only monitoring. A process marker protects that profile across service restarts, and explicit pause still wins. This is a human handoff, not a promise that the venue accepts resumed automation.
Ubuntu direct-start deployments can launch an optional password-protected virtual desktop with start-desktop.sh and open it through the same console /desktop/ route. VNC/noVNC listeners remain loopback-only, and HTTP/WebSocket access follows the console network/origin guards. Runtime history is filterable and paginated, retains 5000 database records and 14 daily sanitized JSONL files, and records scan stages, coverage, price counts, recovery and diagnosed failures. Headless monitoring remains available through start.sh.
