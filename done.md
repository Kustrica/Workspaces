# Changelog / История изменений

## 🇷🇺 Русский

### Исправлено (Fixed)
- Исправлена ошибка импорта резервных копий (JSON), при которой все восстанавливаемые вкладки ошибочно помещались в одно текущее пространство. Теперь восстановленные вкладки корректно распределяются по своим изначальным пространствам.
- Добавлен флаг `isRestoringData` для временной блокировки события `browser.tabs.onCreated`, которое переопределяло пространства при массовом создании вкладок из бекапа.
- **Исправлен критический баг:** Закрытие браузера при удалении пространства. Теперь расширение безопасно удаляет фоновые вкладки и гарантирует, что активное окно браузера не закроется случайно.
- **Исправлен баг миграции вкладок:** Вкладки больше не перемещаются случайно в `Main` (по умолчанию) при переходе в спящий режим браузером или при использовании контекстного меню. Добавлена поддержка `browser.tabs.onReplaced`.

### Добавлено (Added)
- Добавлено предупреждающее диалоговое окно перед началом импорта.
- Добавлена система локализации предупреждений на 19 языков.
- **Авто-Бэкапы (Auto-Backups):** Добавлена полноценная система автоматического резервного копирования вкладок и пространств.
  - Сохранение бекапов в памяти браузера.
  - Настройки частоты (1, 3, 6, 8, 12 часов, 1 день, 3 дня, 1 неделя).
  - Настройка создания бэкапа при запуске браузера.
  - Красивый интерфейс в настройках (Options) для просмотра истории бэкапов (с локализованным форматом даты) и восстановления в 1 клик.
  - Улучшенное управление бэкапами: отображение размера в КБ, кнопки Восстановить (Restore), Скачать (Download) и Удалить (Delete) для каждого бэкапа отдельно, а также кнопка "Clear All Backups".
  - Возможность ручной настройки лимита сохраняемых бэкапов (от 1 до 10000, встроена защита от ввода большего числа).
  - Добавлена кнопка "Создать бэкап сейчас" (Create Backup Now) для мгновенного ручного сохранения.
  - При нажатии на кнопку Восстановить у бэкапа, автоматически создается бэкап ТЕКУЩЕГО состояния, чтобы ничего не потерялось, после чего открывается удобное окно импорта.
  - Улучшен дизайн кнопки "Очистить все" и добавлено красивое кастомное диалоговое окно (модалка) для подтверждения очистки бэкапов вместо стандартного окна браузера.
  - Полностью переработан дизайн раздела Авто-бэкапов: теперь настройки сгруппированы слева, а справа выведена удобная статистика — видно **текущее количество сохраненных бэкапов (и их лимит)**, а также **общий занимаемый ими объем памяти (в КБ или МБ)**.
  - Перевод всех новых функций авто-бэкапов на 19 языков.
- **Языковой переключатель:** 
  - Добавлен выпадающий список в настройках для ручной смены языка интерфейса.
  - Опция "Auto" теперь динамически показывает, какой язык системы будет использован (например, "Русский (Auto)").
  - Исправлен баг: изменение языка в настройках теперь **мгновенно** синхронизируется и переводит боковую панель (sidebar) без необходимости перезапуска.

---

## 🇬🇧 English

### Fixed
- Fixed a JSON backup import bug where all restored tabs were mistakenly placed into the single current workspace. Now restored tabs are correctly distributed to their original workspaces.
- Added `isRestoringData` flag to temporarily block the `browser.tabs.onCreated` event, which was overriding workspaces during bulk tab creation from backups.
- **Fixed critical bug:** Browser closing when a workspace is deleted. The extension now safely removes background tabs and ensures the active browser window does not close accidentally.
- **Fixed tab migration bug:** Tabs no longer randomly move to `Main` (default) when put to sleep by the browser or when using the context menu. Added support for `browser.tabs.onReplaced`.

### Added
- Added a warning dialog before starting an import.
- Added localization system for warnings across 19 languages.
- **Auto-Backups:** Added a fully-featured automated backup system for tabs and workspaces.
  - Saves backups directly in browser storage.
  - Frequency settings (1, 3, 6, 8, 12 hours, 1 day, 3 days, 1 week).
  - Setting to trigger a backup on browser startup.
  - Beautiful UI in Options to view backup history (with localized date formats) and 1-click restore.
  - Advanced backup management: displays size in KB, Restore, Download, and Delete buttons for each individual backup, and a "Clear All Backups" button.
  - Configurable max limit for saved backups (from 1 up to 10000, with built-in validation preventing higher inputs).
  - Added a "Create Backup Now" button for instant manual backups.
  - Clicking Restore on an auto-backup now automatically creates a fresh backup of the current state before opening the import modal, preventing data loss.
  - Improved UI for the "Clear All Backups" button and replaced the native browser confirm dialog with a beautiful custom modal.
  - Completely redesigned the Auto-Backups section layout: settings are now neatly grouped on the left, and a new statistics panel on the right displays the **current number of backups (out of the maximum limit)** and their **total size in storage (KB or MB)**.
  - Translated all new auto-backup features into 19 languages.
- **Language Switcher:** 
  - Added a dropdown in settings for manual UI language switching. 
  - The "Auto" option now dynamically displays the system language name that will be used (e.g. "English (Auto)").
  - Fixed a bug where changing the language in settings didn't immediately update the sidebar. The language now synchronizes instantly across the extension.