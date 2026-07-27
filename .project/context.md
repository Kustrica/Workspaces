# Project Context

## Project Overview
"Workspaces" is a WebExtension for browser tab and workspace management (designed for Firefox and Chromium browsers). It allows users to group tabs into workspaces, switch between workspaces smoothly, hide/show workspace tabs using browser tab management APIs, and maintain automatic and manual tab backups.

## Stack & Architecture
- **Tech Stack**: Vanilla HTML5, CSS3, JavaScript (ES6+), WebExtension Manifest V3 (MV3).
- **Core Files**:
  - `manifest.json`: Extension manifest V3 defining permissions, background scripts, sidebar action, and commands.
  - `background.js`: Background script handling state management, tab switching, session storage sync, context menus, keyboard shortcuts, and auto-backups via `browser.alarms`.
  - `sidebar.html` / `sidebar.js`: Sidebar panel UI for managing workspaces, viewing active tabs, actions, and logs.
  - `options.html` / `options.js`: Extension settings page for managing shortcuts, backup configuration, data export/import, and theme.
  - `i18n.js` / `_locales/`: Multi-language internationalization system.
- **New-tab assignment order**: opener tab workspace (`openerTabId`, re-fetched) → active tab in the same window → `currentWorkspaceId` / `lastActiveWsId` → first workspace fallback. Session values are used on rebuild/startup, not for user-opened tabs in `onCreated` (that path was pushing tabs into Main).
- **Background wake**: Listeners must not `saveState()` during init. After load, re-read storage (merge sidebar writes), then `repairWorkspaceVisibility({ allowActivate: false })`. Provisional `onCreated` during init is memory-only (no session). `SWITCH_WORKSPACE` / `SHOW_ALL_TABS` wait for init via `runWhenReady`.
- **Empty workspaces list**: An explicit `workspaces: []` must not resurrect default Main/Study workspaces.
- **Auto-backup alarms**: `autoBackupAlarm` is created/refreshed on script load, `onInstalled`, `onStartup`, and when backup settings change. Startup backups still use `onStartup` → `createAutoBackup('startup')` independently of the periodic alarm.

## Constraints & Rules
- Firefox & Chromium compatibility (Manifest V3).
- Strict adherence to non-persistent background script lifecycle (event page / service worker). Global handlers must not trigger side-effects like background task executions on simple script load.
- Avoid unnecessary permissions (e.g. `<all_urls>` host permissions) to preserve privacy and prevent security warnings.
- Permission `"alarms"` is required for scheduled auto-backups; without it `browser.alarms` is unavailable and only startup backups work.
- `switchWorkspace` must not claim unmapped tabs into the previous workspace (causes tabs to migrate into Main during races with `onCreated`).
- Hide order when switching: show target tabs → activate a tab that belongs to the target workspace → then hide others.
- `currentWorkspaceId` must NEVER change as a side effect of closing a tab. If a window runs out of tabs for the current workspace, only open a fresh tab in that SAME workspace — never search for/jump to a different workspace that happens to have a leftover tab (this was the root cause of tabs silently ending up in an unopened workspace; see STEP-15/16 in PLAN.md).
- On cold start, if 100% of restored tabs have no recoverable session/legacy workspace mapping (session data lost — private browsing, forced shutdown, fresh profile) while more than one workspace exists, do not funnel them all into `currentWorkspaceId`; fail safe into All Tabs mode and log a `SAFE_MODE_ALL_TABS` entry instead (see STEP-17).
- `img:`-type workspace icons must have an `onerror` fallback (→ 📁) everywhere they're rendered (workspace list, move-menu, History log) so a missing/broken custom icon file never shows a broken-image glyph.
- Default workspace lists (`getLocalizedDefaults()` in `background.js`, `getDefaultWorkspaces()` in `sidebar.js`) are duplicated by necessity (no shared module across background/sidebar contexts) and must be kept in sync by hand.
- **Firefox `tabs.hide()` caveat:** closing the last *visible* tab in a window while every other tab in it is hidden (a different workspace) can make Firefox treat the window as tab-less and destroy it — or quit the whole browser if it was the last window. There is no cancelable "before tab removed" event. Defense: immediately `tabs.show()` other tabs already in the window (faster than `tabs.create`), then switch into a workspace that owns them. Advise users to enable `Settings → General → Startup → "Open previous windows and tabs"`.
- Auto-backup frequency is stored in **minutes** (`autoBackupFreqIsMinutes: true`). Default is **60 (1 hour)**. Legacy values `1|3|6|8|12|24|72|168` meant hours and are migrated ×60 on load. Invalid/missing values are normalized so the options `<select>` always has a matching option.
- `switchWorkspace(workspaceId, preserveActiveTab, { windowId })` must receive an explicit `windowId` when called from background restore/import — `currentWindow: true` is unreliable there and left all restored tabs visible.
- **i18n rule:** any new user-facing string must be added to **all** `_locales/*/messages.json` files (currently 19 locales), not only `en`/`ru`.
- **Crash Recovery & Orphan Policy:** To guarantee session stability identical to commit `8479da3`, artificial snapshot auto-recovery (`maybeRecoverAfterUnexpectedClose`) is completely removed from startup and tab close events. The extension strictly relies on Firefox native session restoration (`browser.sessions.getTabValue` / `setTabValue`). Furthermore, `switchWorkspace` must NEVER adopt visible unassigned tabs ("orphans") into the destination workspace during switching or leaving All Tabs mode; unmapped tabs are strictly hidden to prevent mass-migration.
- **Sidebar Three-State Toggle (Phase 10):** The sidebar action toggle button (`#toggle-actions-btn`) supports three display states: hiding controls (`hidden`), showing workspace action icons (`actions`), and displaying active tab counts per workspace (`counts`). Icons must conform to `--icon-filter` for light/dark themes, and UI copy must follow anti-slop principles (clean typographic hierarchy without garish badges).
- **Session Restoration & Storage Snapshot Preservation (Phase 11):** When Firefox restarts, restored tabs receive new integer IDs while old IDs remain in `storage.local`. During background initialization, after `rebuildTabWorkspaceMapFromOpenTabs` rebuilds the mapping from native sessions (`browser.sessions`), subsequent storage merges (`applyStorageSnapshot` / `pendingStoragePatches`) MUST pass `{ preserveTabMaps: true }` to prevent stale storage snapshots from overwriting the live tab mappings. Furthermore, startup visibility repair must query all normal windows via `browser.windows.getAll` rather than assuming a single active background window.

## Glossary
- **Workspaces (Пространства)**: Логические группы вкладок, создаваемые пользователем для разделения задач (например, "Главное", "Учеба", "Работа").
- **Auto-Backup (Авто-бэкап)**: Автоматическое резервное копирование состояния пространств и вкладок в `storage.local` с заданной периодичностью.
- **Tab Hiding (Скрытие вкладок)**: Использование API `browser.tabs.hide` / `show` для отображения только вкладок текущего пространства.
- **Host Permissions (Разрешения узлов)**: Разрешения доступа к содержимому веб-сайтов (`<all_urls>`).
- **Pending Assignment (Ожидающее назначение)**: Кратковременный флаг новой вкладки в `pendingTabAssignments`, пока `onCreated` уточняет session/opener — `switchWorkspace` не должен переназначать такие вкладки.
