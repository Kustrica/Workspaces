# Changelog

1.19.16
- Fixed menu items and dialogs showing raw placeholders such as "Move $COUNT$ Tabs to Workspace" or "$NAME$" when an interface language is chosen manually: the manual-language path now resolves named placeholders exactly like Firefox.
- The interface language no longer changes by itself through sync. Only an explicit choice made in Options (with its time) is synced, the newest choice wins, and "Auto" or values nobody picked are never pushed or applied.
- Switching the language back to Auto takes effect in the background (context menus) without restarting.
- Clearer shortcut names in Options and in Firefox's shortcut manager: "Open sidebar" and "Open workspace 1–9", in all 19 languages.
- Added i18n and language-sync regression tests.

1.19.15
- Clarified the "Devices in sync" list: each device now has one labelled action instead of an unexplained ✕ plus "Force remove". Disconnect (this or another device), Remove now (only while a device is still waiting to disconnect) and Remove from list (devices that no longer sync).
- Rewrote the device statuses, hint and confirmation texts in all 19 languages: nothing is deleted, sync only turns off on that device, and how to sync it again ("Sync workspaces and tabs" on that device).
- Turning sync back on after leaving or being removed now clears the old leave record, so the device is shown and counted as active again.
- A device removed with "Remove now" while offline turns sync off when it comes back instead of continuing to sync, and does not publish its stale copy.
- Devices with sync off no longer re-register on every startup, so "Remove from list" sticks.
- Device action buttons use the Options button palette instead of the mismatched pink/olive outline.

1.19.14
- Preserve locally opened tabs when a stale device snapshot arrives; require explicit close records before reducing tab counts.
- Compact deletion history when all active devices acknowledge it, react to device acknowledgements, and retain close records if a replacement write fails.
- Include SVG icons in release archives and verify all packaged resource references, restoring the tab-count toolbar icon.
- Simplify automatic sync instructions and explain Firefox Sync Now in all 19 languages; remove the five-second preparation hint.

1.19.13
- Prepare changed sync snapshots after five seconds without tab or workspace changes; remove the interval selector and polling alarms.
- Keep deletion records until every active device has acknowledged them, then compact the shared tombstone history without restoring closed tabs.
- Move sync status to the top, remove duplicate size diagnostics, and show each device's join date and last received update.
- Clarify the action-history sync label and localize the new device dates in all 19 languages.

1.19.12
- Prevented an already replicated same-URL tab from being counted twice when the saved common ancestor is behind; separate copies remain separate.
- Added a quota breakdown for raw/compressed active payload, unreferenced chunks, device records, other keys, tabs and deletion history.
- Reclaimed clearly outdated payload generations and publish expired deletion-history cleanup even when the tab list did not change.

1.19.11
- Added a compact tab-apply progress indicator to Options and the sidebar, showing the active stage, completed work, and remaining work.
- Counted only successful tab opens and closes; partial failures now retain their real progress instead of reporting 100%.
- Localized the progress messages in all 19 languages.

1.19.10
- Added a local sync-snapshot interval selector (5, 15, 30 or 60 minutes; default 15).
- Removed the manual check button and the 2.5-second local write debounce; interval changes trigger an immediate check.
- Showed separate local preparation and remote-update detection dates. Firefox does not expose a server delivery receipt.
- Updated sync timing and date descriptions in all 19 locales.

## [1.19.7] — 2026-09-15

### Fixed
- **Duplicate URLs sync like export/import.** Removed the experimental per-tab instance id (`k`).
  Sync now packs the same `{ url, groupId }[]` lists as export/backup, compares them by count
  (three identical pages → three rows), and merges with URL close-counts. No parallel identity
  system.

## [1.19.6] — 2026-09-15

### Fixed
- **Duplicate URLs now sync as separate tabs** (interim: instance id `k`; superseded by 1.19.7
  export-shaped lists).

## [1.19.5] — 2026-09-15

### Fixed
- **Closed tabs could come back after Firefox Sync.** Tombstones were compared to workspace
  mtime, so any rename/edit on the other device resurrected closed URLs. Closes now win
  unless the URL is truly reopened (`a` birth time newer than the tombstone). Opening a tab
  no longer wipes a peer’s close record just because the page is still visible.
- **Close push was too slow (20s debounce)** and sometimes used a missing intended URL —
  tombstones now schedule a push in ~2.5s and prefer the cached/intended URL.

### Changed
- Breath color copy + short join hint updated in all 19 locales; swatches sit to the right of
  the text; clicking a color previews breath on Options **and** the sidebar.
- Quiet “already up to date” toast removed. Toasts only on Options (bottom-right) when tabs
  actually open/close. “Everything up to date” under the live bar removed; device status is gray.
- Quiet edge pulse when Firefox Sync delivers a remote meta update that needs no tab changes.

## [1.19.4] — 2026-09-15

### Changed
- **Sync apply no longer dims the whole sidebar/options with a big percentage overlay.** Instead:
  soft **Changed / Quiet** edge breath, plus a compact toast (opened/closed counts) that stays
  ~30 seconds and dismisses on click.
- **Breath colors are selectable in Options** (Orange, Amber, Mint, Sky, Rose; default Orange).
- **Light theme breath is much stronger** so the glow is visible on white backgrounds.

## [1.19.3] — 2026-09-15

### Added
- **Sync breath** — a soft edge glow around the sidebar and the Options page when sync
  actually changes something (tabs/workspaces). A much quieter pulse when a sync pass finds
  nothing new. Same orange→amber gradient family as the live sync bar; optional mint / sky /
  rose / amber themes. Preview strip with buttons **1 · Changed**, **2 · Quiet**, **3 · Wave**
  plus theme chips (choice saved). Respects `prefers-reduced-motion`.

## [1.19.2] — 2026-09-15

### Changed
- **Consent dialog is first-join only**, not “whenever more than 15 tabs would open.” Day-to-day
  sync (20 new tabs from the other PC, etc.) runs automatically after you have joined once.
  A new/empty device that finds an existing account copy still asks once: Sync now / Later /
  Turn off sync — with clearer copy about *first sync*.

## [1.19.1] — 2026-09-15

### Changed
- **Removed the “same URL 3× in 10 minutes → stop sync” breaker.** It only fired after tabs
  had already been duplicated and confused users. Prevention is the real fix from 1.19:
  intended-URL identity while loading, `isRestoringData` during apply, live dedupe before
  `tabs.create`, first-join consent, and a hard 500-create pass limit.

## [1.19] — 2026-09-15

### Fixed (critical — tabs multiplied and everything landed in Main)
- **Sync opened the same tabs over and over.** After an apply created a tab, the tab reports
  `about:blank` while it loads (and a different URL after a redirect), so the next five-second
  cycle still saw the requested URL as missing and created it again — 165 tabs grew past 300,
  climbing with every exchange. A tab created by sync now keeps its requested URL as its
  identity until it has finished loading, after which the real URL is published instead. A live
  guard also re-checks what is already open immediately before creating anything, so a stale
  diff cannot produce a duplicate.
- **All synced tabs ended up in Main instead of their own workspaces.** The incremental apply
  set only its own internal flag, so `tabs.onCreated` treated every tab it created as a
  user-opened tab and re-assigned it to the current workspace. The apply now runs with the
  same restore flag the JSON import uses, which is exactly what suppresses that resolver.
  Because the tabs then landed in the wrong workspace, the next cycle also saw them as still
  missing — the two bugs were feeding each other.
- **A sync apply can no longer flip the view into All Tabs mode by itself.** The previous mode
  is restored and persisted explicitly at the end of the apply.

### Added
- **Nothing is applied silently on first join.** A fresh device that finds an existing
  account copy asks once: how many tabs will open/close, then **Sync now**, **Later**
  (asks again in 10 minutes) or **Turn off sync**. After that join, day-to-day sync is
  automatic (no repeated prompts when the other device adds 20 tabs). If this device
  already has real local workspaces, the older Replace / Merge join dialog still appears
  once instead.
- **Progress while tabs are being restored**, in the sidebar and on the settings page, reusing
  the import overlay: percentage, tabs done out of total, and the existing "please do not do
  anything in the browser" warning. It stays up until the whole pass — opening, closing and
  arranging into workspaces — is finished.
- A sidebar banner and a toolbar badge whenever a pull is waiting for confirmation, so the
  decision is visible without opening the settings page.
- 10 new interface strings in all **19** locales (245 keys each, parity verified).

### Notes
- An in-page floating window on whatever site the user is browsing would require injecting a
  content script into every page (`<all_urls>`), which would add a host permission and an AMO
  data-collection review. It was deliberately not done: the sidebar, the settings page and the
  toolbar badge cover the same need with no new permissions.
- Permissions unchanged, `data_collection_permissions` still `["none"]`.

## [1.18] — 2026-09-15

### Fixed (critical — sync never actually exchanged data)
- **Two devices kept overwriting each other instead of syncing.** The pull path compared the
  remote document timestamp with the local one, but a local snapshot is stamped at collect
  time (`Date.now()`), so "local is newer" was always true. Every device therefore took the
  push branch on every exchange and no data ever crossed: the roster showed both machines,
  the quota and last-sync time differed on each, pressing Sync Now anywhere changed nothing,
  and no conflict window could appear because both devices already counted as members.
  Decisions are now made against `syncBaseFp` — the fingerprint both sides last agreed on —
  in one pure, unit-tested function: only the peer moved means fast-forward, only we moved
  means publish, both moved means a real merge and then publish.
- **Closed tabs came back from the dead.** Convergence was a union of both sides, so closing a
  tab on one device re-added it from the other on the next exchange, forever. Deletions are now
  recorded as facts (tombstones, 30-day life) alongside per-workspace revisions, and a deletion
  beats a resurrection unless the URL was genuinely reopened afterwards. The same applies to
  deleted workspaces.
- **Remote changes no longer rebuild every tab.** Routine convergence applies only the
  difference — create what is missing, close what is gone — instead of closing and recreating
  the whole profile, which on a 160-tab setup destroyed scroll position and history.
- **The interface was partly in the wrong language.** The sync block had its own
  `DOMContentLoaded` listener and rendered before `initI18n()` resolved, so strings fell back to
  the browser locale instead of the chosen interface language, and `currentLang` was still
  "auto" when dates were formatted — which is why month names stayed in another language.
  The block now waits for the dictionary and the stored language before its first render.

### Changed
- **Concurrent writers can no longer corrupt the synced copy.** Chunk keys carry a generation
  (`sync_payload_<gen>_<i>`) and a reader assembles one generation only. `storage.sync` is
  last-write-wins per key with no transaction across keys, so two devices writing at the same
  moment could previously interleave slices of two documents. Payloads written by 1.14–1.17 are
  still read, and are cleaned up on the next write.
- **The wide "Sync Now" button is gone.** Four sync buttons across two machines and the Firefox
  menu was the main source of confusion. In its place a slim live bar fills over five seconds
  and checks on each cycle while the settings page is open; clicking it checks immediately.
  The bar is a countdown to the next check, not a transfer progress bar — Firefox owns the
  actual device-to-device transfer, and the copy says so.
- Status texts now describe the data ("Up to date", "Receiving changes…", "Sending changes…"),
  not the checkbox. The long "Saved for sync…" sentence is replaced by one calm permanent line
  that states the real cadence: every 5 seconds with the page open, every 15 minutes in the
  background, and a few minutes for Firefox to move it.
- Toasts are short and factual: "Sent — waiting for Firefox", "Changes received".
- Device names are now distinguishable — `Firefox · Windows · A7F3`, with a stable suffix from
  the device id. Firefox exposes neither the Sync device name nor the account e-mail to
  extensions (`sessions.getDevices` was never implemented, bugzilla 1308059), so an automatic
  label is the honest maximum.
- Removing a device now says what will really happen, separately for this device and for a
  remote one, and states that removing one device does not affect the others.
- The info card has a fixed height and the device list is only redrawn when it actually
  changes, so the page no longer jumps or flickers.
- 12 new interface strings added to all **19** locales (235 keys each, parity verified).

### Notes
- Sync still transfers on Firefox's own schedule (roughly every 10 minutes, or the browser's
  own Sync Now). No extension can force that, and nothing in the interface claims otherwise.
- Upgrading from 1.17: devices with no common ancestor yet perform one merge instead of
  overwriting each other, so nothing is lost on the first exchange after the update.
- No new permissions. `storage.sync` remains part of the existing `"storage"`,
  `data_collection_permissions` stays `["none"]`, and no host permissions were added.

## [1.17] — 2026-09-15

Added
- One-time join on a new device only: Replace synced copy or Merge with local tabs. After that, sync runs automatically with no more conflict prompts on established devices.
- Device list in Options with leave request (yellow pending until the other device confirms) and optional force remove.
- Selective sync checkboxes for theme, interface language, sidebar/UI settings, and History log.
- Info card for last sync, quota, and status (same inset style as Auto-Backups). Toolbar badge and sidebar banner when join is needed.
- Clearer Sync Now feedback: data is saved locally, then Firefox Sync transfers it to other devices.

Changed
- Non-joined devices never overwrite the account copy (fixes the race where a nearly empty laptop became the synced copy).
- Same workspace names merge into one even when icons differ.
- Removed the desktop-only note line. Helper text now points to Firefox Settings, Sync, Manage Sync, Add-ons.
- Version bumped to 1.17. No new permissions. data_collection_permissions stays none.

Notes
- Devices that already synced in 1.14 are treated as joined (no extra join prompt).
- Closing or deleting on one joined device propagates via last-write-wins of the full snapshot (newer timestamp wins).

## [1.14] — 2026-09-15

Added
- Sync of workspaces and tabs across devices through your Firefox Account (browser.storage.sync).
- New control in Options, Data Management, Firefox Sync: enable/disable toggle (default on), Sync Now, last-synced time, and quota usage.
- Conflict chooser in 1.14 (replaced by one-time join in 1.17).

## [1.13] — 2026-09-15

- Fixed workspace switching (including keyboard shortcuts) so the last active tab in that workspace opens again, instead of the first tab in the list.

## [1.12] — 2026-07-27

### Fixed
- **Auto-backup frequency blank / "Next backup: Disabled"** — after the hours→minutes migration, an unmatched stored value left the `<select>` with nothing selected (shown as disabled). Defaults are now **1 hour (60 minutes)**; on load the options page and alarm logic normalize storage to a valid minute value and select the matching option explicitly.
- **Import/restore from auto-backup showed every tab in Main until a manual workspace switch** — `switchWorkspace` used `currentWindow: true`, which is unreliable in the background script (restored tabs live in a specific `targetWindowId`). Restore now passes that window id into `switchWorkspace` / `repairWorkspaceVisibility` so foreign-workspace tabs are hidden as soon as progress completes.
- **Last-visible-tab window close** — if the in-memory window→tab map was incomplete, keep-alive fell through to a slow `tabs.create()`. Now also fires a parallel `tabs.query({ windowId })` + `tabs.show()` so hidden tabs from other workspaces can still save the window.

## [1.11] тАФ 2026-07-27

### Changed
- **Emoji picker now includes the full emoji set (~1870)** instead of a hand-maintained shortlist
  of ~135. The catalog is loaded from `emoji-catalog.json` (built from the Unicode/gemoji dataset:
  emoji + English description/aliases/tags for search). No more manual `EMOJIS` / `EMOJI_KEYWORDS`
  arrays in code. Search still works by typing English keywords (e.g. "rocket", "folder", "heart").

## [1.10] тАФ 2026-07-27

### Fixed (critical тАФ browser still closed on last workspace tab)
- **Closing the last visible tab no longer relies on `tabs.create()` alone.** Hidden tabs from
  other workspaces do not keep a Firefox window open. The handler now immediately `tabs.show()`s
  surviving tabs already in the window (zero awaits before that call), then switches into a
  workspace that owns them. Creating a blank tab is only the fallback when the window truly has
  no other tabs left.
- **Emergency crash snapshot + auto-restore.** Before maps are cleared on tab close, the extension
  writes `crashRecoverySnapshot` (URLs + workspace mapping). On the next startup, if the window
  came back nearly empty but a recent snapshot exists, it restores via
  `sessions.getRecentlyClosed()` (same mechanism as Ctrl+Shift+T) and remaps tabs to their
  workspaces тАФ or recreates tabs from the snapshot as a last resort.

### Fixed (emoji picker)
- Removed `max-height` / `overflow: hidden` animation on the add-workspace form that was clipping
  the picker. Grid default height is now **340px**, resizable, with a dedicated search field
  above it. Version bump to 1.10 so a full extension reload picks up `sidebar.html` changes.

### Added
- Auto-backup intervals: **5 / 15 / 30 minutes** (frequency storage migrated from hours тЖТ minutes).

## [1.9] тАФ 2026-07-27

### Fixed (critical тАФ root cause of "all tabs suddenly appeared in a workspace I never opened")
- **Silent cross-workspace jump on tab close** тАФ when the current workspace ran out of tabs in a
  window, the extension searched for *any other* workspace that had a leftover/hidden tab and
  silently `switchWorkspace()`'d into it, with no prompt, notification, or log entry. This is how
  a user's active workspace could quietly become e.g. "Workspace 4" without ever clicking it тАФ
  every tab opened afterwards (that day, and again after the next browser restart) then got
  legitimately recorded under that workspace, looking exactly like "everything moved by itself".
  Fixed: closing the last tab of the current workspace now only opens a fresh tab **in the same
  workspace**; the extension never changes `currentWorkspaceId` as a side effect of a tab close
  (it only self-heals a dangling reference if the workspace itself was deleted).
- **Mass single-workspace fallback when tab/session tracking data is lost** тАФ on cold start,
  tabs with no recoverable session or legacy mapping (private browsing, "never remember history",
  an unclean shutdown, a fresh profile, etc.) were all funneled into whatever `currentWorkspaceId`
  happened to be, hiding every other workspace's tabs. If **all** restored tabs were unrecoverable
  at once, the extension now fails safe into **All Tabs mode** instead тАФ nothing gets hidden, the
  user sees everything they had, and a diagnostic entry is added to the History log.

### Fixed (icons)
- **"Move tab toтАж" context submenu showed no icon for any default workspace** тАФ all 5 default
  workspaces use an image icon (`img:...`), which was previously blanked out because native
  context-menu items can't render `<img>` tags. Firefox's `menus.create` actually supports a real
  per-item icon (`icons: {"16": url}`); the submenu now shows the workspace's real icon instead of
  nothing (falls back gracefully to a text prefix / no icon on platforms without that API).
- **Broken/missing custom workspace icon rendered as a broken-image placeholder** in the
  workspace list, the "move tabs" menu, and the History log тАФ added `onerror` fallbacks (matching
  the existing rename/copy/move/delete action buttons) so a missing icon file now falls back to a
  generic ЁЯУБ icon instead of a broken image glyph.

### Fixed (critical тАФ "closed one tab and the whole browser crashed / every tab vanished")
- **Closing the last visible tab of a workspace could crash/close the entire browser.** Every
  tab belonging to another workspace is hidden via `tabs.hide()`. If the tab the user just closed
  was the only *visible* one left in the window, Firefox could treat the window as tab-less and
  destroy it (or quit entirely, if it was the last window) тАФ faster than our own `async` handler
  could react, because it first did an `await browser.tabs.query(...)` before even deciding
  whether to open a replacement tab. The handler now decides synchronously from the in-memory
  tabтЖФworkspace map (zero `await` before the decision) and opens the replacement tab as the very
  first thing when there is any doubt, instead of querying first тАФ this removes the artificial
  delay that was losing the race. See `context.md` for the underlying Firefox `tabs.hide()`
  caveat. If tabs still ever appear to vanish after a crash, also check
  `Settings тЖТ General тЖТ Startup тЖТ "Open previous windows and tabs"` тАФ without it, Firefox will
  not restore tabs after any crash/quit at all, extension or not.

### Added
- **Emoji/icon picker overhaul** (workspace creation) тАФ the picker was a handful of visible rows
  that was awkward to browse and close. It is now much taller by default, resizable by dragging
  its bottom-right corner (`resize: vertical`), and has a search box that filters ~135 emoji by
  English keyword (e.g. "money", "travel", "music") instead of requiring visual scanning.

### Changed
- `assignTabToWorkspace` now returns the underlying `sessions.setTabValue` promise instead of
  discarding it, so future callers can await durability where it matters.

## [1.6.1] тАФ 2026-07-26

### Fixed
- **Focus jumps to Main when clicking a tab** тАФ on background cold wake, `onActivated` could `saveState()` with default Main and then force a workspace switch, stealing focus. Init now skips early saves, ignores activation during load, and only soft-repairs tab visibility without changing the active tab when it already belongs to the current workspace.
- **Tabs jumping to Main** тАФ middle-click / Ctrl+click / тАЬOpen in new tabтАЭ could assign the new tab to Main. Fixed assignment order (opener тЖТ active tab тЖТ current/last-active workspace), wait for background init on cold wake, and stop using session values for user-opened tabs.
- **тАЬAll TabsтАЭ stuck after reopening the sidebar** тАФ after enabling All Tabs, closing and reopening the extension panel, the All Tabs button could not be turned off (`lastActiveWsId` was not declared/restored). State is now restored correctly from storage.
- **Scheduled auto-backup** тАФ added the `alarms` permission (without it `browser.alarms` was unavailable, so only startup backups worked). The `autoBackupAlarm` is recreated on install, browser startup, script load, and when backup settings change.
- **Tabs disappearing on workspace switch** тАФ `switchWorkspace` no longer claims unmapped tabs into the previous/Main workspace during races with `onCreated`.
- **Active tab left visible in the wrong workspace** тАФ switch order is show тЖТ activate a tab of the target workspace тЖТ then hide others.
- **Orphan tabs** тАФ pending assignments are not claimed into Main; wake repair does not auto-adopt orphans; visible orphans on explicit switch attach to the destination workspace.
- **Options тАЬNext backupтАЭ** тАФ uses the real alarm `scheduledTime` when available instead of estimating from the last backup timestamp.

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

