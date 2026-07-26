# Changelog

## [1.6.1] — 2026-07-26

### Fixed
- **Tabs jumping to Main** — middle-click / Ctrl+click / “Open in new tab” could assign the new tab to Main. Fixed assignment order (opener → active tab → current/last-active workspace), wait for background init on cold wake, and stop using session values for user-opened tabs.
- **“All Tabs” stuck after reopening the sidebar** — after enabling All Tabs, closing and reopening the extension panel, the All Tabs button could not be turned off (`lastActiveWsId` was not declared/restored). State is now restored correctly from storage.
- **Scheduled auto-backup** — added the `alarms` permission (without it `browser.alarms` was unavailable, so only startup backups worked). The `autoBackupAlarm` is recreated on install, browser startup, script load, and when backup settings change.
- **Tabs disappearing on workspace switch** — `switchWorkspace` no longer claims unmapped tabs into the previous/Main workspace during races with `onCreated`.
- **Active tab left visible in the wrong workspace** — switch order is show → activate a tab of the target workspace → then hide others.
- **Orphan tabs** — pending assignments are not claimed into Main; true orphans attach to the destination workspace so they are not lost forever.
- **Options “Next backup”** — uses the real alarm `scheduledTime` when available instead of estimating from the last backup timestamp.

### Changed
- Removed the unused rogue alarm name `autoBackupCheck` from the options page (settings now only update storage; the background script owns alarms).
