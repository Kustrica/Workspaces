
// Localize page by replacing text of elements with data-i18n attribute
function localizePage() {
    document.documentElement.dir = browser.i18n.getMessage("@@bidi_dir");
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = browser.i18n.getMessage(key) || key;
    });

    const titles = document.querySelectorAll('[data-i18n-title]');
    titles.forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = browser.i18n.getMessage(key) || key;
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
        label.textContent = `${browser.i18n.getMessage("workspaceDefaultName")} ${i}:`;

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
                    showStatus(browser.i18n.getMessage("shortcutUpdateSuccess"));
                } catch (err) {
                    showStatus(browser.i18n.getMessage("shortcutUpdateError") + " " + err.message, 'error');
                }
            }
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn';
        resetBtn.textContent = browser.i18n.getMessage("resetDefault");
        resetBtn.style.padding = '8px 12px';
        resetBtn.style.width = '80px';
        resetBtn.style.justifyContent = 'center';
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
let recordedShortcut = null;
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
            showStatus(browser.i18n.getMessage("shortcutUpdateSuccess"), 'success');
        } catch (e) {
            showStatus(browser.i18n.getMessage("shortcutUpdateError") + " (" + e.message + ")", 'error');
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

        showStatus(browser.i18n.getMessage("exportSuccess"), 'success');
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

// Import data
document.getElementById('import-btn').onclick = () => {
    document.getElementById('import-file').click();
};

document.getElementById('import-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!data.workspaces) throw new Error("Invalid format: missing workspaces");

            showImportModal(async (mode) => {
                await browser.runtime.sendMessage({
                    action: 'RESTORE_DATA',
                    data: data,
                    mode: mode
                });

                showStatus(browser.i18n.getMessage("importSuccess"), 'success');
            });
        } catch (err) {
            showStatus("Import failed: " + err.message, 'error');
        }
    };
    reader.readAsText(file);
};

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

    noTabsBtn.onclick = () => {
        close();
        onConfirm('NO_TABS');
    };

    mergeBtn.onclick = () => {
        close();
        onConfirm('MERGE');
    };

    replaceBtn.onclick = () => {
        close();
        onConfirm('REPLACE');
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
    
    yesBtn.textContent = browser.i18n.getMessage("yes") || "Yes";
    noBtn.textContent = browser.i18n.getMessage("no") || "No";

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
        browser.i18n.getMessage("dangerZone"), 
        browser.i18n.getMessage("clearStorageConfirm"), 
        async () => {
            try {
                await browser.runtime.sendMessage({ action: 'RESET_DATA' });
                showStatus(browser.i18n.getMessage("clearStorageSuccess"), 'success');
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

document.addEventListener('DOMContentLoaded', () => {
    localizePage();
    loadShortcuts();
});
