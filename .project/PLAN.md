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
