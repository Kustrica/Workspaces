
// Default workspaces
const DEFAULT_WORKSPACES = [
    { id: 'ws_default', name: browser.i18n.getMessage("defaultWsMain") || 'Main', icon: 'img:icons/main-64.png' },
    { id: 'ws_study', name: browser.i18n.getMessage("defaultWsStudy") || 'Study', icon: 'img:icons/study-64.png' },
    { id: 'ws_work', name: browser.i18n.getMessage("defaultWsWork") || 'Work', icon: 'img:icons/work-64.png' },
    { id: 'ws_music', name: browser.i18n.getMessage("defaultWsMusic") || 'Music', icon: 'img:icons/music-64.png' },
    { id: 'ws_cooking', name: browser.i18n.getMessage("defaultWsCooking") || 'Cooking', icon: 'img:icons/cooking-64.png' }
];

let workspaces = [];
let activeWsId = 'ws_default';
let areActionsVisible = true;
let areLogsVisible = false;
let currentTheme = 'dark';

const listEl = document.getElementById('workspace-list');
const logsListEl = document.getElementById('logs-list');
const addBtn = document.getElementById('add-workspace');
const addForm = document.getElementById('add-form');
const newNameInput = document.getElementById('new-ws-name');
const newIconInput = document.getElementById('new-ws-icon');
const saveNewBtn = document.getElementById('save-new-ws');
const toggleEmojiBtn = document.getElementById('toggle-emoji');
const emojiGrid = document.getElementById('emoji-grid');
const customIconSection = document.getElementById('custom-icon-section');
const customIconsList = document.getElementById('custom-icons-list');
const toggleActionsBtn = document.getElementById('toggle-actions-btn');
const logsBtn = document.getElementById('logs-btn');
const themeBtn = document.getElementById('theme-btn');

const CUSTOM_ICONS = [];

const EMOJIS = [
    "📁", "🏠", "💼", "📅", "📊", "📈", "📉", "📝", "📌", "📎", "🗂️", "🗳️", "🏢", "🏭", "🏦",
    "💻", "🖥️", "⌨️", "🖱️", "💾", "💿", "📱", "⚙️", "🔧", "🔨", "🔋", "🔌", "📡", "🚀", "🤖",
    "🎮", "🎬", "🎵", "🎧", "📷", "📹", "📺", "📻", "🎨", "🎭", "🎪", "🎫", "🎲", "🎯", "🎳",
    "💬", "💭", "📧", "📫", "📞", "📱", "📢", "🔔", "❤️", "👍", "🤝", "👥", "🗣️", "🌐", "🌍",
    "🛒", "🛍️", "💳", "💵", "💰", "🏷️", "📦", "🎁", "💎", "💍", "⌚", "👓", "👞", "👗", "🎩",
    "✈️", "🚗", "🚲", "🚂", "⚓", "🗺️", "🏖️", "🏔️", "🏕️", "🏨", "🗽", "🗼", "🏰", "🏟️", "🏞️",
    "🍔", "🍕", "🍟", "🌭", "🍿", "🍩", "🍪", "🍫", "🍬", "☕", "🍵", "🍺", "🍷", "🍹", "🥂",
    "📚", "📖", "🎓", "🏫", "✏️", "✒️", "🔬", "🔭", "🧠", "💡", "🖍️", "🎒", "🧐", "🤔", "📜",
    "🔥", "⭐", "⚡", "✨", "🌈", "☀️", "🌙", "☁️", "❄️", "🍀", "⚠️", "⛔", "✅", "❌", "❓"
];

// Initialize emoji and icon picker grid
function initEmojiPicker() {
    emojiGrid.innerHTML = '';
    EMOJIS.forEach(emoji => {
        const div = document.createElement('div');
        div.className = 'emoji-option';
        div.textContent = emoji;
        div.onclick = () => {
            newIconInput.value = emoji;
            emojiGrid.classList.remove('visible');
            customIconSection.style.display = 'none'; 
        };
        emojiGrid.appendChild(div);
    });

    if (CUSTOM_ICONS.length > 0) {
        customIconsList.innerHTML = '';
        CUSTOM_ICONS.forEach(iconFile => {
            const img = document.createElement('img');
            img.src = `icons/${iconFile}`;
            img.className = 'custom-icon-option';
            img.title = iconFile;
            img.onerror = () => { img.style.display = 'none'; };
            img.onclick = () => {
                newIconInput.value = `img:icons/${iconFile}`;
                emojiGrid.classList.remove('visible');
                customIconSection.style.display = 'none';
            };
            customIconsList.appendChild(img);
        });
    }
}

// Generate unique name for new workspace
function generateWorkspaceName() {
    const baseName = browser.i18n.getMessage("workspaceDefaultName") || "Workspace";
    let counter = 1;
    let name = `${baseName} ${counter}`;
    while (workspaces.some(w => w.name === name)) {
        counter++;
        name = `${baseName} ${counter}`;
    }
    return name;
}

toggleEmojiBtn.onclick = () => {
    emojiGrid.classList.toggle('visible');
    if (emojiGrid.classList.contains('visible')) {
        customIconSection.style.display = 'block';
    } else {
        customIconSection.style.display = 'none';
    }
};

addBtn.onclick = () => {
    addForm.classList.toggle('visible');
    if (addForm.classList.contains('visible')) {
        addBtn.style.display = 'none';
        newNameInput.value = generateWorkspaceName();
        newNameInput.focus();
        newNameInput.select();
    } else {
        addBtn.style.display = 'block';
    }
};

if (toggleActionsBtn) {
    toggleActionsBtn.onclick = () => {
        areActionsVisible = !areActionsVisible;
        updateActionsVisibility();
        browser.storage.local.set({ areActionsVisible });
    };
}

if (logsBtn) {
    logsBtn.onclick = () => {
        areLogsVisible = !areLogsVisible;
        const emptyStateContainer = document.getElementById('empty-state-container');
        
        if (areLogsVisible) {
            listEl.style.display = 'none';
            if (emptyStateContainer) {
                emptyStateContainer.style.display = 'none';
            }
            if (allTabsSection) {
                allTabsSection.style.display = 'none';
            }
            logsListEl.style.display = 'flex';
            addBtn.style.display = 'none';
            renderLogs();
        } else {
            logsListEl.style.display = 'none';
            addBtn.style.display = 'block';
            
            if (workspaces.length === 0) {
                listEl.style.display = 'none';
                if (emptyStateContainer) {
                    emptyStateContainer.style.display = 'flex';
                }
                if (allTabsSection) {
                    allTabsSection.style.display = 'none';
                }
            } else {
                listEl.style.display = 'flex';
                listEl.style.flexDirection = 'column';
                if (allTabsSection) {
                    allTabsSection.style.display = 'block';
                }
            }
        }
    };
}

if (themeBtn) {
    themeBtn.onclick = () => {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme();
        browser.storage.local.set({ theme: currentTheme });
    };
}

// Update visibility of action buttons in workspace list
function updateActionsVisibility() {
    if (areActionsVisible) {
        listEl.classList.add('show-actions');
        const eyeOpenUrl = browser.runtime.getURL('icons/eye-open-64.png');
        toggleActionsBtn.querySelector('img').src = eyeOpenUrl;
        toggleActionsBtn.style.opacity = '1';
        toggleActionsBtn.title = browser.i18n.getMessage("hideActions") || "Hide Actions";
    } else {
        listEl.classList.remove('show-actions');
        const eyeClosedUrl = browser.runtime.getURL('icons/eye-closed-64.png');
        toggleActionsBtn.querySelector('img').src = eyeClosedUrl;
        toggleActionsBtn.style.opacity = '0.7'; 
        toggleActionsBtn.title = browser.i18n.getMessage("showActions") || "Show Actions";
    }
}

// Apply current theme (light/dark)
function applyTheme() {
    const themeIcon = themeBtn.querySelector('img');
    if (currentTheme === 'light') {
        document.body.classList.add('light-theme');
        themeBtn.title = browser.i18n.getMessage("switchToDarkTheme") || "Switch to Dark Theme";
        themeIcon.src = browser.runtime.getURL('icons/light-64.png');
    } else {
        document.body.classList.remove('light-theme');
        themeBtn.title = browser.i18n.getMessage("switchToLightTheme") || "Switch to Light Theme";
        themeIcon.src = browser.runtime.getURL('icons/dark-64.png');
    }
}

const modalOverlay = document.getElementById('move-modal');
const modalList = document.getElementById('move-target-list');
const modalClose = document.getElementById('modal-close');

const allTabsItem = document.getElementById('all-tabs-item');
const allTabsSection = document.getElementById('all-tabs-section');
let isAllTabsMode = false;

window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('visible');
        if (e.target.id === 'delete-modal') {
             workspaceToDeleteId = null;
        }
    }
    if (!addForm.contains(e.target) && e.target !== addBtn) {
        if (addForm.classList.contains('visible')) {
            addForm.classList.remove('visible');
            addBtn.style.display = 'block';
        }
    }
};

const deleteModalOverlay = document.getElementById('delete-modal');
const deleteMessage = document.getElementById('delete-message');
const deleteCancelBtn = document.getElementById('delete-cancel');
const deleteConfirmBtn = document.getElementById('delete-confirm');
const showMoveOptionsBtn = document.getElementById('show-move-options-btn');
const confirmMoveDeleteBtn = document.getElementById('confirm-move-delete-btn');
const cancelMoveDeleteBtn = document.getElementById('cancel-move-delete-btn');
const deleteMoveTargetSelect = document.getElementById('delete-move-target');
const moveTargetContainer = document.getElementById('move-target-container');
const initialDeleteButtons = document.getElementById('initial-delete-buttons');
let workspaceToDeleteId = null;

// Localize page by replacing text of elements with data-i18n attribute
function localizePage() {
    document.documentElement.dir = browser.i18n.getMessage("@@bidi_dir");
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = browser.i18n.getMessage(key);
    });

    const placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    placeholders.forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = browser.i18n.getMessage(key);
    });
    
    const titles = document.querySelectorAll('[data-i18n-title]');
    titles.forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = browser.i18n.getMessage(key);
    });
    
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while(node = walker.nextNode()) {
        const val = node.nodeValue;
        if (val && val.includes('__MSG_')) {
            node.nodeValue = val.replace(/__MSG_(\w+)__/g, (m, key) => browser.i18n.getMessage(key));
        }
    }
}

// Initialize app, load settings and data
async function init() {
    localizePage();
    initEmojiPicker();
    
    const res = await browser.storage.local.get(['workspaces', 'currentWorkspaceId', 'areActionsVisible', 'theme', 'isAllTabsMode', 'tourComplete', 'onboardingComplete']);
    workspaces = res.workspaces || DEFAULT_WORKSPACES;
    activeWsId = res.currentWorkspaceId || 'ws_default';
    
    if (!res.onboardingComplete) {
        const onboardingContainer = document.getElementById('onboarding-container');
        if (onboardingContainer) {
            onboardingContainer.style.display = 'block';
            
            const skipBtn = document.getElementById('onboarding-skip-btn');
            const exportBtn = document.getElementById('onboarding-export-btn');
            
            if (skipBtn) {
                skipBtn.onclick = async () => {
                    await browser.storage.local.set({ onboardingComplete: true });
                    onboardingContainer.style.display = 'none';
                };
            }
            
            if (exportBtn) {
                exportBtn.onclick = async () => {
                    await performExport();
                    await browser.storage.local.set({ onboardingComplete: true });
                    onboardingContainer.style.display = 'none';
                };
            }
        }
    }

    if (!res.tourComplete) {
        initTour();
    }

    areActionsVisible = res.areActionsVisible !== undefined ? res.areActionsVisible : true;
    
    isAllTabsMode = res.isAllTabsMode || false;
    
    if (res.theme) {
        currentTheme = res.theme;
    } else {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            currentTheme = 'light';
        } else {
            currentTheme = 'dark';
        }
        browser.storage.local.set({ theme: currentTheme });
    }
    
    applyTheme();
    updateActionsVisibility();
    render();
}

// Start feature tour
function initTour() {
    const overlay = document.getElementById('tour-overlay');
    const titleEl = document.getElementById('tour-title');
    const textEl = document.getElementById('tour-text');
    const imgEl = document.getElementById('tour-image');
    const dotsEl = document.getElementById('tour-dots');
    const nextBtn = document.getElementById('tour-next-btn');
    const skipBtn = document.getElementById('tour-skip-btn');
    
    if (!overlay) return;
    
    let currentStep = 0;
    const steps = [
        {
            title: browser.i18n.getMessage("tourStep1Title"),
            text: browser.i18n.getMessage("tourStep1Text"),
            icon: 'icons/main-64.png'
        },
        {
            title: browser.i18n.getMessage("tourStep2Title"),
            text: browser.i18n.getMessage("tourStep2Text"),
            icon: 'icons/work-64.png'
        },
        {
            title: browser.i18n.getMessage("tourStep3Title"),
            text: browser.i18n.getMessage("tourStep3Text"),
            icon: 'icons/settings-64.png'
        }
    ];
    
    const showStep = (index) => {
        const step = steps[index];
        titleEl.textContent = step.title;
        textEl.textContent = step.text;
        imgEl.src = step.icon;
        
        dotsEl.innerHTML = '';
        steps.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.className = 'tour-dot' + (i === index ? ' active' : '');
            dot.onclick = () => {
                currentStep = i;
                showStep(currentStep);
            };
            dotsEl.appendChild(dot);
        });
        
        if (index === steps.length - 1) {
            nextBtn.textContent = browser.i18n.getMessage("tourFinish");
            skipBtn.style.display = 'none';
        } else {
            nextBtn.textContent = browser.i18n.getMessage("tourNext");
            skipBtn.style.display = 'block';
        }
    };
    
    const closeTour = async () => {
        overlay.classList.remove('visible');
        await browser.storage.local.set({ tourComplete: true });
    };
    
    nextBtn.onclick = () => {
        if (currentStep < steps.length - 1) {
            currentStep++;
            showStep(currentStep);
        } else {
            closeTour();
        }
    };
    
    skipBtn.onclick = () => {
        closeTour();
    };
    
    showStep(0);
    overlay.classList.add('visible');
}

// Perform data export (similar to options.js)
async function performExport() {
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
            tabs: tabsData
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

        showToast(browser.i18n.getMessage("exportSuccess"));
    } catch (e) {
        showToast("Export failed: " + e.message);
    }
}

const resetBtn = document.getElementById('reset-btn');
const resetModal = document.getElementById('reset-modal');
const resetConfirmBtn = document.getElementById('reset-confirm-btn');
const resetCancelBtn = document.getElementById('reset-cancel-btn');

if (resetBtn) {
    resetBtn.onclick = () => {
        resetModal.classList.add('visible');
    };
}

if (resetCancelBtn) {
    resetCancelBtn.onclick = () => {
        resetModal.classList.remove('visible');
    };
}

if (resetConfirmBtn) {
    resetConfirmBtn.onclick = async () => {
        await browser.runtime.sendMessage({ action: 'DELETE_ALL_WORKSPACES' });
        workspaces = [];
        activeWsId = null;
        resetModal.classList.remove('visible');
        render();
    };
}

const createDefaultsBtn = document.getElementById('create-defaults-btn');
if (createDefaultsBtn) {
    createDefaultsBtn.onclick = async () => {
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
        const initialActiveTabId = currentTab ? currentTab.id : null;

        workspaces = DEFAULT_WORKSPACES;
        activeWsId = 'ws_default';
        
        await browser.storage.local.set({ workspaces, currentWorkspaceId: activeWsId });
        
        if (initialActiveTabId) {
             const tabWorkspaceMap = {};
             tabWorkspaceMap[initialActiveTabId] = activeWsId;
             const workspaceActiveTabMap = {};
             workspaceActiveTabMap[activeWsId] = initialActiveTabId;
             
             await browser.storage.local.set({ tabWorkspaceMap, workspaceActiveTabMap });
        }
        
        await browser.runtime.sendMessage({ action: 'SWITCH_WORKSPACE', workspaceId: activeWsId, preserveActiveTab: true });
        render();
    };
}

// Render main workspace list interface
function render() {
    listEl.innerHTML = '';
    
    const emptyStateContainer = document.getElementById('empty-state-container');
    
    if (!areLogsVisible) {
        if (workspaces.length === 0) {
            if (emptyStateContainer) {
                emptyStateContainer.style.display = 'flex';
                emptyStateContainer.style.flex = '1';
                listEl.style.display = 'none';
            }
            
            if (allTabsSection) {
                allTabsSection.style.display = 'none';
            }
        } else {
            if (emptyStateContainer) {
                emptyStateContainer.style.display = 'none';
                listEl.style.display = 'block';
            }
            
            if (allTabsSection) {
                allTabsSection.style.display = 'block';
            }
        }
    } else {
        if (emptyStateContainer) emptyStateContainer.style.display = 'none';
        listEl.style.display = 'none';
        if (allTabsSection) allTabsSection.style.display = 'none';
    }

    if (addBtn) {
        addBtn.style.display = areLogsVisible ? 'none' : 'block';
    }
    
    if (allTabsItem) {
        if (isAllTabsMode) {
            allTabsItem.classList.add('active');
        } else {
            allTabsItem.classList.remove('active');
        }
    }
    
    workspaces.forEach((ws, index) => {
        const item = document.createElement('div');
        item.className = 'workspace-item';
        item.draggable = true;
        item.dataset.id = ws.id;
        item.dataset.index = index;
        
        if (ws.id === activeWsId) item.classList.add('active');
        
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('dragleave', handleDragLeave);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);
        
        const content = document.createElement('div');
        content.style.display = 'flex';
        content.style.alignItems = 'center';
        content.style.flex = '1';
        content.style.pointerEvents = 'none'; 
        
        let iconHtml = ws.icon;
        if (ws.icon && ws.icon.startsWith('img:')) {
            const src = ws.icon.substring(4);
            iconHtml = `<img src="${src}" style="width: 20px; height: 20px; object-fit: contain;">`;
        }
        
        content.innerHTML = `
            <div class="ws-icon">${iconHtml}</div>
            <div class="ws-name">${ws.name}</div>
        `;
        
        const actions = document.createElement('div');
        actions.className = 'ws-actions';
        
        const renameBtn = document.createElement('button');
        renameBtn.className = 'ws-action-btn';
        const renameIconUrl = browser.runtime.getURL('icons/pen-64.png');
        renameBtn.innerHTML = `<img src="${renameIconUrl}" alt="Rename" style="width: 16px; height: 16px;">`;
        renameBtn.title = browser.i18n.getMessage("renameWs") || "Rename";
        renameBtn.onclick = (e) => {
            e.stopPropagation();
            startInlineRename(ws.id);
        };
        renameBtn.querySelector('img').onerror = function() { this.replaceWith('✏️'); };

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ws-action-btn';
        const copyIconUrl = browser.runtime.getURL('icons/copy-64.png');
        copyBtn.innerHTML = `<img src="${copyIconUrl}" alt="Copy" style="width: 16px; height: 16px;">`; 
        copyBtn.title = browser.i18n.getMessage("copyUrls");
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            copyWorkspaceUrls(ws.id);
        };
        copyBtn.querySelector('img').onerror = function() { this.replaceWith('📋'); };

        const moveBtn = document.createElement('button');
        moveBtn.className = 'ws-action-btn';
        const moveIconUrl = browser.runtime.getURL('icons/arrow-64.png');
        moveBtn.innerHTML = `<img src="${moveIconUrl}" alt="Move" style="width: 16px; height: 16px;">`;
        moveBtn.title = browser.i18n.getMessage("moveAll");
        moveBtn.onclick = (e) => {
            e.stopPropagation();
            showMoveMenu(ws.id);
        };
        moveBtn.querySelector('img').onerror = function() { this.replaceWith('➡'); };
        
        const delBtn = document.createElement('button');
        delBtn.className = 'ws-action-btn';
        const deleteIconUrl = browser.runtime.getURL('icons/trash-64.png');
        delBtn.innerHTML = `<img src="${deleteIconUrl}" alt="Delete" style="width: 16px; height: 16px;">`;
        delBtn.title = browser.i18n.getMessage("deleteWs");
        delBtn.onclick = async (e) => {
            e.stopPropagation();
            
            if (workspaces.length === 1) {
                await deleteWorkspace(ws.id);
                return;
            }

            const isEmpty = await checkWorkspaceEmpty(ws.id);
            if (isEmpty) {
                await deleteWorkspace(ws.id);
            } else {
                showDeleteModal(ws);
            }
        };
        delBtn.querySelector('img').onerror = function() { this.replaceWith('🗑'); };
        
        actions.appendChild(renameBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(moveBtn);
        if (workspaces.length > 0) {
            actions.appendChild(delBtn);
        }
        
        item.appendChild(content);
        item.appendChild(actions);
        
        item.onclick = (e) => {
             activateWorkspace(ws.id);
        };
        
        listEl.appendChild(item);
    });
}

// Start inline workspace renaming mode
function startInlineRename(wsId) {
    const wsItem = document.querySelector(`.workspace-item[data-id="${wsId}"]`);
    if (!wsItem) return;

    const nameEl = wsItem.querySelector('.ws-name');
    if (!nameEl) return;

    wsItem.setAttribute('draggable', 'false');
    
    const currentName = nameEl.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'inline-rename-input'; 

    input.onclick = (e) => e.stopPropagation();
    input.onmousedown = (e) => e.stopPropagation();

    nameEl.innerHTML = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    
    let isSaving = false;

    const save = async () => {
        if (isSaving) return;
        isSaving = true;
        
        const newName = input.value.trim();
        if (newName && newName !== "" && newName !== currentName) {
            const ws = workspaces.find(w => w.id === wsId);
            if (ws) {
                await browser.runtime.sendMessage({
                    action: 'LOG_ACTION',
                    logAction: 'RENAME_WORKSPACE',
                    details: `i18n:logDetailsRenamed:${currentName}:${newName}`,
                    undoData: {
                        type: 'RENAME_WORKSPACE',
                        data: { id: wsId, oldName: currentName, newName: newName }
                    }
                });

                ws.name = newName;
                await browser.storage.local.set({ workspaces });
            }
        } else {
            render();
        }
    };

    input.onblur = () => {
        save();
    };

    input.onkeydown = (e) => {
        if (e.key === 'Enter') {
            input.blur(); 
        } else if (e.key === 'Escape') {
            render();
        }
    };
}

let dragSrcEl = null;

function handleDragStart(e) {
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.id); 
    
    setTimeout(() => this.classList.add('dragging'), 0);
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.classList.add('drag-over');
    return false;
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    
    this.classList.remove('drag-over');
    
    if (dragSrcEl !== this) {
        const srcIdx = parseInt(dragSrcEl.dataset.index);
        const destIdx = parseInt(this.dataset.index);
        
        const item = workspaces.splice(srcIdx, 1)[0];
        workspaces.splice(destIdx, 0, item);
        
        browser.storage.local.set({ workspaces });
        render();
    }
    return false;
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.workspace-item').forEach(item => {
        item.classList.remove('drag-over');
        item.classList.remove('dragging');
    });
}

// Copy URLs of all tabs in specified workspace to clipboard
async function copyWorkspaceUrls(wsId) {
    const res = await browser.runtime.sendMessage({ action: 'GET_WORKSPACE_URLS', wsId });
    if (res && res.urls) {
        const text = res.urls.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            showToast(browser.i18n.getMessage("copied"));
        });
    }
}

// Check if workspace is empty
async function checkWorkspaceEmpty(wsId) {
    const res = await browser.runtime.sendMessage({ action: 'GET_WORKSPACE_URLS', wsId });
    if (!res || !res.urls || res.urls.length === 0) return true;
    
    const isEffectivelyEmpty = res.urls.every(url => {
        return !url || 
               url === 'about:newtab' || 
               url === 'about:home' || 
               url === 'about:blank' || 
               url === 'chrome://newtab/' || 
               url === 'edge://newtab/' || 
               url === 'chrome://startpage/' || 
               url === 'opera://startpage/'; 
    });
    
    return isEffectivelyEmpty;
}

// Show menu to move tabs to another workspace
function showMoveMenu(fromWsId) {
    const targets = workspaces.filter(w => w.id !== fromWsId);
    if (targets.length === 0) {
        showToast(browser.i18n.getMessage("noOtherWorkspaces"));
        return;
    }
    
    modalList.innerHTML = '';
    targets.forEach(t => {
        const li = document.createElement('li');
        li.className = 'modal-item';
        
        let iconHtml = t.icon;
        if (t.icon && t.icon.startsWith('img:')) {
            const src = t.icon.substring(4);
            iconHtml = `<img src="${src}" class="move-menu-icon">`;
        }
        
        li.innerHTML = `<span style="display:inline-flex; align-items:center; gap:8px;">${iconHtml} ${t.name}</span>`;
        li.onclick = () => {
            browser.runtime.sendMessage({ 
                action: 'MOVE_ALL_TABS', 
                fromWsId: fromWsId, 
                toWsId: t.id 
            }).then(async res => {
                showToast(browser.i18n.getMessage("movedTabs", [res.movedCount.toString(), t.name]));
                
                modalOverlay.classList.remove('visible');
            });
        };
        modalList.appendChild(li);
    });
    
    modalOverlay.classList.add('visible');
}

// Show toast notification
function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.style.position = 'fixed';
        toast.style.bottom = '140px'; 
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = 'var(--toast-bg)'; 
        toast.style.color = 'var(--toast-text)';
        toast.style.padding = '12px 24px'; 
        toast.style.borderRadius = '12px'; 
        toast.style.minWidth = '200px'; 
        toast.style.textAlign = 'center';
        toast.style.boxShadow = '0 4px 12px var(--toast-shadow)';
        toast.style.border = '1px solid var(--border-color)';
        toast.style.zIndex = '200';
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s, transform 0.3s'; 
        toast.style.pointerEvents = 'none'; 
        document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.pointerEvents = 'auto'; 
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(10px)';
        toast.style.pointerEvents = 'none'; 
        
        setTimeout(() => {
            if (toast && toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300); 
    }, 2000);
}

modalClose.onclick = () => {
    modalOverlay.classList.remove('visible');
};

document.getElementById('settings-btn').onclick = () => {
    browser.runtime.openOptionsPage();
};

if (allTabsItem) {
    allTabsItem.onclick = () => {
        if (isAllTabsMode) {
            activateWorkspace(lastActiveWsId);
        } else {
            activateAllTabs();
        }
    };
}

// Activate specified workspace
async function activateWorkspace(id) {
    if (!workspaces.some(w => w.id === id)) {
        id = workspaces.length > 0 ? workspaces[0].id : 'ws_default';
    }

    activeWsId = id;
    lastActiveWsId = id;
    isAllTabsMode = false;
    await browser.storage.local.set({ isAllTabsMode: false, currentWorkspaceId: id, lastActiveWsId: id });
    render(); 
    await browser.runtime.sendMessage({ action: 'SWITCH_WORKSPACE', workspaceId: id });
}

// Activate "All Tabs" mode
async function activateAllTabs() {
    if (activeWsId) {
        lastActiveWsId = activeWsId;
    }
    isAllTabsMode = true;
    activeWsId = null;
    await browser.storage.local.set({ isAllTabsMode: true, currentWorkspaceId: null, lastActiveWsId: lastActiveWsId });
    render();
    await browser.runtime.sendMessage({ action: 'SHOW_ALL_TABS' });
}

// Show workspace deletion modal
function showDeleteModal(ws) {
    workspaceToDeleteId = ws.id;
    const wsName = ws.name || "Workspace";
    
    moveTargetContainer.style.display = 'none';
    initialDeleteButtons.style.display = 'flex';
    
    const targets = workspaces.filter(w => w.id !== ws.id);
    
    if (targets.length > 0) {
        deleteMoveTargetSelect.innerHTML = '';
        targets.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            deleteMoveTargetSelect.appendChild(opt);
        });
        
        deleteMessage.textContent = browser.i18n.getMessage("manageWsDesc", [wsName]);
        showMoveOptionsBtn.style.display = 'block';
    } else {
        deleteMessage.textContent = browser.i18n.getMessage("manageWsDesc", [wsName]);
        showMoveOptionsBtn.style.display = 'none';
    }
    
    deleteModalOverlay.classList.add('visible');
}

document.getElementById('close-tabs-only-btn').onclick = async () => {
    if (workspaceToDeleteId) {
        await browser.runtime.sendMessage({ action: 'DELETE_WORKSPACE_TABS', wsId: workspaceToDeleteId });
        
        const ws = workspaces.find(w => w.id === workspaceToDeleteId);
        const wsName = ws ? ws.name : "Unknown";
        
        await browser.runtime.sendMessage({
            action: 'LOG_ACTION',
            logAction: 'MOVE_TABS', 
            details: `i18n:logDetailsMoved:All:${wsName}:Closed`,
            undoData: null 
        });

        showToast(browser.i18n.getMessage("tabsClosed"));
        
        deleteModalOverlay.classList.remove('visible');
        workspaceToDeleteId = null;
    }
};

deleteCancelBtn.onclick = () => {
    deleteModalOverlay.classList.remove('visible');
    workspaceToDeleteId = null;
};

showMoveOptionsBtn.onclick = () => {
    initialDeleteButtons.style.display = 'none';
    moveTargetContainer.style.display = 'block';
};

cancelMoveDeleteBtn.onclick = () => {
    deleteModalOverlay.classList.remove('visible');
    workspaceToDeleteId = null;
};

deleteConfirmBtn.onclick = () => {
    if (workspaceToDeleteId) {
        deleteWorkspace(workspaceToDeleteId);
        deleteModalOverlay.classList.remove('visible');
        workspaceToDeleteId = null;
    }
};

confirmMoveDeleteBtn.onclick = async () => {
    if (workspaceToDeleteId && deleteMoveTargetSelect.value) {
        const targetId = deleteMoveTargetSelect.value;
        const targetWs = workspaces.find(w => w.id === targetId);
        
        const res = await browser.runtime.sendMessage({ 
            action: 'MOVE_ALL_TABS', 
            fromWsId: workspaceToDeleteId, 
            toWsId: targetId 
        });
        
        await deleteWorkspace(workspaceToDeleteId);
        
        showToast(browser.i18n.getMessage("movedTabs", [res.movedCount.toString(), targetWs ? targetWs.name : ""]));
        
        deleteModalOverlay.classList.remove('visible');
        workspaceToDeleteId = null;
    }
};

// Delete workspace
async function deleteWorkspace(id) {
    const ws = workspaces.find(w => w.id === id);
    if (ws) {
        const urlRes = await browser.runtime.sendMessage({ action: 'GET_WORKSPACE_URLS', wsId: id });
        const tabsToRestore = urlRes ? urlRes.urls : [];

        await browser.runtime.sendMessage({
            action: 'LOG_ACTION',
            logAction: 'DELETE_WORKSPACE',
            details: `i18n:logDetailsDeleted:${ws.name}`,
            undoData: {
                type: 'DELETE_WORKSPACE',
                data: { 
                    workspace: ws,
                    tabs: tabsToRestore 
                }
            }
        });
    }

    if (workspaces.length === 1 && workspaces[0].id === id) {
        await browser.runtime.sendMessage({ action: 'UNMAP_WORKSPACE_TABS', wsId: id });
        await browser.runtime.sendMessage({ action: 'SHOW_ALL_TABS' });
    } else {
        await browser.runtime.sendMessage({ action: 'DELETE_WORKSPACE_TABS', wsId: id });
    }
    
    workspaces = workspaces.filter(w => w.id !== id);
    await browser.storage.local.set({ workspaces });
    
    if (workspaces.length === 0) {
        activeWsId = null;
        await browser.storage.local.set({ currentWorkspaceId: null });
        render();
    } else if (activeWsId === id) {
        activateWorkspace(workspaces[0].id);
    } else {
        render();
    }
}

saveNewBtn.onclick = async () => {
    const name = newNameInput.value;
    if (!name) return;
    
    const icon = newIconInput.value || '📁';
    
    const newWs = {
        id: 'ws_' + Date.now(),
        name: name,
        icon: icon
    };
    
    workspaces.push(newWs);
    await browser.storage.local.set({ workspaces });
    
    await browser.runtime.sendMessage({
        action: 'LOG_ACTION',
        logAction: 'CREATE_WORKSPACE',
        details: `i18n:logDetailsCreated:${name}`,
        undoData: {
            type: 'CREATE_WORKSPACE',
            data: { id: newWs.id, name: name }
        }
    });
    
    newNameInput.value = '';
    addForm.classList.remove('visible');
    addBtn.style.display = 'block'; 
    
    if (workspaces.length === 1) {
        await activateWorkspace(newWs.id);
    } else {
        render();
    }
};

const clearLogsModal = document.getElementById('clear-logs-modal');
const clearLogsConfirmBtn = document.getElementById('clear-logs-confirm-btn');
const clearLogsCancelBtn = document.getElementById('clear-logs-cancel-btn');

if (clearLogsCancelBtn) {
    clearLogsCancelBtn.onclick = () => {
        if (clearLogsModal) clearLogsModal.classList.remove('visible');
    };
}

if (clearLogsConfirmBtn) {
    clearLogsConfirmBtn.onclick = async () => {
        await browser.runtime.sendMessage({ action: 'CLEAR_LOGS' });
        await renderLogs();
        if (clearLogsModal) clearLogsModal.classList.remove('visible');
    };
}

// Render action log
async function renderLogs() {
    if (!logsListEl) return;
    logsListEl.innerHTML = '';
    
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '10px';
    
    const title = document.createElement('strong');
    title.textContent = browser.i18n.getMessage("logsTitle");
    header.appendChild(title);

    const clearBtn = document.createElement('button');
    clearBtn.id = 'clear-logs-btn';
    clearBtn.style.width = 'auto'; 
    clearBtn.style.margin = '0';
    clearBtn.innerHTML = `<img src="icons/trash-64.png" style="width: 16px; height: 16px;">`;
    clearBtn.title = browser.i18n.getMessage("clearLogs");
    clearBtn.onclick = (e) => {
        e.stopPropagation();
        if (clearLogsModal) clearLogsModal.classList.add('visible');
    };
    header.appendChild(clearBtn);
    logsListEl.appendChild(header);

    const res = await browser.runtime.sendMessage({ action: 'GET_LOGS' });
    if (res && res.logs) {
        
        if (res.logs.length === 0) {
            const empty = document.createElement('div');
            empty.style.textAlign = 'center';
            empty.style.color = 'var(--text-dim)';
            empty.style.marginTop = '20px';
            empty.textContent = browser.i18n.getMessage("noLogs");
            logsListEl.appendChild(empty);
            return;
        }

        res.logs.forEach(log => {
            const item = document.createElement('div');
            item.className = 'log-item';
            if (log.isUndone) item.classList.add('undone');
            
            const date = new Date(log.timestamp);
            const timeStr = date.toLocaleString([], { 
                year: 'numeric', 
                month: 'numeric', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            
            let actionTitle = log.action;
            if (log.action === 'CREATE_WORKSPACE') actionTitle = browser.i18n.getMessage("logCreated");
            if (log.action === 'DELETE_WORKSPACE') actionTitle = browser.i18n.getMessage("logDeleted");
            if (log.action === 'RENAME_WORKSPACE') actionTitle = browser.i18n.getMessage("logRenamed");
            if (log.action === 'MOVE_TABS') actionTitle = browser.i18n.getMessage("logMoved");
            if (log.action === 'RESET_WORKSPACES') actionTitle = browser.i18n.getMessage("resetWorkspaces") || "Reset";
            
            if (!actionTitle) actionTitle = log.action;

            let detailsText = log.details;
            if (detailsText && detailsText.startsWith('i18n:')) {
                const parts = detailsText.split(':');
                const key = parts[1];
                const params = parts.slice(2);
                detailsText = browser.i18n.getMessage(key, params) || detailsText;
            }
            
            if (log.action === 'RESET_WORKSPACES') {
                 detailsText = ''; 
            }

            if (log.isUndone) {
                 actionTitle = `↩ ${actionTitle}`;
            }

            let iconHtml = ''; 
            let wsIdToFind = null;
            let wsObj = null;

            if (log.undoData && log.undoData.data) {
                if (log.undoData.type === 'CREATE_WORKSPACE') wsIdToFind = log.undoData.data.id;
                else if (log.undoData.type === 'DELETE_WORKSPACE') wsObj = log.undoData.data.workspace;
                else if (log.undoData.type === 'RENAME_WORKSPACE') wsIdToFind = log.undoData.data.id;
                else if (log.undoData.type === 'MOVE_TABS') wsIdToFind = log.undoData.data.toWsId;
            }

            if (!wsObj && wsIdToFind) {
                wsObj = workspaces.find(w => w.id === wsIdToFind);
            }

            if (wsObj && wsObj.icon) {
                if (wsObj.icon.startsWith('img:')) {
                    const src = wsObj.icon.substring(4);
                    iconHtml = `<img src="${src}" style="width: 20px; height: 20px; object-fit: contain;">`;
                } else {
                    iconHtml = wsObj.icon;
                }
            } 

            item.innerHTML = `
                <div class="log-time">${timeStr}</div>
                <div class="log-row">
                     <div class="log-icon">${iconHtml}</div>
                     <div class="log-action"><strong>${actionTitle}</strong>${detailsText ? ': ' + detailsText : ''}</div>
                </div>
            `;
            
            item.onclick = (e) => {
                e.stopPropagation();
                
                document.querySelectorAll('.log-undo-overlay').forEach(el => el.remove());
                
                const overlay = document.createElement('div');
                overlay.className = 'log-undo-overlay';
                
                const msg = document.createElement('span');
                msg.textContent = log.isUndone ? browser.i18n.getMessage("redoAction") : browser.i18n.getMessage("undoAction");
                msg.style.fontSize = '12px';
                
                const btnGroup = document.createElement('div');
                btnGroup.style.display = 'flex';
                btnGroup.style.gap = '5px';
                
                const confirmBtn = document.createElement('button');
                confirmBtn.className = 'log-undo-btn confirm';
                confirmBtn.textContent = browser.i18n.getMessage("yes");
                confirmBtn.onclick = async (ev) => {
                    ev.stopPropagation();
                    const undoRes = await browser.runtime.sendMessage({ action: 'UNDO_ACTION', logId: log.id });
                        if (undoRes.success) {
                            showToast(undoRes.isRedo ? browser.i18n.getMessage("actionRedone") : browser.i18n.getMessage("actionUndone"));
                            await renderLogs(); 
                            const state = await browser.storage.local.get('workspaces');
                            workspaces = state.workspaces || [];
                            render(); 
                        } else {
                            showToast(browser.i18n.getMessage("undoFailed"));
                        }
                };
                
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'log-undo-btn';
                cancelBtn.textContent = browser.i18n.getMessage("no");
                cancelBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    overlay.remove();
                };
                
                btnGroup.appendChild(confirmBtn);
                btnGroup.appendChild(cancelBtn);
                
                overlay.appendChild(msg);
                overlay.appendChild(btnGroup);
                
                item.appendChild(overlay);
            };
            
            logsListEl.appendChild(item);
        });
    }
}

init();

browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        // Reload if onboarding or tour flags are reset (removed or set to false)
        if ((changes.onboardingComplete && !changes.onboardingComplete.newValue) || 
            (changes.tourComplete && !changes.tourComplete.newValue)) {
            window.location.reload();
            return;
        }

        if (changes.workspaces) {
            workspaces = changes.workspaces.newValue || [];
            render();
        }
        if (changes.currentWorkspaceId) {
            activeWsId = changes.currentWorkspaceId.newValue;
            render();
        }
    }
});
