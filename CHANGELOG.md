# Changelog

## [1.12] — 2026-07-27

### Fixed
- **Auto-backup frequency blank / "Next backup: Disabled"** — after the hours→minutes migration, an unmatched stored value left the `<select>` with nothing selected (shown as disabled). Defaults are now **1 hour (60 minutes)**; on load the options page and alarm logic normalize storage to a valid minute value and select the matching option explicitly.
- **Import/restore from auto-backup showed every tab in Main until a manual workspace switch** — `switchWorkspace` used `currentWindow: true`, which is unreliable in the background script (restored tabs live in a specific `targetWindowId`). Restore now passes that window id into `switchWorkspace` / `repairWorkspaceVisibility` so foreign-workspace tabs are hidden as soon as progress completes.
- **Last-visible-tab window close** — if the in-memory window→tab map was incomplete, keep-alive fell through to a slow `tabs.create()`. Now also fires a parallel `tabs.query({ windowId })` + `tabs.show()` so hidden tabs from other workspaces can still save the window.

## [1.11] — 2026-07-27

### Changed
- **Emoji picker now includes the full emoji set (~1870)** instead of a hand-maintained shortlist
  of ~135. The catalog is loaded from `emoji-catalog.json` (built from the Unicode/gemoji dataset:
  emoji + English description/aliases/tags for search). No more manual `EMOJIS` / `EMOJI_KEYWORDS`
  arrays in code. Search still works by typing English keywords (e.g. "rocket", "folder", "heart").

## [1.10] — 2026-07-27

### Fixed (critical — browser still closed on last workspace tab)
- **Closing the last visible tab no longer relies on `tabs.create()` alone.** Hidden tabs from
  other workspaces do not keep a Firefox window open. The handler now immediately `tabs.show()`s
  surviving tabs already in the window (zero awaits before that call), then switches into a
  workspace that owns them. Creating a blank tab is only the fallback when the window truly has
  no other tabs left.
- **Emergency crash snapshot + auto-restore.** Before maps are cleared on tab close, the extension
  writes `crashRecoverySnapshot` (URLs + workspace mapping). On the next startup, if the window
  came back nearly empty but a recent snapshot exists, it restores via
  `sessions.getRecentlyClosed()` (same mechanism as Ctrl+Shift+T) and remaps tabs to their
  workspaces — or recreates tabs from the snapshot as a last resort.

### Fixed (emoji picker)
- Removed `max-height` / `overflow: hidden` animation on the add-workspace form that was clipping
  the picker. Grid default height is now **340px**, resizable, with a dedicated search field
  above it. Version bump to 1.10 so a full extension reload picks up `sidebar.html` changes.

### Added
- Auto-backup intervals: **5 / 15 / 30 minutes** (frequency storage migrated from hours → minutes).

## [1.9] — 2026-07-27

### Fixed (critical — root cause of "all tabs suddenly appeared in a workspace I never opened")
- **Silent cross-workspace jump on tab close** — when the current workspace ran out of tabs in a
  window, the extension searched for *any other* workspace that had a leftover/hidden tab and
  silently `switchWorkspace()`'d into it, with no prompt, notification, or log entry. This is how
  a user's active workspace could quietly become e.g. "Workspace 4" without ever clicking it —
  every tab opened afterwards (that day, and again after the next browser restart) then got
  legitimately recorded under that workspace, looking exactly like "everything moved by itself".
  Fixed: closing the last tab of the current workspace now only opens a fresh tab **in the same
  workspace**; the extension never changes `currentWorkspaceId` as a side effect of a tab close
  (it only self-heals a dangling reference if the workspace itself was deleted).
- **Mass single-workspace fallback when tab/session tracking data is lost** — on cold start,
  tabs with no recoverable session or legacy mapping (private browsing, "never remember history",
  an unclean shutdown, a fresh profile, etc.) were all funneled into whatever `currentWorkspaceId`
  happened to be, hiding every other workspace's tabs. If **all** restored tabs were unrecoverable
  at once, the extension now fails safe into **All Tabs mode** instead — nothing gets hidden, the
  user sees everything they had, and a diagnostic entry is added to the History log.

### Fixed (icons)
- **"Move tab to…" context submenu showed no icon for any default workspace** — all 5 default
  workspaces use an image icon (`img:...`), which was previously blanked out because native
  context-menu items can't render `<img>` tags. Firefox's `menus.create` actually supports a real
  per-item icon (`icons: {"16": url}`); the submenu now shows the workspace's real icon instead of
  nothing (falls back gracefully to a text prefix / no icon on platforms without that API).
- **Broken/missing custom workspace icon rendered as a broken-image placeholder** in the
  workspace list, the "move tabs" menu, and the History log — added `onerror` fallbacks (matching
  the existing rename/copy/move/delete action buttons) so a missing icon file now falls back to a
  generic 📁 icon instead of a broken image glyph.

### Fixed (critical — "closed one tab and the whole browser crashed / every tab vanished")
- **Closing the last visible tab of a workspace could crash/close the entire browser.** Every
  tab belonging to another workspace is hidden via `tabs.hide()`. If the tab the user just closed
  was the only *visible* one left in the window, Firefox could treat the window as tab-less and
  destroy it (or quit entirely, if it was the last window) — faster than our own `async` handler
  could react, because it first did an `await browser.tabs.query(...)` before even deciding
  whether to open a replacement tab. The handler now decides synchronously from the in-memory
  tab↔workspace map (zero `await` before the decision) and opens the replacement tab as the very
  first thing when there is any doubt, instead of querying first — this removes the artificial
  delay that was losing the race. See `context.md` for the underlying Firefox `tabs.hide()`
  caveat. If tabs still ever appear to vanish after a crash, also check
  `Settings → General → Startup → "Open previous windows and tabs"` — without it, Firefox will
  not restore tabs after any crash/quit at all, extension or not.

### Added
- **Emoji/icon picker overhaul** (workspace creation) — the picker was a handful of visible rows
  that was awkward to browse and close. It is now much taller by default, resizable by dragging
  its bottom-right corner (`resize: vertical`), and has a search box that filters ~135 emoji by
  English keyword (e.g. "money", "travel", "music") instead of requiring visual scanning.

### Changed
- `assignTabToWorkspace` now returns the underlying `sessions.setTabValue` promise instead of
  discarding it, so future callers can await durability where it matters.

## [1.6.1] — 2026-07-26

### Fixed
- **Focus jumps to Main when clicking a tab** — on background cold wake, `onActivated` could `saveState()` with default Main and then force a workspace switch, stealing focus. Init now skips early saves, ignores activation during load, and only soft-repairs tab visibility without changing the active tab when it already belongs to the current workspace.
- **Tabs jumping to Main** — middle-click / Ctrl+click / “Open in new tab” could assign the new tab to Main. Fixed assignment order (opener → active tab → current/last-active workspace), wait for background init on cold wake, and stop using session values for user-opened tabs.
- **“All Tabs” stuck after reopening the sidebar** — after enabling All Tabs, closing and reopening the extension panel, the All Tabs button could not be turned off (`lastActiveWsId` was not declared/restored). State is now restored correctly from storage.
- **Scheduled auto-backup** — added the `alarms` permission (without it `browser.alarms` was unavailable, so only startup backups worked). The `autoBackupAlarm` is recreated on install, browser startup, script load, and when backup settings change.
- **Tabs disappearing on workspace switch** — `switchWorkspace` no longer claims unmapped tabs into the previous/Main workspace during races with `onCreated`.
- **Active tab left visible in the wrong workspace** — switch order is show → activate a tab of the target workspace → then hide others.
- **Orphan tabs** — pending assignments are not claimed into Main; wake repair does not auto-adopt orphans; visible orphans on explicit switch attach to the destination workspace.
- **Options “Next backup”** — uses the real alarm `scheduledTime` when available instead of estimating from the last backup timestamp.

### Stability
- Init re-reads storage before force-save so a sidebar switch during wake is not overwritten.
- Storage changes during init are buffered and merged.
- `SWITCH_WORKSPACE` / `SHOW_ALL_TABS` / keyboard shortcuts / auto-backup wait until state is ready.
- Provisional new-tab assign during init does not write session (avoids cementing Main).
- Empty `workspaces: []` no longer resurrects default workspaces.
- Background middle-click no longer becomes the remembered active tab for a workspace.
- Duplicate `about:newtab` tabs are hidden in All Tabs mode.

### Changed
- Removed the unused rogue alarm name `autoBackupCheck` from the options page (settings now only update storage; the background script owns alarms).

