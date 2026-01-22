
// State management
let currentWorkspaceId = 'ws_default';
let isAllTabsMode = false;
let tabWorkspaceMap = {}; // tabId -> workspaceId
let workspaceActiveTabMap = {}; // workspaceId -> tabId (last active tab)
let actionLogs = []; // Array of log objects

// Add entry to action log
function addLog(action, details, undoData = null) {
    const log = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        timestamp: Date.now(),
        action: action,
        details: details,
        undoData: undoData
    };
    actionLogs.unshift(log);
    
    if (actionLogs.length > 50) actionLogs.pop();
    browser.storage.local.set({ actionLogs });
}

// Get default workspaces with localized names
const getLocalizedDefaults = () => [
    { id: 'ws_default', name: browser.i18n.getMessage("defaultWsMain") || 'Main', icon: 'img:icons/main-64.png' },
    { id: 'ws_study', name: browser.i18n.getMessage("defaultWsStudy") || 'Study', icon: 'img:icons/study-64.png' },
    { id: 'ws_work', name: browser.i18n.getMessage("defaultWsWork") || 'Work', icon: 'img:icons/work-64.png' },
    { id: 'ws_music', name: browser.i18n.getMessage("defaultWsMusic") || 'Music', icon: 'img:icons/music-64.png' },
    { id: 'ws_cooking', name: browser.i18n.getMessage("defaultWsCooking") || 'Cooking', icon: 'img:icons/cooking-64.png' }
];

let workspaces = [];

// Initialize state on startup
browser.storage.local.get(['currentWorkspaceId', 'tabWorkspaceMap', 'workspaces', 'workspaceActiveTabMap', 'isAllTabsMode', 'actionLogs']).then(res => {
    if (res.currentWorkspaceId) currentWorkspaceId = res.currentWorkspaceId;
    if (res.tabWorkspaceMap) tabWorkspaceMap = res.tabWorkspaceMap;
    if (res.workspaceActiveTabMap) workspaceActiveTabMap = res.workspaceActiveTabMap;
    if (res.isAllTabsMode) isAllTabsMode = res.isAllTabsMode;
    if (res.actionLogs) actionLogs = res.actionLogs;
    
    if (res.workspaces && res.workspaces.length > 0) {
        workspaces = res.workspaces;
    } else {
        workspaces = getLocalizedDefaults();
        browser.storage.local.set({ workspaces });
        
        browser.tabs.query({}).then(tabs => {
             const defaultWsId = workspaces[0].id;
             tabs.forEach(tab => {
                 tabWorkspaceMap[tab.id] = defaultWsId;
             });
             browser.storage.local.set({ tabWorkspaceMap });
        });
    }
    
    updateContextMenus();
});

// Keyboard command handler
browser.commands.onCommand.addListener(async (command) => {
    if (command.startsWith("switch_workspace_")) {
        const index = parseInt(command.replace("switch_workspace_", "")) - 1;
        
        const res = await browser.storage.local.get('workspaces');
        const currentWorkspaces = res.workspaces || getLocalizedDefaults();
        
        if (index >= 0 && index < currentWorkspaces.length) {
            const targetWs = currentWorkspaces[index];
            await switchWorkspace(targetWs.id);
        }
    }
});

// Save current state to local storage
function saveState() {
    browser.storage.local.set({ currentWorkspaceId, tabWorkspaceMap, workspaceActiveTabMap, isAllTabsMode });
}

// Track tab activation to update active tab map
browser.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;
    const wsId = tabWorkspaceMap[tabId] || currentWorkspaceId;
    workspaceActiveTabMap[wsId] = tabId;
    saveState();
});

// Switch active workspace
async function switchWorkspace(workspaceId, preserveActiveTab = false) {
    if (currentWorkspaceId) {
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
            workspaceActiveTabMap[currentWorkspaceId] = currentTab.id;
            if (!tabWorkspaceMap[currentTab.id]) {
                tabWorkspaceMap[currentTab.id] = currentWorkspaceId;
            }
        }
    }
    
    await saveState();

    currentWorkspaceId = workspaceId;
    isAllTabsMode = false;
    await saveState();
    
    const tabs = await browser.tabs.query({ currentWindow: true });
    
    const toShow = [];
    const toHide = [];
    let hasWorkspaceTabs = false;
    
    if (!currentWorkspaceId) {
        if (tabs.length > 0) {
            await browser.tabs.show(tabs.map(t => t.id));
        }
        return;
    }
    
    for (let tab of tabs) {
        let ws = tabWorkspaceMap[tab.id];
        
        if (!ws) {
            ws = currentWorkspaceId || 'ws_default'; 
            if (currentWorkspaceId) {
                tabWorkspaceMap[tab.id] = currentWorkspaceId;
            } else {
                if (workspaces.length > 0) {
                     ws = workspaces[0].id;
                     if (!currentWorkspaceId) currentWorkspaceId = ws;
                     tabWorkspaceMap[tab.id] = ws;
                }
            }
        }

        if (ws === currentWorkspaceId) {
            hasWorkspaceTabs = true;
        }
        
        let keepVisible = false;
        if (tab.groupId !== undefined && tab.groupId !== -1) {
             keepVisible = true;
        }

        if (ws === currentWorkspaceId || keepVisible) {
            toShow.push(tab.id);
        } else {
            toHide.push(tab.id);
        }
    }
    
    if (!hasWorkspaceTabs) {
        const newTab = await browser.tabs.create({ active: true });
        toShow.push(newTab.id);
        tabWorkspaceMap[newTab.id] = currentWorkspaceId;
        workspaceActiveTabMap[currentWorkspaceId] = newTab.id;
    }
    
    saveState();
    
    if (toShow.length > 0) {
        await browser.tabs.show(toShow);
        
        if (!preserveActiveTab) {
            let tabToActivate = workspaceActiveTabMap[workspaceId];
            
            let isValidActiveTab = false;
            if (tabToActivate && toShow.includes(tabToActivate)) {
                 try {
                     await browser.tabs.get(tabToActivate);
                     isValidActiveTab = true;
                 } catch (e) {
                     isValidActiveTab = false;
                 }
            }

            if (!isValidActiveTab) {
                let workspaceTab = null;
                for (let i = toShow.length - 1; i >= 0; i--) {
                    const id = toShow[i];
                    if (tabWorkspaceMap[id] === workspaceId) {
                        workspaceTab = id;
                        break;
                    }
                }
                
                if (workspaceTab) {
                    tabToActivate = workspaceTab;
                } else {
                    tabToActivate = toShow[toShow.length - 1];
                }
            }

            if (tabToActivate) {
                if (toShow.includes(tabToActivate)) {
                    await browser.tabs.update(tabToActivate, { active: true });
                } else if (toShow.length > 0) {
                    await browser.tabs.update(toShow[toShow.length - 1], { active: true });
                }
            }
        }
    }

    if (toHide.length > 0) {
        const activeTab = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.length > 0) {
             const activeId = activeTab[0].id;
             if (toHide.includes(activeId)) {
                 const idx = toHide.indexOf(activeId);
                 if (idx > -1) toHide.splice(idx, 1);
             }
        }
        
        await browser.tabs.hide(toHide);
    }
}

// Move specified tabs to the end of the list
async function moveTabsToEnd(tabIds) {
    if (!tabIds || tabIds.length === 0) return;
    try {
        await browser.tabs.move(tabIds, { index: -1 });
    } catch (e) {
        // Ignore move errors
    }
}

// Update context menu items
async function updateContextMenus() {
    try {
        if (browser.menus && browser.menus.removeAll) {
            await browser.menus.removeAll();
        } else if (browser.contextMenus && browser.contextMenus.removeAll) {
            browser.contextMenus.removeAll(() => {});
        }
    } catch (e) {
        // Menu cleanup error
    }
    
    const menuAPI = browser.menus || browser.contextMenus;
    if (!menuAPI) return;

    const parentId = "move-to-workspace";
    
    menuAPI.create({
        id: parentId,
        title: browser.i18n.getMessage("moveTab"),
        contexts: ["tab"]
    }, () => {
        if (browser.runtime.lastError) return;

        if (!workspaces || workspaces.length === 0) return;

        workspaces.forEach(ws => {
            let displayIcon = ws.icon;
            if (ws.icon && ws.icon.startsWith('img:')) {
                displayIcon = ""; 
            }
            
            const title = displayIcon ? `${displayIcon} ${ws.name}` : ws.name;

            menuAPI.create({
                id: `move-to-${ws.id}`,
                parentId: parentId,
                title: title, 
                contexts: ["tab"]
            }, () => {
                 // Ignore submenu creation errors
            });
        });
    });
}

// Context menu click listener
const menuAPI = browser.menus || browser.contextMenus;
if (menuAPI && menuAPI.onClicked) {
    menuAPI.onClicked.addListener((info, tab) => {
        if (info.menuItemId.startsWith("move-to-")) {
            const targetWsId = info.menuItemId.replace("move-to-", "");
            if (targetWsId !== "workspace") {
                moveTabsToWorkspace(info, tab, targetWsId);
            }
        }
    });
}

// Update context menu title based on selected tab count
function updateMenuTitle(tabCount) {
    const menuAPI = browser.menus || browser.contextMenus;
    if (!menuAPI) return;

    if (tabCount > 1) {
        menuAPI.update("move-to-workspace", {
            title: browser.i18n.getMessage("moveTabs", [tabCount.toString()])
        }, () => browser.runtime.lastError); 
    } else {
        menuAPI.update("move-to-workspace", {
            title: browser.i18n.getMessage("moveTab")
        }, () => browser.runtime.lastError);
    }
}

// Tab selection listener
browser.tabs.onHighlighted.addListener(async (highlightInfo) => {
    updateMenuTitle(highlightInfo.tabIds.length);
});

// Extension installation listener
browser.runtime.onInstalled.addListener(() => {
    updateContextMenus();
});

// Browser startup listener
browser.runtime.onStartup.addListener(() => {
    updateContextMenus();
});

// Move tabs to specified workspace
async function moveTabsToWorkspace(info, tab, targetWsId) {
    const highlightedTabs = await browser.tabs.query({ highlighted: true, currentWindow: true });
    
    let tabsToMove = [];
    const isClickedTabHighlighted = highlightedTabs.some(t => t.id === tab.id);
    
    if (isClickedTabHighlighted && highlightedTabs.length > 1) {
        tabsToMove = highlightedTabs;
    } else {
        tabsToMove = [tab];
    }

    for (let t of tabsToMove) {
        tabWorkspaceMap[t.id] = targetWsId;
    }
    saveState();
    
    await moveTabsToEnd(tabsToMove.map(t => t.id));

    if (targetWsId !== currentWorkspaceId) {
        await switchWorkspace(currentWorkspaceId);
    }
}

// New tab creation listener
browser.tabs.onCreated.addListener((tab) => {
    tabWorkspaceMap[tab.id] = currentWorkspaceId;
    workspaceActiveTabMap[currentWorkspaceId] = tab.id;
    saveState();
});

// Tab removal listener
browser.tabs.onRemoved.addListener((tabId) => {
    delete tabWorkspaceMap[tabId];
    saveState();
});

// Storage change listener
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.workspaces) {
        workspaces = changes.workspaces.newValue || [];
        updateContextMenus();
    }
});

// Message handler
browser.runtime.onMessage.addListener(async (message) => {
    if (message.action === 'SWITCH_WORKSPACE') {
        await switchWorkspace(message.workspaceId);
    } else if (message.action === 'GET_CURRENT_WORKSPACE') {
        return { currentWorkspaceId };
    } else if (message.action === 'GET_WORKSPACE_URLS') {
        const { wsId } = message;
        const urls = [];
        
        const allTabs = await browser.tabs.query({});
        for (let tab of allTabs) {
            if (tabWorkspaceMap[tab.id] === wsId) {
                urls.push(tab.url);
            }
        }
        return { urls };
    } else if (message.action === 'RESTORE_DATA') {
        const { workspaces: newWorkspaces, tabs: tabsData } = message.data;
        const mode = message.mode || 'REPLACE';

        const safetyTab = await browser.tabs.create({ url: 'about:blank', active: true });
        
        await new Promise(r => setTimeout(r, 500));

        let oldTabIds = [];
        if (mode === 'REPLACE') {
            const winTabs = await browser.tabs.query({ currentWindow: true });
            oldTabIds = winTabs.map(t => t.id).filter(id => id !== safetyTab.id);
            
            tabWorkspaceMap = {};
            workspaceActiveTabMap = {};
        } else {
            oldTabIds = Object.keys(tabWorkspaceMap).map(id => parseInt(id));
            
            const newDefaultId = newWorkspaces.length > 0 ? newWorkspaces[0].id : 'ws_default';
            for (let id of oldTabIds) {
                tabWorkspaceMap[id] = newDefaultId;
            }
            workspaceActiveTabMap = {};
        }
        
        workspaces = newWorkspaces;
        
        if (mode !== 'NO_TABS') {
            for (const ws of workspaces) {
                const tabsList = tabsData[ws.id];
                if (tabsList && Array.isArray(tabsList)) {
                    const groupMap = {}; 

                    for (const tabInfo of tabsList) {
                        try {
                            const url = typeof tabInfo === 'string' ? tabInfo : tabInfo.url;
                            const oldGroupId = typeof tabInfo === 'object' ? tabInfo.groupId : -1;

                            const newTab = await browser.tabs.create({ 
                                url: url, 
                                active: false 
                            });
                            tabWorkspaceMap[newTab.id] = ws.id;

                            if (oldGroupId !== -1 && oldGroupId !== undefined && browser.tabs.group) {
                                let newGroupId = groupMap[oldGroupId];
                                if (!newGroupId) {
                                    newGroupId = await browser.tabs.group({ tabIds: newTab.id });
                                    groupMap[oldGroupId] = newGroupId;
                                } else {
                                    await browser.tabs.group({ tabIds: newTab.id, groupId: newGroupId });
                                }
                            }

                        } catch (e) {
                            // Restore error
                        }
                    }
                }
            }
        }
        
        if (mode === 'REPLACE' && oldTabIds.length > 0) {
             try {
                 await browser.tabs.remove(oldTabIds);
             } catch (e) { }
        }
        
        if (workspaces.length > 0) {
            currentWorkspaceId = workspaces[0].id;
        } else {
            workspaces = getLocalizedDefaults();
            currentWorkspaceId = 'ws_default';
        }
        
        await saveState();
        await browser.storage.local.set({ workspaces }); 
        updateContextMenus();
        await switchWorkspace(currentWorkspaceId);
        
        await new Promise(r => setTimeout(r, 500));

        try {
            await browser.tabs.remove(safetyTab.id);
        } catch (e) { }
        
        return { success: true };
    } else if (message.action === 'MOVE_ALL_TABS') {
        const { fromWsId, toWsId } = message;
        
        const allTabIds = Object.keys(tabWorkspaceMap);
        let movedCount = 0;
        const movedTabIds = [];
        
        const isEmptyTab = async (tabId) => {
            try {
                const tab = await browser.tabs.get(parseInt(tabId));
                const url = tab.url || "";
                return !url || 
                       url === 'about:newtab' || 
                       url === 'about:home' || 
                       url === 'about:blank' || 
                       url === 'chrome://newtab/' || 
                       url === 'edge://newtab/' || 
                       url === 'chrome://startpage/' || 
                       url === 'opera://startpage/'; 
            } catch (e) {
                return false;
            }
        };

        const tabsToClose = [];

        for (let id of allTabIds) {
            if (tabWorkspaceMap[id] === fromWsId) {
                if (await isEmptyTab(id)) {
                    tabsToClose.push(parseInt(id));
                } else {
                    tabWorkspaceMap[id] = toWsId;
                    movedTabIds.push(id);
                    movedCount++;
                }
            }
        }
        
        if (tabsToClose.length > 0) {
            await browser.tabs.remove(tabsToClose);
        }
        
        if (movedCount > 0) {
            saveState();
            await switchWorkspace(currentWorkspaceId);
            
            const fromWs = workspaces.find(w => w.id === fromWsId);
            const toWs = workspaces.find(w => w.id === toWsId);
            const fromName = fromWs ? fromWs.name : 'Unknown';
            const toName = toWs ? toWs.name : 'Unknown';
            
            addLog('MOVE_TABS', `i18n:logDetailsMoved:${movedCount}:${fromName}:${toName}`, {
                type: 'MOVE_TABS',
                data: { tabIds: movedTabIds, fromWsId: fromWsId, toWsId: toWsId }
            });
        }
        return { movedCount };
        
    } else if (message.action === 'DELETE_WORKSPACE_TABS') {
        const { wsId } = message;
        const allTabIds = Object.keys(tabWorkspaceMap);
        const tabsToRemove = [];
        
        for (let id of allTabIds) {
            if (tabWorkspaceMap[id] === wsId) {
                tabsToRemove.push(parseInt(id));
            }
        }
        
        if (tabsToRemove.length > 0) {
            await browser.tabs.remove(tabsToRemove);
        }
    } else if (message.action === 'UNMAP_WORKSPACE_TABS') {
        const { wsId } = message;
        const allTabIds = Object.keys(tabWorkspaceMap);
        
        for (let id of allTabIds) {
            if (tabWorkspaceMap[id] === wsId) {
                delete tabWorkspaceMap[id];
            }
        }
        saveState();
        return { success: true };
    } else if (message.action === 'RESET_DATA') {
        const allTabs = await browser.tabs.query({});
        
        const isEmptyTab = (tab) => {
             const url = tab.url || "";
             return !url || 
                    url === 'about:newtab' || 
                    url === 'about:home' || 
                    url === 'about:blank' || 
                    url === 'chrome://newtab/' || 
                    url === 'edge://newtab/' || 
                    url === 'chrome://startpage/' || 
                    url === 'opera://startpage/'; 
        };

        const tabsToShow = [];
        const tabsToClose = [];

        for (let tab of allTabs) {
            if (isEmptyTab(tab)) {
                tabsToClose.push(tab.id);
            } else {
                tabsToShow.push(tab.id);
            }
        }

        if (tabsToShow.length > 0) {
            await browser.tabs.show(tabsToShow);
        }
        
        if (tabsToClose.length > 0) {
            await browser.tabs.remove(tabsToClose);
        }
        
        tabWorkspaceMap = {};
        workspaces = getLocalizedDefaults();
        currentWorkspaceId = 'ws_default';
        workspaceActiveTabMap = {};
        
        await browser.storage.local.clear();
        
        updateContextMenus();
        
        await browser.storage.local.set({ 
            workspaces: workspaces,
            currentWorkspaceId: 'ws_default'
        });
        
        return { success: true };
    } else if (message.action === 'DELETE_ALL_WORKSPACES') {
        const undoState = {
            workspaces: JSON.parse(JSON.stringify(workspaces)),
            tabWorkspaceMap: { ...tabWorkspaceMap },
            workspaceActiveTabMap: { ...workspaceActiveTabMap },
            currentWorkspaceId: currentWorkspaceId
        };

        const allTabs = await browser.tabs.query({});
        
        const isEmptyTab = (tab) => {
             const url = tab.url || "";
             return !url || 
                    url === 'about:newtab' || 
                    url === 'about:home' || 
                    url === 'about:blank' || 
                    url === 'chrome://newtab/' || 
                    url === 'edge://newtab/' || 
                    url === 'chrome://startpage/' || 
                    url === 'opera://startpage/'; 
        };

        const tabsToShow = [];
        const tabsToClose = [];

        for (let tab of allTabs) {
            if (isEmptyTab(tab)) {
                tabsToClose.push(tab.id);
            } else {
                tabsToShow.push(tab.id);
            }
        }

        if (tabsToShow.length > 0) {
            await browser.tabs.show(tabsToShow);
        }
        
        if (tabsToClose.length > 0) {
            await browser.tabs.remove(tabsToClose);
        }
        
        tabWorkspaceMap = {};
        workspaces = []; 
        currentWorkspaceId = null; 
        workspaceActiveTabMap = {};
        isAllTabsMode = true; 
        
        await browser.storage.local.set({ 
            workspaces: [],
            currentWorkspaceId: null,
            tabWorkspaceMap: {},
            workspaceActiveTabMap: {},
            isAllTabsMode: true
        });
        
        updateContextMenus();

        addLog('RESET_WORKSPACES', 'i18n:logDetailsReset', {
            type: 'RESET_WORKSPACES',
            data: undoState
        });
        
        return { success: true };
    } else if (message.action === 'SHOW_ALL_TABS') {
        const allTabs = await browser.tabs.query({ currentWindow: true });
        const tabsToShow = [];
        let hasShownNewTab = false;
        
        const isNewTab = (tab) => {
             const url = tab.url || "";
             if (url === "about:newtab" || url === "about:home" || url === "about:blank") return true;
             if (url.startsWith("moz-extension://") && url.endsWith("/options.html")) return false; 
             return false;
        };
        
        for (let tab of allTabs) {
            const looksLikeNewTab = isNewTab(tab) || 
                                    (tab.title === "New Tab" && tab.url === "about:newtab") ||
                                    (tab.title === "Новая вкладка" && tab.url === "about:newtab");

            if (looksLikeNewTab) {
                if (!hasShownNewTab) {
                    tabsToShow.push(tab.id);
                    hasShownNewTab = true;
                }
            } else {
                tabsToShow.push(tab.id);
            }
        }
        
        if (tabsToShow.length > 0) {
            await browser.tabs.show(tabsToShow);
        }
        
        return { success: true, shownCount: tabsToShow.length };
    } else if (message.action === 'GET_LOGS') {
        return { logs: actionLogs };
    } else if (message.action === 'CLEAR_LOGS') {
        actionLogs = [];
        await browser.storage.local.set({ actionLogs });
        return { success: true };
    } else if (message.action === 'UNDO_ACTION') {
        const { logId } = message;
        const logIndex = actionLogs.findIndex(l => l.id === logId);
        if (logIndex === -1) return { success: false, error: "Log not found" };
        
        const log = actionLogs[logIndex];
        if (!log.undoData) return { success: false, error: "Not undoable" };
        
        const isRedo = log.isUndone;
        const { type, data } = log.undoData;
        
        if (isRedo) {
            if (type === 'DELETE_WORKSPACE') {
                workspaces = workspaces.filter(w => w.id !== data.workspace.id);
                await browser.storage.local.set({ workspaces });
                if (currentWorkspaceId === data.workspace.id) {
                    await switchWorkspace('ws_default');
                }
            } else if (type === 'CREATE_WORKSPACE') {
                workspaces.push({ id: data.id, name: data.name, icon: '📁' });
                await browser.storage.local.set({ workspaces });
            } else if (type === 'RENAME_WORKSPACE') {
                const ws = workspaces.find(w => w.id === data.id);
                if (ws) {
                    ws.name = data.newName;
                    await browser.storage.local.set({ workspaces });
                }
            } else if (type === 'MOVE_TABS') {
                const { tabIds, toWsId } = data;
                for (let id of tabIds) {
                    tabWorkspaceMap[id] = toWsId;
                }
                saveState();
                await switchWorkspace(currentWorkspaceId);
            } else if (type === 'RESET_WORKSPACES') {
                tabWorkspaceMap = {};
                workspaces = [];
                currentWorkspaceId = null;
                workspaceActiveTabMap = {};
                isAllTabsMode = true;
                
                await browser.storage.local.set({ 
                    workspaces: [],
                    currentWorkspaceId: null,
                    tabWorkspaceMap: {},
                    workspaceActiveTabMap: {},
                    isAllTabsMode: true
                });
                updateContextMenus();
                
                const allTabs = await browser.tabs.query({});
                if (allTabs.length > 0) {
                    await browser.tabs.show(allTabs.map(t => t.id));
                }
            }
            
            log.isUndone = false;
        } else {
            if (type === 'DELETE_WORKSPACE') {
                workspaces.push(data.workspace);
                await browser.storage.local.set({ workspaces });
                
                if (data.tabs && data.tabs.length > 0) {
                    for (const url of data.tabs) {
                        try {
                            const newTab = await browser.tabs.create({ url: url, active: false });
                            tabWorkspaceMap[newTab.id] = data.workspace.id;
                            if (currentWorkspaceId && currentWorkspaceId !== data.workspace.id) {
                                await browser.tabs.hide(newTab.id);
                            }
                        } catch (e) { }
                    }
                    saveState();
                }
            } else if (type === 'CREATE_WORKSPACE') {
                workspaces = workspaces.filter(w => w.id !== data.id);
                await browser.storage.local.set({ workspaces });
                if (currentWorkspaceId === data.id) {
                    await switchWorkspace('ws_default');
                }
            } else if (type === 'RENAME_WORKSPACE') {
                const ws = workspaces.find(w => w.id === data.id);
                if (ws) {
                    ws.name = data.oldName;
                    await browser.storage.local.set({ workspaces });
                }
            } else if (type === 'MOVE_TABS') {
                const { tabIds, fromWsId } = data;
                for (let id of tabIds) {
                    tabWorkspaceMap[id] = fromWsId;
                }
                saveState();
                await switchWorkspace(currentWorkspaceId);
            } else if (type === 'RESET_WORKSPACES') {
                workspaces = data.workspaces;
                tabWorkspaceMap = data.tabWorkspaceMap;
                workspaceActiveTabMap = data.workspaceActiveTabMap;
                currentWorkspaceId = data.currentWorkspaceId;
                isAllTabsMode = false;
                
                await browser.storage.local.set({ 
                    workspaces,
                    tabWorkspaceMap,
                    workspaceActiveTabMap,
                    currentWorkspaceId,
                    isAllTabsMode: false
                });
                updateContextMenus();
                
                if (currentWorkspaceId) {
                    await switchWorkspace(currentWorkspaceId);
                }
            }
            
            log.isUndone = true;
        }
        
        await browser.storage.local.set({ actionLogs });
        return { success: true, isRedo: isRedo };
        
    } else if (message.action === 'LOG_ACTION') {
        addLog(message.logAction, message.details, message.undoData);
        return { success: true };
    }
});

// Safety: Show all tabs when extension is suspended/disabled
browser.runtime.onSuspend.addListener(() => {
    browser.tabs.query({}).then(tabs => {
        const ids = tabs.map(t => t.id);
        if (ids.length > 0) {
            browser.tabs.show(ids);
        }
    });
});
