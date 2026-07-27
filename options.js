
// Localize page by replacing text of elements with data-i18n attribute
function localizePage() {
    document.documentElement.dir = getMessage("@@bidi_dir");
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = getMessage(key) || key;
    });

    const titles = document.querySelectorAll('[data-i18n-title]');
    titles.forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = getMessage(key) || key;
    });
}

// Determine string representation of shortcut from keyboard event
function getShortcutFromEvent(e) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Command');

    let key = '';

    if (e.code) {
        if (e.code.startsWith('Key')) {
            key = e.code.replace('Key', '');
        } else if (e.code.startsWith('Digit')) {
            key = e.code.replace('Digit', '');
        } else if (e.code === 'Space') {
            key = 'Space';
        } else if (e.code.startsWith('Arrow')) {
            key = e.code.replace('Arrow', '');
        } else if (['Comma', 'Period', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal', 'Backquote', 'Slash'].includes(e.code)) {
            const codeMap = {
                'Comma': ',', 'Period': '.', 'Semicolon': ';', 'Quote': "'",
                'BracketLeft': '[', 'BracketRight': ']', 'Backslash': '\\',
                'Minus': '-', 'Equal': '=', 'Backquote': '`', 'Slash': '/'
            };
            key = codeMap[e.code] || e.key.toUpperCase();
        } else {
            if (e.code.startsWith('F') && e.code.length <= 3) {
                key = e.code;
            } else {
                key = e.key.toUpperCase();
            }
        }
    } else {
        key = e.key.toUpperCase();
    }

    if (key.length === 1) key = key.toUpperCase();
    parts.push(key);

    return parts.join('+');
}

// Load and display current shortcuts
async function loadShortcuts() {
    const commands = await browser.commands.getAll();

    const sidebarCmd = commands.find(c => c.name === "_execute_sidebar_action");
    if (sidebarCmd) {
        const input = document.getElementById('shortcut-input');
        input.value = sidebarCmd.shortcut || '';
        input.placeholder = sidebarCmd.shortcut ? 'Press keys...' : 'Not set';
    }

    const list = document.getElementById('workspace-shortcuts-list');
    list.innerHTML = '';

    for (let i = 1; i <= 9; i++) {
        const cmdName = `switch_workspace_${i}`;
        const cmd = commands.find(c => c.name === cmdName);

        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '10px';

        const label = document.createElement('span');
        label.style.width = '120px';
        label.style.fontSize = '14px'; 
        label.textContent = `${getMessage("workspaceDefaultName")} ${i}:`;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'shortcut-input';
        input.readOnly = true;
        input.value = cmd ? cmd.shortcut : '';
        input.placeholder = 'Not set';
        input.style.flex = '1';
        input.style.padding = '8px';
        input.style.fontSize = '14px';

        let tempShortcut = null;
        let isRecording = false;

        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const shortcut = getShortcutFromEvent(e);
            if (shortcut) {
                tempShortcut = shortcut;
                input.value = tempShortcut;
                isRecording = true;
            }
        });

        input.addEventListener('keyup', async (e) => {
            if (isRecording && tempShortcut) {
                isRecording = false;
                try {
                    await browser.commands.update({ name: cmdName, shortcut: tempShortcut });
                    showStatus(getMessage("shortcutUpdateSuccess"));
                } catch (err) {
                    showStatus(getMessage("shortcutUpdateError") + " " + err.message, 'error');
                }
            }
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn';
        resetBtn.textContent = getMessage("resetDefault");
        resetBtn.style.padding = '8px 12px';
        resetBtn.style.justifyContent = 'center';
        resetBtn.style.minWidth = '80px';
        resetBtn.onclick = async () => {
            try {
                await browser.commands.reset(cmdName);
                showStatus("Reset successful");
                loadShortcuts();
            } catch (e) {
                showStatus("Error: " + e.message, 'error');
            }
        };

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(resetBtn);
        list.appendChild(row);
    }
}

const shortcutInput = document.getElementById('shortcut-input');
const resetShortcutBtn = document.getElementById('reset-shortcut-btn');
let selectedWorkspaces = new Set();
let areActionsVisible = true;
let currentLang = 'auto';
let isSidebarRecording = false;

shortcutInput.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const shortcut = getShortcutFromEvent(e);
    if (shortcut) {
        recordedShortcut = shortcut;
        shortcutInput.value = recordedShortcut;
        isSidebarRecording = true;
    }
});

shortcutInput.addEventListener('keyup', async (e) => {
    if (isSidebarRecording && recordedShortcut) {
        isSidebarRecording = false;
        try {
            await browser.commands.update({
                name: "_execute_sidebar_action",
                shortcut: recordedShortcut
            });
            showStatus(getMessage("shortcutUpdateSuccess"), 'success');
        } catch (e) {
            showStatus(getMessage("shortcutUpdateError") + " (" + e.message + ")", 'error');
        }
    }
});

resetShortcutBtn.onclick = async () => {
    try {
        await browser.commands.reset("_execute_sidebar_action");
        showStatus("Reset successful");
        loadShortcuts();
    } catch (e) {
        showStatus("Error: " + e.message, 'error');
    }
};

// Export data
document.getElementById('export-btn').onclick = async () => {
    try {
        const { workspaces } = await browser.storage.local.get('workspaces');
        const storageData = await browser.storage.local.get('tabWorkspaceMap');
        const tabWorkspaceMap = storageData.tabWorkspaceMap || {};

        const tabs = await browser.tabs.query({});
        const tabsData = {};

        tabs.forEach(tab => {
            const wsId = tabWorkspaceMap[tab.id] || 'ws_default';
            if (!tabsData[wsId]) tabsData[wsId] = [];
            
            const tabInfo = {
                url: tab.url,
                groupId: tab.groupId !== undefined ? tab.groupId : -1
            };
            tabsData[wsId].push(tabInfo);
        });

        const exportData = {
            timestamp: Date.now(),
            workspaces: workspaces || [],
            tabs: tabsData,
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        const date = new Date();
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.getHours().toString().padStart(2, '0') + '-' + date.getMinutes().toString().padStart(2, '0');
        a.download = `workspaces-backup-${dateStr}-${timeStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showStatus(getMessage("exportSuccess"), 'success');
    } catch (e) {
        const msg = "Export failed: " + e.message;
        showStatus(msg, 'error');
        
        const statusEl = document.getElementById('status-msg');
        if (statusEl) {
             statusEl.style.cursor = 'pointer';
             statusEl.title = "Click to copy error";
             statusEl.onclick = () => {
                 navigator.clipboard.writeText(msg).then(() => {
                     const originalText = statusEl.textContent;
                     statusEl.textContent = "Copied to clipboard!";
                     setTimeout(() => statusEl.textContent = originalText, 1000);
                 });
             };
        }
    }
};

// Import data source selection
document.getElementById('import-btn').onclick = () => {
    const sourceModal = document.getElementById('import-source-modal');
    sourceModal.classList.add('visible');
    
    document.getElementById('import-source-file-btn').onclick = () => {
        sourceModal.classList.remove('visible');
        document.getElementById('import-file').click();
    };
    
    document.getElementById('import-source-memory-btn').onclick = () => {
        sourceModal.classList.remove('visible');
        showAutoBackupsModal();
    };
    
    document.getElementById('import-source-cancel-btn').onclick = () => {
        sourceModal.classList.remove('visible');
    };
    
    sourceModal.onclick = (e) => {
        if (e.target === sourceModal) sourceModal.classList.remove('visible');
    };
};

function handleImportData(data) {
    if (!data.workspaces) throw new Error("Invalid format: missing workspaces");

    showImportModal(async (mode) => {
        await browser.runtime.sendMessage({
            action: 'RESTORE_DATA',
            data: data,
            mode: mode
        });
        showStatus(getMessage("importSuccess"), 'success');
    });
}

document.getElementById('import-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            handleImportData(data);
        } catch (err) {
            showStatus("Import failed: " + err.message, 'error');
        }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset input
};

// Formatting date cleanly
function formatBackupDate(timestamp) {
    const date = new Date(timestamp);
    const langCode = ((currentLang === 'auto' ? navigator.language : currentLang) || 'en').replace('_', '-');
    
    try {
        return new Intl.DateTimeFormat(langCode, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    } catch (e) {
        return new Intl.DateTimeFormat('en', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }
}

async function showAutoBackupsModal() {
    const modal = document.getElementById('auto-backups-modal');
    const list = document.getElementById('auto-backups-modal-list');
    
    const res = await browser.storage.local.get('autoBackups');
    const backups = res.autoBackups || [];
    
    list.innerHTML = '';
    
    if (backups.length === 0) {
        list.innerHTML = `<div style="padding: 20px; text-align: center; color: #888;">No backups found</div>`;
    } else {
        // Reverse array to show newest first
        const sortedBackups = [...backups].reverse();
        
        sortedBackups.forEach((b, index) => {
            const item = document.createElement('div');
            item.style.padding = '10px 15px';
            item.style.borderBottom = '1px solid #333';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.cursor = 'pointer';
            
            const wsCount = b.workspaces ? b.workspaces.length : 0;
            let tabCount = 0;
            if (b.tabs) {
                Object.values(b.tabs).forEach(tabsArr => { tabCount += tabsArr.length; });
            }
            
            const wsLabel = getMessage("wsCount") || "Workspaces";
            const tabLabel = getMessage("tabsCount") || "Tabs";
            
            const title = document.createElement('div');
            const titleStrong = document.createElement('strong');
            titleStrong.textContent = formatBackupDate(b.timestamp);
            title.appendChild(titleStrong);
            title.appendChild(document.createElement('br'));
            const titleSpan = document.createElement('span');
            titleSpan.style.fontSize = '12px';
            titleSpan.style.color = '#888';
            titleSpan.textContent = `${wsLabel}: ${wsCount} | ${tabLabel}: ${tabCount}`;
            title.appendChild(titleSpan);
            
            item.appendChild(title);
            
            const btn = document.createElement('button');
            btn.className = 'btn btn-primary';
            btn.textContent = getMessage("restoreBtn") || "Restore";
            btn.style.padding = '5px 10px';
            btn.onclick = (e) => {
                e.stopPropagation();
                modal.classList.remove('visible');
                handleImportData(b);
            };
            
            item.appendChild(btn);
            list.appendChild(item);
        });
    }
    
    modal.classList.add('visible');
    
    document.getElementById('auto-backups-cancel-btn').onclick = () => {
        modal.classList.remove('visible');
    };
    
    modal.onclick = (e) => {
        if (e.target === modal) modal.classList.remove('visible');
    };
}


// Show import modal window
function showImportModal(onConfirm) {
    const modal = document.getElementById('import-modal');
    const noTabsBtn = document.getElementById('import-no-tabs-btn');
    const mergeBtn = document.getElementById('import-merge-btn');
    const replaceBtn = document.getElementById('import-replace-btn');
    const cancelBtn = document.getElementById('import-cancel-btn');

    modal.classList.add('visible');

    const close = () => {
        modal.classList.remove('visible');
        noTabsBtn.onclick = null;
        mergeBtn.onclick = null;
        replaceBtn.onclick = null;
        cancelBtn.onclick = null;
    };

    const handleConfirm = (mode) => {
        close();
        const warningModal = document.getElementById('import-warning-modal');
        const warningOkBtn = document.getElementById('import-warning-ok-btn');
        const warningCancelBtn = document.getElementById('import-warning-cancel-btn');
        
        warningModal.classList.add('visible');
        
        warningCancelBtn.onclick = () => {
            warningModal.classList.remove('visible');
        };
        
        warningOkBtn.onclick = () => {
            warningModal.classList.remove('visible');
            onConfirm(mode);
        };
        
        warningModal.onclick = (e) => {
            if (e.target === warningModal) warningModal.classList.remove('visible');
        };
    };

    noTabsBtn.onclick = () => {
        handleConfirm('NO_TABS');
    };

    mergeBtn.onclick = () => {
        handleConfirm('MERGE');
    };

    replaceBtn.onclick = () => {
        handleConfirm('REPLACE');
    };

    cancelBtn.onclick = () => {
        close();
    };
    
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };
}

// Show confirmation modal window
function showConfirmModal(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noBtn = document.getElementById('confirm-no-btn');

    titleEl.textContent = title;
    msgEl.textContent = message;
    
    yesBtn.textContent = getMessage("yes") || "Yes";
    noBtn.textContent = getMessage("no") || "No";

    modal.classList.add('visible');

    const close = () => {
        modal.classList.remove('visible');
        yesBtn.onclick = null;
        noBtn.onclick = null;
    };

    yesBtn.onclick = () => {
        close();
        onConfirm();
    };

    noBtn.onclick = () => {
        close();
    };
    
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };
}

// Clear storage
document.getElementById('clear-storage-btn').onclick = () => {
    showConfirmModal(
        getMessage("dangerZone"), 
        getMessage("clearStorageConfirm"), 
        async () => {
            try {
                await browser.runtime.sendMessage({ action: 'RESET_DATA' });
                showStatus(getMessage("clearStorageSuccess"), 'success');
                setTimeout(() => location.reload(), 1500);
            } catch (e) {
                showStatus("Error: " + e.message, 'error');
            }
        }
    );
};

// Display status message
function showStatus(msg, type = 'success') {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = type;
    setTimeout(() => {
        el.className = '';
        el.textContent = '';
    }, 4000);
}

document.addEventListener('DOMContentLoaded', async () => {
    if (window.initI18n) await window.initI18n();
    localizePage();
    loadShortcuts();
    
    // Init Auto Backup Settings and Language
    browser.storage.local.get(['ui_language', 'autoBackupEnabled', 'autoBackupFrequency', 'autoBackupFreqIsMinutes', 'backupOnStartup', 'autoBackups', 'autoBackupMax', 'autoBackupStorageMax']).then(res => {
        const freqSelect = document.getElementById('auto-backup-frequency');
        const startupCheck = document.getElementById('backup-on-startup');
        const maxInput = document.getElementById('auto-backup-max');
        const storageMaxInput = document.getElementById('auto-backup-storage-max');
        const clearBtn = document.getElementById('clear-all-backups-btn');
        let backups = res.autoBackups || [];

        const LEGACY_HOURS = new Set([1, 3, 6, 8, 12, 24, 72, 168]);
        const VALID_MINUTES = new Set([5, 15, 30, 60, 180, 360, 480, 720, 1440, 4320, 10080]);
        const DEFAULT_MINUTES = 60; // 1 hour

        function toMinutes(raw, isMinutes) {
            const n = parseInt(raw, 10);
            if (!n || n <= 0) return 0;
            if (isMinutes) return n;
            if (LEGACY_HOURS.has(n)) return n * 60;
            return n;
        }

        function applyFrequencyToSelect(minutes) {
            const value = String(minutes);
            let idx = Array.from(freqSelect.options).findIndex(o => o.value === value);
            if (idx < 0) {
                idx = Array.from(freqSelect.options).findIndex(o => o.value === String(DEFAULT_MINUTES));
            }
            if (idx < 0) idx = 1; // first non-"Disabled"
            freqSelect.selectedIndex = idx;
            // Also set .value for browsers that prefer it
            freqSelect.value = freqSelect.options[idx].value;
        }
        
        if (res.autoBackupEnabled === false || parseInt(res.autoBackupFrequency, 10) === 0) {
            applyFrequencyToSelect(0);
        } else {
            let minutes = toMinutes(
                (res.autoBackupFrequency === undefined || res.autoBackupFrequency === null || res.autoBackupFrequency === '')
                    ? DEFAULT_MINUTES
                    : res.autoBackupFrequency,
                !!res.autoBackupFreqIsMinutes
            );
            if (!VALID_MINUTES.has(minutes)) {
                minutes = DEFAULT_MINUTES;
            }
            applyFrequencyToSelect(minutes);
            // Normalize storage so alarm + UI stay in sync (fixes blank select / "Disabled" next backup).
            browser.storage.local.set({
                autoBackupEnabled: true,
                autoBackupFrequency: minutes,
                autoBackupFreqIsMinutes: true
            });
        }
        
        startupCheck.checked = res.backupOnStartup !== undefined ? !!res.backupOnStartup : true;
        maxInput.value = (res.autoBackupMax || 1000).toString();
        storageMaxInput.value = (res.autoBackupStorageMax || 200).toString();
        
        freqSelect.addEventListener('change', () => {
            const val = parseInt(freqSelect.value, 10);
            browser.storage.local.set({
                autoBackupEnabled: val !== 0,
                autoBackupFrequency: val,
                autoBackupFreqIsMinutes: true
            });
            
            // Re-render to update the Next Backup stats
            renderBackups(backups);
        });
        
        startupCheck.addEventListener('change', () => {
            browser.storage.local.set({ backupOnStartup: startupCheck.checked });
        });
        
        document.getElementById('auto-backup-max').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            if (val > 10000) e.target.value = 10000;
            if (val < 1) e.target.value = 1;
            
            const statsCountEl = document.getElementById('stats-count');
            if (statsCountEl) {
                statsCountEl.textContent = `${backups.length} / ${e.target.value}`;
            }
        });

        maxInput.addEventListener('change', () => {
            let val = parseInt(maxInput.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 10000) val = 10000;
            maxInput.value = val;
            browser.storage.local.set({ autoBackupMax: val });
        });
        
        storageMaxInput.addEventListener('input', (e) => {
            let val = parseInt(e.target.value);
            if (val > 5000) e.target.value = 5000;
            if (val < 1) e.target.value = 1;
            
            renderBackups(backups);
        });

        storageMaxInput.addEventListener('change', () => {
            let val = parseInt(storageMaxInput.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 5000) val = 5000;
            storageMaxInput.value = val;
            browser.storage.local.set({ autoBackupStorageMax: val });
        });
        
        const createBtn = document.getElementById('create-backup-now-btn');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                browser.storage.local.set({ triggerManualBackup: Date.now() });
                showStatus(getMessage('creatingBackup') || "Creating backup...", 'success');
            });
        }
        
        const clearModal = document.getElementById('clear-backups-modal');
        const clearConfirm = document.getElementById('clear-backups-confirm-btn');
        const clearCancel = document.getElementById('clear-backups-cancel-btn');
        
        clearBtn.addEventListener('click', () => {
            clearModal.classList.add('visible');
        });
        
        clearCancel.addEventListener('click', () => {
            clearModal.classList.remove('visible');
        });
        
        clearConfirm.addEventListener('click', () => {
            browser.storage.local.set({ autoBackups: [] }).then(() => {
                renderBackups([]);
                clearModal.classList.remove('visible');
            });
        });
        
        browser.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.autoBackups) {
                renderBackups(changes.autoBackups.newValue || []);
            }
        });
        // Language Switcher Logic
        const langSelect = document.getElementById('ui-language-select');
        if (res.ui_language) {
            currentLang = res.ui_language;
            langSelect.value = res.ui_language;
        }
        
        langSelect.addEventListener('change', () => {
            const newLang = langSelect.value;
            browser.storage.local.set({ ui_language: newLang }).then(() => {
                showStatus(getMessage('statusSaved') || "Language updated. Reloading...", 'success');
                setTimeout(() => location.reload(), 800);
            });
        });
        
        const list = document.getElementById('auto-backup-list');
        
        function renderBackups(currentBackups) {
            const statsCountEl = document.getElementById('stats-count');
            const statsSizeEl = document.getElementById('stats-size');
            const maxVal = parseInt(document.getElementById('auto-backup-max').value) || 100;
            
            if (statsCountEl) {
                statsCountEl.textContent = `${currentBackups.length} / ${maxVal}`;
            }
            
            const statsOldestEl = document.getElementById('stats-oldest');
            const statsNextEl = document.getElementById('stats-next');
            const freqVal = parseInt(document.getElementById('auto-backup-frequency').value) || 0;
            
            if (statsOldestEl) {
                if (currentBackups.length > 0) {
                    const oldestTime = currentBackups[0].timestamp; // oldest is at index 0 because reverse is done later
                    statsOldestEl.textContent = formatBackupDate(oldestTime);
                } else {
                    statsOldestEl.textContent = getMessage('na') || 'N/A';
                }
            }
            
            if (statsNextEl) {
                if (freqVal === 0) {
                    statsNextEl.textContent = getMessage('disabled') || 'Disabled';
                } else {
                    const updateNextFromAlarm = async () => {
                        try {
                            if (browser.alarms && browser.alarms.get) {
                                const alarm = await browser.alarms.get('autoBackupAlarm');
                                if (alarm && alarm.scheduledTime) {
                                    statsNextEl.textContent = formatBackupDate(alarm.scheduledTime);
                                    return;
                                }
                            }
                        } catch (e) {}
                        if (currentBackups.length > 0) {
                            const newestTime = currentBackups[currentBackups.length - 1].timestamp;
                            // freqVal is minutes
                            const nextTimeMs = newestTime + (freqVal * 60 * 1000);
                            statsNextEl.textContent = formatBackupDate(nextTimeMs);
                        } else {
                            statsNextEl.textContent = getMessage('na') || 'N/A';
                        }
                    };
                    updateNextFromAlarm();
                }
            }
            
            let totalSizeBytes = 0;
            
            if (currentBackups.length === 0) {
                list.innerHTML = '';
                const emptyDiv = document.createElement('div');
                emptyDiv.style.padding = '15px';
                emptyDiv.style.color = '#888';
                emptyDiv.style.fontSize = '14px';
                emptyDiv.setAttribute('data-i18n', 'noBackupsFound');
                emptyDiv.textContent = getMessage('noBackupsFound') || "No backups found";
                list.appendChild(emptyDiv);
                if (statsSizeEl) {
                    const maxStorageMB = parseInt(document.getElementById('auto-backup-storage-max').value) || 200;
                    statsSizeEl.textContent = `0 / ${maxStorageMB} MB`;
                }
            } else {
                list.innerHTML = '';
                // Render all backups in reverse chronological order
                const sortedBackups = [...currentBackups].reverse();
                sortedBackups.forEach((b, idx) => {
                    const item = document.createElement('div');
                    item.style.padding = '10px 15px';
                    item.style.borderBottom = '1px solid #333';
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    item.style.fontSize = '14px';
                    
                    const wsCount = b.workspaces ? b.workspaces.length : 0;
                    let tabCount = 0;
                    if (b.tabs) {
                        Object.values(b.tabs).forEach(tabsArr => { tabCount += tabsArr.length; });
                    }
                    
                    // Calculate size
                    const jsonStr = JSON.stringify(b);
                    const blobSize = new Blob([jsonStr]).size;
                    totalSizeBytes += blobSize;
                    const sizeKB = (blobSize / 1024).toFixed(1);
                    const sizeTxt = `${sizeKB} ${getMessage('backupSizeKB') || 'KB'}`;
                    
                    const wsText = getMessage('wsCount') || 'Workspaces';
                    const tabsText = getMessage('tabsCount') || 'Tabs';
                    
                    const infoDiv = document.createElement('div');
                    const titleStrong = document.createElement('strong');
                    titleStrong.textContent = formatBackupDate(b.timestamp);
                    infoDiv.appendChild(titleStrong);
                    infoDiv.appendChild(document.createElement('br'));
                    const titleSpan = document.createElement('span');
                    titleSpan.style.color = '#888';
                    titleSpan.style.fontSize = '12px';
                    titleSpan.textContent = `${wsText}: ${wsCount} | ${tabsText}: ${tabCount} | ${sizeTxt}`;
                    infoDiv.appendChild(titleSpan);
                    
                    const actionDiv = document.createElement('div');
                    actionDiv.style.display = 'flex';
                    actionDiv.style.gap = '8px';
                    
                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'btn';
                    downloadBtn.style.padding = '4px 8px';
                    downloadBtn.style.fontSize = '12px';
                    downloadBtn.textContent = getMessage('downloadBackup') || 'Download';
                    downloadBtn.onclick = () => {
                        const blob = new Blob([jsonStr], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        const dateStr = new Date(b.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
                        a.download = `workspaces-backup-${dateStr}.json`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                    };
                    
                    const restoreBtn = document.createElement('button');
                    restoreBtn.className = 'btn btn-primary';
                    restoreBtn.style.padding = '4px 8px';
                    restoreBtn.style.fontSize = '12px';
                    restoreBtn.textContent = getMessage('restoreBtn') || 'Restore';
                    restoreBtn.onclick = () => {
                        browser.storage.local.set({ triggerManualBackup: Date.now() });
                        showStatus(getMessage('creatingBackup') || "Creating backup...", 'success');
                        setTimeout(() => handleImportData(b), 300);
                    };
                    
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'btn btn-danger';
                    deleteBtn.style.padding = '4px 8px';
                    deleteBtn.style.fontSize = '12px';
                    deleteBtn.textContent = getMessage('deleteBackup') || 'Delete';
                    deleteBtn.onclick = () => {
                        const realIdx = currentBackups.indexOf(b);
                        if (realIdx > -1) {
                            currentBackups.splice(realIdx, 1);
                            browser.storage.local.set({ autoBackups: currentBackups }).then(() => {
                                renderBackups(currentBackups);
                            });
                        }
                    };
                    
                    actionDiv.appendChild(restoreBtn);
                    actionDiv.appendChild(downloadBtn);
                    actionDiv.appendChild(deleteBtn);
                    
                    item.appendChild(infoDiv);
                    item.appendChild(actionDiv);
                    list.appendChild(item);
                });
                
                if (statsSizeEl) {
                    const maxStorageMB = parseInt(document.getElementById('auto-backup-storage-max').value) || 200;
                    const mbSize = (totalSizeBytes / 1024 / 1024).toFixed(2);
                    statsSizeEl.textContent = `${mbSize} / ${maxStorageMB} MB`;
                }
            }
        }
        
        renderBackups(backups);
    });
});

browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'RESTORE_PROGRESS') {
        const overlay = document.getElementById('restore-progress-overlay');
        const textEl = document.getElementById('restore-progress-text');
        
        if (overlay && textEl) {
            const countText = message.total !== undefined ? ` (${message.restored}/${message.total})` : '';
            if (message.progress < 100) {
                overlay.style.display = 'flex';
                textEl.textContent = `${message.progress}%${countText}`;
            } else {
                textEl.textContent = `100%${countText}`;
                setTimeout(() => {
                    overlay.style.display = 'none';
                }, 500);
            }
        }
    }
});
