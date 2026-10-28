# Extension Workspaces - Execution Plan

## Phase 1: Project Setup & Audit
- [x] Analyze codebase architecture and identify causes for permissions warnings and auto-backup frequency bug.
- [x] Create project documentation (`.project/context.md` and `.project/PLAN.md`).

## Phase 2: Fix Host Permissions Request
- [x] Remove unnecessary `"host_permissions": ["<all_urls>"]` from `manifest.json`.
- [x] Verify that tab workspace management functions without host permissions.

## Phase 3: Fix Auto-Backup Trigger & Frequency Bug
- [x] Refactor `background.js` backup initialization: remove unconditional `createAutoBackup('startup')` call inside `checkAutoBackupAlarms()`.
- [x] Move `createAutoBackup('startup')` execution strictly into `browser.runtime.onStartup` event listener.
- [x] Prevent alarm reset loops by checking existing `autoBackupAlarm` before recreating it.
- [x] Clean up rogue alarm creation (`autoBackupCheck`) in `options.js`.

## Phase 4: Verification & Testing
- [x] Verify manifest validation and extension functionality.
- [x] Ensure auto-backups respect configured 3-hour interval without creating per-minute duplicates.

## Phase 5: Tab Migration to Main + Dead Scheduled Backup
- [x] STEP-05: Add `"alarms"` permission; recreate `autoBackupAlarm` from `onStartup`/`onInstalled` with `delayInMinutes` + `periodInMinutes`; options "Next backup" reads `alarms.get().scheduledTime`.
- [x] STEP-06: Sync provisional tab assignment in `onCreated` before any `await`; inherit workspace via `openerTabId` → current → fallback.
- [x] STEP-07: Stop blind claim of unmapped tabs into previous/Main in `switchWorkspace`; use pending-assignment set.
- [x] STEP-08: Enforce show → activate target → hide order; sync in-memory `isAllTabsMode`/`currentWorkspaceId` in `SHOW_ALL_TABS`.
- [x] STEP-09: Static verification of markers (manifest alarms, assignment helpers, alarm lifecycle).
- [x] STEP-10: Code review hardening (orphan → destination workspace; drop debug `console.log`); bump to `1.6.1`; add `CHANGELOG.md`.
- [x] STEP-11: Fix new-tab→Main regression: wait for init before final assign; resolve via opener/active tab (not session); rebuild fallback uses current/lastActive; sync workspace state from storage.
- [x] STEP-12: Fix All Tabs toggle stuck after sidebar reopen (`lastActiveWsId` declare/restore); update CHANGELOG.
- [x] STEP-13: Fix focus steal on tab click (gate saveState/onActivated during init; soft repairVisibility instead of full switchWorkspace on wake).
- [x] STEP-14: Stability pack — init re-get/merge + storage patches; provisional without session; no default resurrect from `[]`; orphan policy; activeMap only if tab.active; backup/commands/messages await ready; SHOW_ALL hides duplicate newtabs.

## Phase 6: Full Review — Root Cause of "all tabs relocated to a workspace never opened" + Icon Audit
- [x] STEP-15: Root-cause the "woke up, every tab was in workspace 4" report — traced to the `tabs.onRemoved` handler silently `switchWorkspace()`-ing into whichever other workspace had a leftover tab when the current one ran empty in a window (no prompt/notification/log).
- [x] STEP-16: Remove the silent cross-workspace jump; closing the last tab of the current workspace now only opens a fresh tab in the SAME workspace (only self-heals a dangling `currentWorkspaceId` pointing at a deleted workspace).
- [x] STEP-17: Harden `rebuildTabWorkspaceMapFromOpenTabs` — if 100% of restored tabs are unrecoverable (session/legacy data lost) while >1 workspace exists, fail safe into All Tabs mode instead of mass-funneling every tab into `currentWorkspaceId`; add a `SAFE_MODE_ALL_TABS` History log entry for transparency.
- [x] STEP-18: Icon audit — `updateContextMenus()` blanked the icon for every `img:`-type workspace (all 5 defaults) in the "Move tab to…" submenu; now uses `menus.create({ icons })` where supported.
- [x] STEP-19: Icon audit — added `onerror` fallback (→ 📁) for workspace list icon, move-menu icon, and History log icon (previously only the rename/copy/move/delete action buttons had this; a missing/broken custom icon rendered as a broken-image glyph).
- [x] STEP-20: `assignTabToWorkspace` now returns the `sessions.setTabValue` promise instead of discarding it. Bumped to `1.9`; documented in `CHANGELOG.md`.
- [ ] STEP-21 (proposed, not yet implemented — needs confirmation): de-duplicate `getLocalizedDefaults()` (background.js) / `getDefaultWorkspaces()` (sidebar.js), which must currently be kept in sync by hand; add true multi-window support (`currentWorkspaceId`/hide-show is currently global while several `browser.tabs.query` calls default to `currentWindow`, so a second Firefox window's visibility can drift out of sync); consider awaiting `setSessionWorkspace` at points where durability matters (e.g. before `switchWorkspace`, on `onSuspend`).

## Phase 7: Crash-on-tab-close Root Cause + Emoji Picker UX
- [x] STEP-22: Root-caused "closed a tab and the whole browser crashed, all tabs gone" — the
  `tabs.onRemoved` safety-net handler awaited `browser.tabs.query()` before deciding to open a
  replacement tab; while every other-workspace tab in the window is hidden via `tabs.hide()`,
  that `await` gap left a window where Firefox could see zero *visible* tabs and destroy the
  window/quit the browser before our replacement tab was created.
- [x] STEP-23: Fixed — the handler now decides from the in-memory `tabWorkspaceMap` synchronously
  (no `await` before the decision) and creates the replacement tab immediately whenever it cannot
  already prove (for free, without a browser call) that the current workspace still has a tab.
- [x] STEP-24: Documented the Firefox `tabs.hide()` caveat ("closing the last *visible* tab while
  others are hidden can close the window") in `context.md`, and recommended the user verify
  `Settings → General → Startup → "Open previous windows and tabs"` is enabled, since without it
  Firefox will not restore tabs after any crash/quit regardless of this extension.
- [x] STEP-25: Emoji/icon picker overhaul per user request — taller default height, `resize:
  vertical` drag handle, and a search box filtering ~135 emoji via a new parallel
  `EMOJI_KEYWORDS` array (English keywords). Added `searchEmoji`/`noEmojiFound` to `en`/`ru`
  locales (other 17 locales still fall back to the English default — follow-up if needed).

## Phase 8: Last-visible-tab still closes browser + picker/backup follow-ups
- [x] STEP-26: Replaced `tabs.create()`-only keep-alive with immediate `tabs.show()` of other
  (hidden) tabs already in the window — the only approach that reliably beats Firefox's
  "zero visible tabs → close window" race. Then `switchWorkspace` into a workspace that owns
  those tabs (ownership of tabs is NOT rewritten).
- [x] STEP-27: Emergency `crashRecoverySnapshot` written before unmapping a closed tab; on next
  startup, if the window is nearly empty and a recent snapshot exists, auto-restore via
  `sessions.getRecentlyClosed()` (same as Ctrl+Shift+T) + remap, or recreate from snapshot URLs.
- [x] STEP-28: Emoji picker — removed add-form max-height/overflow clip; grid 340px + search;
  bump to 1.10 so sidebar.html is definitely reloaded.
- [x] STEP-29: Auto-backup options 5/15/30 minutes; store frequency as minutes with migration
  from legacy hour values.
- [x] STEP-30: i18n completeness — added `autoBackup5m`/`15m`/`30m`, `searchEmoji`,
  `noEmojiFound`, `safeModeAllTabs`, `crashRecovery` to **all 19** `_locales/*/messages.json`
  (not only en/ru). Verified full key parity with en (163 keys each).
- [x] STEP-31: Full emoji catalog — replaced hand-listed ~135 emojis with `emoji-catalog.json`
  (~1870 entries from gemoji/Unicode, with English search keywords). Version 1.11.
- [x] STEP-32: Auto-backup default/normalize to 1 hour (60 min); fix blank frequency select.
- [x] STEP-33: Restore/import — pass `windowId` into `switchWorkspace` so tabs hide correctly
  immediately (not only after manual workspace click). Version 1.12.
- [x] STEP-34: Last-tab keep-alive — parallel `tabs.query`+`show` when in-memory window map is empty.

## Phase 9: Fix Session Restoration & Mass Migration on Startup
- [x] STEP-35: Gate emergency crash recovery on `isAllTabsMode` in `background.js` initialization to avoid redundant duplicate creation on normal browser starts.
- [x] STEP-36: Remove automatic adoption of unmapped visible tabs into destination workspace during `switchWorkspace`, preventing mass import of orphan tabs after recovery or All Tabs toggle.
- [x] STEP-37: Improve tab detection in `maybeRecoverAfterUnexpectedClose` by using `tabUrlCache` to account for Firefox lazy-loaded tabs (`about:blank`).
- [x] STEP-38: Clean up and remove unstable `maybeRecoverAfterUnexpectedClose()` and `fireCrashRecoverySnapshot()` triggers during startup and tab removal, fully restoring the reliable session architecture of commit `8479da3`.

## Phase 10: Sidebar Three-State Controls & Tab Count View
- [x] STEP-39: Present design proposals for icon and count badge styling to user (light/dark themes, clean typography per kill-ai-slop guidelines).
- [x] STEP-40: Implement three-state mode switch in `sidebar.js` / `sidebar.html` (`hidden` -> `actions` -> `counts`).
- [x] STEP-41: Create or integrate 64x64 transparent icon for tab counts mode supporting dark/light `--icon-filter`.
- [x] STEP-42: Add localized tooltips for the new state across all 19 locales in `_locales/*/messages.json`.

## Phase 11: Fix Session Restoration & Tab Visibility on Browser Startup
- [x] STEP-43: Prevent post-rebuild storage merges (`applyStorageSnapshot`, `pendingStoragePatches`) during background initialization from clobbering the freshly restored `tabWorkspaceMap` and `workspaceActiveTabMap` with obsolete tab IDs from the previous session.
- [x] STEP-44: Clean up `workspaceActiveTabMap` during `rebuildTabWorkspaceMapFromOpenTabs` to discard dead tab IDs and retain active valid browser tabs.
- [x] STEP-45: Extend `repairWorkspaceVisibility` during startup wakeup to loop over all normal browser windows (`browser.windows.getAll`), preventing restored tabs in secondary windows from remaining hidden or unreachable until All Tabs mode is toggled.

## Phase 12: Restore last-active tab on workspace switch + manifest recovery
- [x] STEP-46: Root-caused "switch back → first tab" — rebuild wiped `workspaceActiveTabMap` to first-tab-per-workspace; fixed preserve/active/`lastAccessed` rebuild + safer leave/activate in `switchWorkspace`.
- [x] STEP-47: Restored emptied `manifest.json` from last good commit; version **1.13**.
- [x] STEP-48: User chose **Firefox `storage.sync` only** (no second upload/download package UI). Default sync ON; conflict chooser (remote / local / merge); compress+chunk under 100KB/8KB quotas; UI in Options → Data Management; AMO listing update; no extra permissions/data-collection.
- [x] STEP-49: Handoff package for external implementer: `handoff/firefox-storage-sync/` (`prompt.md` + project snapshot + AMO text). Await `delivery/` back → merge/review locally.
- [x] STEP-50: Merged `answer/` delivery into live repo (1.14): `sync.js`, background/options/sidebar, locales ×19 via `tools/apply-sync-locales.mjs`, AMO listing, NOTES. Node smoke tests **15/15**. Permissions unchanged (`storage` only; `data_collection: none`).
- [ ] STEP-51: Manual browser QA for 1.14 sync (partially done — bugs found: false status, Never reset, conflict only in Options, unclear wait state).
- [x] STEP-52: Authored planning handoff for Sync UX overhaul v1.17: `handoff/firefox-sync-ux-v117/prompt.md` (ask external AI for PLAN only).
- [x] STEP-53: Sync UX v1.17 core shipped: join-once (non-joined never overwrites account), LWW for members, device roster + leave pending, selective prefs, info card, sidebar banner + action badge, i18n parity 222 keys ×19, preview/sync-options-preview.html. Manual two-profile QA still required (STEP-51).
- [x] STEP-54: Restored full planning doc from [Draft sync v2 PLAN](bf9db1ca-0309-4e77-b079-7df03018a452) into `PLAN-sync-round2.md` (was briefly overwritten by a short status note); marked done vs remaining.
- [x] STEP-55: Removed devices hint (`syncDevicesHint` / “Computers that share…”) from Options UI + all locales; translated remaining Sync UI strings across 19 locales (223 keys, parity OK; cognates Status/Quota/Firefox Sync left as-is).
- [x] STEP-56: AMO `innerHTML` warnings in `refreshSyncDevices` — rebuild device list via DOM (`createElement`/`textContent`/`replaceChildren`), drop unused `escapeHtml`.
- [x] STEP-57: Handoff for Sync clarity fix: `handoff/sync-clarity-fix/` (`prompt.md` + `TECH-NOTES.md` + README). External AI returns one delivery ZIP → unpack/replace locally.
- [x] STEP-58: Applied `Workspaces-1.18-sync-fix.zip` → v1.18; locales 235×19 parity OK; `node tests/sync-v2.test.mjs` **19/19**; legacy `tests/sync-smoke.mjs` still **pass**.
- [x] STEP-59: Applied `Workspaces-1.19-runaway-fix.zip` → consent >15 tabs, progress overlay, identity+isRestoringData+live dedupe; then **1.19.1** removed URL×3/10min sync-stop breaker (user rejection). Tests **23/23** + smoke OK; locales 245×19.
- [x] STEP-60: First-join-only consent (no >15 nag) → **1.19.2**.
- [x] STEP-61: Sync breath perimeter glow (sidebar + options) + preview buttons/themes → **1.19.3**.
- [x] STEP-62: Breath in Options color picker; light-theme stronger; replace sync fullscreen progress with 30s toast (+/−); i18n 260×19 → **1.19.4**.
- [x] STEP-64: Sync UI polish + close reliability → **1.19.5** (tombstone vs URL birth, faster close push, breath layout/i18n, no quiet toast / no live “up to date” label, color preview on both pages).
- [x] STEP-65: Duplicate same-URL tabs preserved via sync instance id `k` → **1.19.6**.
- [x] STEP-66: Replaced `k` with export-shaped tab lists (multiset by URL) → **1.19.7**.
- [ ] STEP-76: Full two-profile manual QA matrix (join, leave, LWW, locale layout, large apply consent + no tab multiply).
- [ ] STEP-63 (from PLAN-sync-round2): `convergeDocs` + tombstones TTL 30d (closes/deletes without relying only on whole-doc LWW).

## Phase 13: Firefox Sync reliability audit (2026-10-03)
- [ ] STEP-77: Audit and fix the reported cross-device sync failures.
  - [x] STEP-77.1: Replace snapshots without requiring two copies inside the quota and reject incomplete delivery.
  - [x] STEP-77.2: Preserve full URLs and redirect identities, fix duplicate counts and self-echo suppression, serialize sync operations.
  - [x] STEP-77.3: Pulse only after successful changes, add a local breathing-light switch, retain sidebar counts during rendering.
  - [x] STEP-77.4: Run regression/controller checks and document the protocol, limits and Firefox Sync guide in context.md. Native Firefox 156.0.1 QA passed (full URLs, duplicates, redirects, close/reopen, three ~72 KB compressed quota replacements, breathing checkbox, stable sidebar DOM/counts/layout). Evidence: `.project/sync-firefox-qa.json`.
  - [ ] STEP-77.5: Verify account delivery on separate devices. Not performed. Do not launch Firefox for QA per user request on 2026-10-03.
  - [x] STEP-77.6: Remove redundant five-second Options polling/countdown bar; clarify extension checks vs Firefox account transfer; display last processed time and raw/compressed payload sizes; align breathing checkbox; update all 19 locales and release notes (1.19.9). Static JSON/locale checks passed; Firefox was not launched as requested.
  - [x] STEP-77.7: Replace debounce/manual check with configurable per-profile snapshot interval (5/15/30/60m; default 15m); report local preparation and remote-update detection timestamps without claiming an unavailable server receipt; update all 19 locales and release notes (1.19.10). JavaScript syntax, locale parity and copy scan pass; Firefox was not launched.
  - [x] STEP-77.8: Show compact, non-layout-shifting tab-apply progress in Options and Sidebar; report phase-local remaining work and count only successful opens/closes; keep partial failures below 100%; update all 19 locales and release notes (1.19.11). Static checks and sync-v2 regressions pass; Firefox was not launched.
  - [x] STEP-77.9: Deduplicate replicated same-URL additions by shared birth cohort while retaining independent copies; compact expired tombstones even when URL fingerprints match; report active payload, orphan chunks, device bytes and document counts in Options; update all 19 locales and release notes (1.19.12). Sync regressions pass; live two-device delivery still requires the existing STEP-77.5 QA.
  - [x] STEP-77.10: Prepare a snapshot after five seconds of local quiet, compact deletion records after all active devices acknowledge them, simplify the sync status and payload UI, show per-device join/update dates, correct the History label and update all locales (1.19.13). Verification: syntax checks, 28 sync-v2 tests, 31 decision/convergence tests, 37 apply regressions, 8 controller tests, runtime checks, smoke tests and 19-locale parity pass. Firefox was not launched per user request; cross-account delivery still requires STEP-77.5.
  - [x] STEP-77.11: Reproduced stale laptop publication after replacing a YouTube tab and fixed member reconciliation to require explicit, unapplied close facts before reducing counts. Triggered compaction on roster acknowledgements, retained history on failed writes and published a short cleanup receipt. Verified 1500-record cleanup, stale-copy handling and observed clock skew. Included SVG resources, fixed the missing initial toolbar icon reference, simplified sync guidance in all 19 locales and released 1.19.14. Verification: 37 sync-v2 tests, 8 controller tests, 10 runtime scenarios, smoke tests, syntax checks, locale parity, copy scan and 60-file ZIP/resource checks pass. Firefox was not launched; real account delivery remains STEP-77.5.
  - [x] STEP-77.12: Simplified device removal in Options (one action per row: Disconnect / Remove now / Remove from list), clarified statuses and confirmations in all 19 locales, cleared stale leave records on rejoin, made devices removed while offline switch sync off, stopped disabled devices from re-registering on startup, aligned button styles; added tests/sync-devices.test.mjs (1.19.15).
  - [x] STEP-77.13: Fixed manual-language placeholder rendering ($COUNT$/$NAME$) in i18n.js, made ui_language sync only as a timestamped explicit choice (Auto never overwritten), renamed shortcuts to Open sidebar / Open workspace N (manifest __MSG__ + Options, 19 locales); added i18n and language-sync tests (1.19.16).
