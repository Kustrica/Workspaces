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
