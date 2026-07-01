
// State management
let currentWorkspaceId = 'ws_default';
let isAllTabsMode = false;
let tabWorkspaceMap = {};
let workspaceActiveTabMap = {};
let actionLogs = [];
const TAB_WORKSPACE_SESSION_KEY = 'workspaceId';
let isInitializingState = true;
let isRestoringData = false;

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
    { id: 'ws_default', name: getMessage("defaultWsMain") || 'Main', icon: 'img:icons/main-64.png' },
    { id: 'ws_study', name: getMessage("defaultWsStudy") || 'Study', icon: 'img:icons/study-64.png' },
    { id: 'ws_work', name: getMessage("defaultWsWork") || 'Work', icon: 'img:icons/work-64.png' },
    { id: 'ws_music', name: getMessage("defaultWsMusic") || 'Music', icon: 'img:icons/music-64.png' },
    { id: 'ws_cooking', name: getMessage("defaultWsCooking") || 'Cooking', icon: 'img:icons/cooking-64.png' }
];

let workspaces = [];

function workspaceExists(workspaceId) {
    if (!workspaceId) return false;
    return workspaces.some(ws => ws.id === workspaceId);
}

function normalizeWorkspaceId(workspaceId) {
    if (!workspaceId) return null;
    if (workspaceExists(workspaceId)) return workspaceId;
    if (workspaces.length > 0) return workspaces[0].id;
    return 'ws_default';
}

async function setSessionWorkspace(tabId, workspaceId) {
    if (!browser.sessions || !browser.sessions.setTabValue || !workspaceId) return;
    try {
        await browser.sessions.setTabValue(tabId, TAB_WORKSPACE_SESSION_KEY, workspaceId);
    } catch (e) {
    }
}

async function getSessionWorkspace(tabId) {
    if (!browser.sessions || !browser.sessions.getTabValue) return null;
    try {
        const value = await browser.sessions.getTabValue(tabId, TAB_WORKSPACE_SESSION_KEY);
        return typeof value === 'string' ? value : null;
    } catch (e) {
        return null;
    }
}

async function clearSessionWorkspace(tabId) {
    if (!browser.sessions || !browser.sessions.removeTabValue) return;
    try {
        await browser.sessions.removeTabValue(tabId, TAB_WORKSPACE_SESSION_KEY);
    } catch (e) {
    }
}

async function clearSessionWorkspaceForTabs(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return;
    await Promise.all(tabIds.map(tabId => clearSessionWorkspace(tabId)));
}

function assignTabToWorkspace(tabId, workspaceId) {
    if (!tabId || !workspaceId) return;
    tabWorkspaceMap[tabId] = workspaceId;
    setSessionWorkspace(tabId, workspaceId);
}

function unassignTab(tabId) {
    if (!tabId) return;
    delete tabWorkspaceMap[tabId];
    clearSessionWorkspace(tabId);
}

async function enforceNoCloseOnLastTabSetting() {
    if (!browser.browserSettings || !browser.browserSettings.closeWindowWithLastTab || !browser.browserSettings.closeWindowWithLastTab.set) return;
    try {
        await browser.browserSettings.closeWindowWithLastTab.set({ value: false });
    } catch (e) {
    }
}

async function clearNoCloseOnLastTabSetting() {
    if (!browser.browserSettings || !browser.browserSettings.closeWindowWithLastTab || !browser.browserSettings.closeWindowWithLastTab.clear) return;
    try {
        await browser.browserSettings.closeWindowWithLastTab.clear({});
    } catch (e) {
    }
}

async function rebuildTabWorkspaceMapFromOpenTabs() {
    const tabs = await browser.tabs.query({});
    const rebuiltMap = {};

    for (const tab of tabs) {
        const sessionWorkspaceId = normalizeWorkspaceId(await getSessionWorkspace(tab.id));
        if (sessionWorkspaceId) {
            rebuiltMap[tab.id] = sessionWorkspaceId;
            setSessionWorkspace(tab.id, sessionWorkspaceId);
            continue;
        }

        const legacyWorkspaceId = normalizeWorkspaceId(tabWorkspaceMap[tab.id]);
        if (legacyWorkspaceId) {
            rebuiltMap[tab.id] = legacyWorkspaceId;
            setSessionWorkspace(tab.id, legacyWorkspaceId);
            continue;
        }

        const fallbackWorkspaceId = workspaces.length > 0 ? workspaces[0].id : 'ws_default';
        if (fallbackWorkspaceId) {
            rebuiltMap[tab.id] = fallbackWorkspaceId;
            setSessionWorkspace(tab.id, fallbackWorkspaceId);
        }
    }

    tabWorkspaceMap = rebuiltMap;
}

// Initialize state on startup
browser.storage.local.get(['currentWorkspaceId', 'tabWorkspaceMap', 'workspaces', 'workspaceActiveTabMap', 'isAllTabsMode', 'actionLogs']).then(async (res) => {
    if (window.initI18n) await window.initI18n();
    if ('currentWorkspaceId' in res) currentWorkspaceId = res.currentWorkspaceId;
    if (res.tabWorkspaceMap) tabWorkspaceMap = res.tabWorkspaceMap;
    if (res.workspaceActiveTabMap) workspaceActiveTabMap = res.workspaceActiveTabMap;
    if ('isAllTabsMode' in res) isAllTabsMode = !!res.isAllTabsMode;
    if (res.actionLogs) actionLogs = res.actionLogs;
    
    if (res.workspaces && res.workspaces.length > 0) {
        workspaces = res.workspaces;
    } else {
        workspaces = getLocalizedDefaults();
        await browser.storage.local.set({ workspaces });
    }

    if (currentWorkspaceId) {
        currentWorkspaceId = normalizeWorkspaceId(currentWorkspaceId);
    } else if (!isAllTabsMode) {
        currentWorkspaceId = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
    }

    await rebuildTabWorkspaceMapFromOpenTabs();
    await enforceNoCloseOnLastTabSetting();
    await saveState();
    updateContextMenus();
    if (!isAllTabsMode && currentWorkspaceId) {
        await switchWorkspace(currentWorkspaceId, true);
    }
    isInitializingState = false;
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
    const previousWorkspaceId = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');

    if (currentWorkspaceId) {
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
            workspaceActiveTabMap[currentWorkspaceId] = currentTab.id;
            if (!tabWorkspaceMap[currentTab.id]) {
                assignTabToWorkspace(currentTab.id, currentWorkspaceId);
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
            ws = previousWorkspaceId || 'ws_default';
            if (!ws && workspaces.length > 0) {
                ws = workspaces[0].id;
            }
            assignTabToWorkspace(tab.id, ws);
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
        assignTabToWorkspace(newTab.id, currentWorkspaceId);
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
    }
    
    const menuAPI = browser.menus || browser.contextMenus;
    if (!menuAPI) return;

    const parentId = "move-to-workspace";
    
    menuAPI.create({
        id: parentId,
        title: getMessage("moveTab"),
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
            title: getMessage("moveTabs", [tabCount.toString()])
        }, () => browser.runtime.lastError); 
    } else {
        menuAPI.update("move-to-workspace", {
            title: getMessage("moveTab")
        }, () => browser.runtime.lastError);
    }
}

// Tab selection listener
browser.tabs.onHighlighted.addListener(async (highlightInfo) => {
    updateMenuTitle(highlightInfo.tabIds.length);
});

// Extension installation listener
browser.runtime.onInstalled.addListener(() => {
    enforceNoCloseOnLastTabSetting();
    updateContextMenus();
});

// Browser startup listener
browser.runtime.onStartup.addListener(() => {
    enforceNoCloseOnLastTabSetting();
    updateContextMenus();
});

// Move tabs to specified workspace
async function moveTabsToWorkspace(info, tab, targetWsId) {
    const highlightedTabsQuery = await browser.tabs.query({ highlighted: true, currentWindow: true });
    const highlightedTabs = highlightedTabsQuery.filter(t => tabWorkspaceMap[t.id] === currentWorkspaceId || tabWorkspaceMap[t.id] === undefined);
    
    let tabsToMove = [];
    const isClickedTabHighlighted = highlightedTabs.some(t => t.id === tab.id);
    
    if (isClickedTabHighlighted && highlightedTabs.length > 1) {
        tabsToMove = highlightedTabs;
    } else {
        tabsToMove = [tab];
    }

    for (let t of tabsToMove) {
        assignTabToWorkspace(t.id, targetWsId);
    }
    saveState();
    
    await moveTabsToEnd(tabsToMove.map(t => t.id));

    if (targetWsId !== currentWorkspaceId) {
        await switchWorkspace(currentWorkspaceId);
    }
}

// New tab creation listener
browser.tabs.onCreated.addListener(async (tab) => {
    if (isInitializingState || isRestoringData) return;

    const restoredWorkspaceId = normalizeWorkspaceId(await getSessionWorkspace(tab.id));
    const targetWorkspaceId = restoredWorkspaceId || normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
    assignTabToWorkspace(tab.id, targetWorkspaceId);

    if (targetWorkspaceId) {
        workspaceActiveTabMap[targetWorkspaceId] = tab.id;
    }
    saveState();
});

// Tab replaced listener (for suspended/discarded tabs)
if (browser.tabs.onReplaced) {
    browser.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
        const ws = tabWorkspaceMap[removedTabId];
        if (ws) {
            assignTabToWorkspace(addedTabId, ws);
            unassignTab(removedTabId);
            
            if (workspaceActiveTabMap[ws] === removedTabId) {
                workspaceActiveTabMap[ws] = addedTabId;
            }
            saveState();
        }
    });
}

// Tab removal listener
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const removedWorkspaceId = tabWorkspaceMap[tabId];
    unassignTab(tabId);
    if (removedWorkspaceId && workspaceActiveTabMap[removedWorkspaceId] === tabId) {
        delete workspaceActiveTabMap[removedWorkspaceId];
    }
    saveState();
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (isInitializingState || isAllTabsMode) return;
    if (removeInfo && removeInfo.isWindowClosing) return;
    if (!currentWorkspaceId) return;

    const hasWindowId = removeInfo && typeof removeInfo.windowId === 'number';
    const tabs = await browser.tabs.query(hasWindowId ? { windowId: removeInfo.windowId } : { currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const tabsInCurrentWorkspace = tabs.filter(tab => tabWorkspaceMap[tab.id] === currentWorkspaceId);
    if (tabsInCurrentWorkspace.length > 0) return;

    let fallbackWorkspaceId = null;
    for (const ws of workspaces) {
        if (tabs.some(tab => tabWorkspaceMap[tab.id] === ws.id)) {
            fallbackWorkspaceId = ws.id;
            break;
        }
    }

    if (fallbackWorkspaceId && fallbackWorkspaceId !== currentWorkspaceId) {
        await switchWorkspace(fallbackWorkspaceId, true);
        return;
    }

    const targetWorkspaceId = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
    const newTab = await browser.tabs.create(hasWindowId ? { windowId: removeInfo.windowId, active: true } : { active: true });
    assignTabToWorkspace(newTab.id, targetWorkspaceId);
    workspaceActiveTabMap[targetWorkspaceId] = newTab.id;
    currentWorkspaceId = targetWorkspaceId;
    await switchWorkspace(targetWorkspaceId, true);
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
                assignTabToWorkspace(id, newDefaultId);
            }
            workspaceActiveTabMap = {};
        }
        
        workspaces = newWorkspaces;
        
        if (mode !== 'NO_TABS') {
            isRestoringData = true;
            for (const ws of workspaces) {
                const tabsList = tabsData[ws.id];
                if (tabsList && Array.isArray(tabsList)) {
                    const groupMap = {}; 
                    let lastTabId = null;

                    for (const tabInfo of tabsList) {
                        try {
                            const url = typeof tabInfo === 'string' ? tabInfo : tabInfo.url;
                            const oldGroupId = typeof tabInfo === 'object' ? tabInfo.groupId : -1;

                            const newTab = await browser.tabs.create({ 
                                url: url, 
                                active: false 
                            });
                            assignTabToWorkspace(newTab.id, ws.id);
                            lastTabId = newTab.id;

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
                        }
                    }
                    if (lastTabId) {
                        workspaceActiveTabMap[ws.id] = lastTabId;
                    }
                }
            }
            isRestoringData = false;
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
                    assignTabToWorkspace(parseInt(id), toWsId);
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
            const tabs = await browser.tabs.query({ currentWindow: true });
            const visibleTabs = tabs.filter(t => !tabsToRemove.includes(t.id));
            
            if (visibleTabs.length === 0) {
                const targetWorkspaceId = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
                const newTab = await browser.tabs.create({ active: true });
                assignTabToWorkspace(newTab.id, targetWorkspaceId);
                workspaceActiveTabMap[targetWorkspaceId] = newTab.id;
                await saveState();
            }
            
            try {
                await browser.tabs.remove(tabsToRemove);
            } catch (e) {}
        }
    } else if (message.action === 'UNMAP_WORKSPACE_TABS') {
        const { wsId } = message;
        const allTabIds = Object.keys(tabWorkspaceMap);
        
        for (let id of allTabIds) {
            if (tabWorkspaceMap[id] === wsId) {
                unassignTab(parseInt(id));
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
        await clearSessionWorkspaceForTabs(tabsToShow);
        
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
        await clearSessionWorkspaceForTabs(tabsToShow);
        
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
                    assignTabToWorkspace(parseInt(id), toWsId);
                }
                saveState();
                await switchWorkspace(currentWorkspaceId);
            } else if (type === 'RESET_WORKSPACES') {
                tabWorkspaceMap = {};
                workspaces = [];
                currentWorkspaceId = null;
                workspaceActiveTabMap = {};
                isAllTabsMode = true;
                const allTabs = await browser.tabs.query({});
                await clearSessionWorkspaceForTabs(allTabs.map(t => t.id));
                
                await browser.storage.local.set({ 
                    workspaces: [],
                    currentWorkspaceId: null,
                    tabWorkspaceMap: {},
                    workspaceActiveTabMap: {},
                    isAllTabsMode: true
                });
                updateContextMenus();
                
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
                            assignTabToWorkspace(newTab.id, data.workspace.id);
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
                    assignTabToWorkspace(parseInt(id), fromWsId);
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

if (browser.action && browser.action.onClicked && browser.sidebarAction) {
    browser.action.onClicked.addListener(() => {
        if (typeof browser.sidebarAction.open === 'function') {
            browser.sidebarAction.open().catch(() => {});
            return;
        }
        if (typeof browser.sidebarAction.toggle === 'function') {
            browser.sidebarAction.toggle().catch(() => {});
        }
    });
}

// Safety: Show all tabs when extension is suspended/disabled
browser.runtime.onSuspend.addListener(() => {
    saveState();
    clearNoCloseOnLastTabSetting();
    browser.tabs.query({}).then(tabs => {
        const ids = tabs.map(t => t.id);
        if (ids.length > 0) {
            browser.tabs.show(ids);
        }
    });
});

// --- Auto-Backup Implementation ---

async function createAutoBackup(reason = 'scheduled') {
    const res = await browser.storage.local.get(['autoBackupEnabled', 'autoBackupFrequency', 'autoBackups', 'autoBackupMax']);
    if (res.autoBackupEnabled === false && reason === 'scheduled') return;
    
    // Generate backup data
    const backupData = {
        timestamp: Date.now(),
        reason: reason,
        workspaces: workspaces,
        tabs: {}
    };
    
    const allTabs = await browser.tabs.query({});
    for (let ws of workspaces) {
        backupData.tabs[ws.id] = [];
    }
    
    for (let tab of allTabs) {
        let wsId = tabWorkspaceMap[tab.id];
        if (wsId && backupData.tabs[wsId]) {
            backupData.tabs[wsId].push({
                url: tab.url,
                groupId: tab.groupId !== undefined ? tab.groupId : -1
            });
        }
    }
    
    let backups = res.autoBackups || [];
    backups.push(backupData);
    
    const maxBackups = res.autoBackupMax || 100;
    if (backups.length > maxBackups) {
        backups = backups.slice(backups.length - maxBackups);
    }
    
    await browser.storage.local.set({ autoBackups: backups });
}

async function checkAutoBackupAlarms() {
    const res = await browser.storage.local.get(['autoBackupEnabled', 'autoBackupFrequency', 'backupOnStartup']);
    if (browser.alarms) {
        await browser.alarms.clear('autoBackupAlarm');
        if (res.autoBackupEnabled !== false) {
            let hours = parseInt(res.autoBackupFrequency) || 72;
            browser.alarms.create('autoBackupAlarm', { periodInMinutes: hours * 60 });
        }
    }
    
    if (res.backupOnStartup) {
        createAutoBackup('startup');
    }
}

if (browser.alarms) {
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'autoBackupAlarm') {
            createAutoBackup('scheduled');
        }
    });
}

// Ensure settings change updates the alarm
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.autoBackupEnabled || changes.autoBackupFrequency)) {
        checkAutoBackupAlarms();
    }
    if (area === 'local' && changes.triggerManualBackup) {
        createAutoBackup('manual');
    }
});

setTimeout(checkAutoBackupAlarms, 2000);
