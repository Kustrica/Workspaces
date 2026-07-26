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
- **Background wake**: `onCreated` waits for `initReadyPromise` so cold starts do not assign tabs while `currentWorkspaceId` is still the default Main.
- **Auto-backup alarms**: `autoBackupAlarm` is created/refreshed on script load, `onInstalled`, `onStartup`, and when backup settings change. Startup backups still use `onStartup` → `createAutoBackup('startup')` independently of the periodic alarm.

## Constraints & Rules
- Firefox & Chromium compatibility (Manifest V3).
- Strict adherence to non-persistent background script lifecycle (event page / service worker). Global handlers must not trigger side-effects like background task executions on simple script load.
- Avoid unnecessary permissions (e.g. `<all_urls>` host permissions) to preserve privacy and prevent security warnings.
- Permission `"alarms"` is required for scheduled auto-backups; without it `browser.alarms` is unavailable and only startup backups work.
- `switchWorkspace` must not claim unmapped tabs into the previous workspace (causes tabs to migrate into Main during races with `onCreated`).
- Hide order when switching: show target tabs → activate a tab that belongs to the target workspace → then hide others.

## Glossary
- **Workspaces (Пространства)**: Логические группы вкладок, создаваемые пользователем для разделения задач (например, "Главное", "Учеба", "Работа").
- **Auto-Backup (Авто-бэкап)**: Автоматическое резервное копирование состояния пространств и вкладок в `storage.local` с заданной периодичностью.
- **Tab Hiding (Скрытие вкладок)**: Использование API `browser.tabs.hide` / `show` для отображения только вкладок текущего пространства.
- **Host Permissions (Разрешения узлов)**: Разрешения доступа к содержимому веб-сайтов (`<all_urls>`).
- **Pending Assignment (Ожидающее назначение)**: Кратковременный флаг новой вкладки в `pendingTabAssignments`, пока `onCreated` уточняет session/opener — `switchWorkspace` не должен переназначать такие вкладки.
