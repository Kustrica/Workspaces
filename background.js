
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

function resolveExistingWorkspaceId(workspaceId) {
    if (!workspaceId) return null;
    if (workspaceExists(workspaceId)) return workspaceId;
    return null;
}

function getFallbackWorkspaceId() {
    const lastActive = resolveExistingWorkspaceId(lastActiveWsId);
    if (lastActive) return lastActive;
    if (workspaces.length > 0) return workspaces[0].id;
    // Only invent Main if that workspace actually exists (or list is empty/uninitialized).
    if (workspaceExists('ws_default')) return 'ws_default';
    return workspaces.length === 0 ? 'ws_default' : workspaces[0].id;
}

function resolveNewTabWorkspaceSync(tab) {
    if (tab && tab.openerTabId != null) {
        const openerWs = resolveExistingWorkspaceId(tabWorkspaceMap[tab.openerTabId]);
        if (openerWs) return openerWs;
    }
    if (!isAllTabsMode) {
        const current = resolveExistingWorkspaceId(currentWorkspaceId);
        if (current) return current;
    }
    const lastActive = resolveExistingWorkspaceId(lastActiveWsId);
    if (lastActive) return lastActive;
    return getFallbackWorkspaceId();
}

async function resolveNewTabWorkspaceAsync(tab) {
    let fresh = tab;
    try {
        fresh = await browser.tabs.get(tab.id);
    } catch (e) {
        fresh = tab;
    }

    // 1) Opener tab workspace (middle-click / Ctrl+click / "Open in new tab")
    const openerId = fresh && fresh.openerTabId != null ? fresh.openerTabId : (tab && tab.openerTabId);
    if (openerId != null) {
        const openerWs = resolveExistingWorkspaceId(tabWorkspaceMap[openerId]);
        if (openerWs) return openerWs;
        try {
            const openerSession = resolveExistingWorkspaceId(await getSessionWorkspace(openerId));
            if (openerSession) return openerSession;
        } catch (e) {}
    }

    // 2) Active tab in the same window (page the user was viewing)
    try {
        const windowId = fresh.windowId != null ? fresh.windowId : tab.windowId;
        const query = typeof windowId === 'number' ? { active: true, windowId } : { active: true, currentWindow: true };
        const [active] = await browser.tabs.query(query);
        if (active && active.id !== tab.id) {
            const activeWs = resolveExistingWorkspaceId(tabWorkspaceMap[active.id]);
            if (activeWs) return activeWs;
            const activeSession = resolveExistingWorkspaceId(await getSessionWorkspace(active.id));
            if (activeSession) return activeSession;
        }
    } catch (e) {}

    // 3) Current / last-active workspace from extension state
    if (!isAllTabsMode) {
        const current = resolveExistingWorkspaceId(currentWorkspaceId);
        if (current) return current;
    }
    const lastActive = resolveExistingWorkspaceId(lastActiveWsId);
    if (lastActive) return lastActive;

    return getFallbackWorkspaceId();
}

function assignTabToWorkspace(tabId, workspaceId, options = {}) {
    if (!tabId || !workspaceId) return;
    tabWorkspaceMap[tabId] = workspaceId;
    // During cold wake, provisional assigns must not write session yet — rebuild trusts session first
    // and would cement default Main before real state loads.
    if (options.persistSession !== false) {
        // Return the promise (instead of true fire-and-forget) so callers that care about
        // durability — e.g. right before a workspace switch or on suspend — can await it.
        return setSessionWorkspace(tabId, workspaceId);
    }
}

function unassignTab(tabId) {
    if (!tabId) return;
    delete tabWorkspaceMap[tabId];
    pendingTabAssignments.delete(tabId);
    delete tabWindowMap[tabId];
    delete tabUrlCache[tabId];
    clearSessionWorkspace(tabId);
}

function rememberTabMeta(tab) {
    if (!tab || tab.id == null) return;
    if (typeof tab.windowId === 'number') tabWindowMap[tab.id] = tab.windowId;
    if (typeof tab.url === 'string' && tab.url) tabUrlCache[tab.id] = tab.url;
}

function getOtherTabIdsInWindow(windowId, excludeTabId) {
    if (typeof windowId !== 'number') return [];
    const ids = [];
    for (const idStr of Object.keys(tabWindowMap)) {
        const id = parseInt(idStr, 10);
        if (id === excludeTabId) continue;
        if (tabWindowMap[id] === windowId) ids.push(id);
    }
    return ids;
}

function buildCrashRecoverySnapshot() {
    const tabsByWorkspace = {};
    for (const ws of workspaces) {
        tabsByWorkspace[ws.id] = [];
    }
    for (const idStr of Object.keys(tabWorkspaceMap)) {
        const id = parseInt(idStr, 10);
        const wsId = tabWorkspaceMap[id];
        if (!wsId) continue;
        if (!tabsByWorkspace[wsId]) tabsByWorkspace[wsId] = [];
        const url = tabUrlCache[id];
        if (!url || url === 'about:blank') continue;
        tabsByWorkspace[wsId].push({ url, tabId: id, windowId: tabWindowMap[id] });
    }
    return {
        timestamp: Date.now(),
        currentWorkspaceId,
        lastActiveWsId,
        isAllTabsMode: !!isAllTabsMode,
        workspaces: workspaces,
        tabsByWorkspace
    };
}

function fireCrashRecoverySnapshot() {
    try {
        const snapshot = buildCrashRecoverySnapshot();
        browser.storage.local.set({ crashRecoverySnapshot: snapshot }).catch(() => {});
    } catch (e) {}
}

function countSnapshotTabs(snapshot) {
    if (!snapshot || !snapshot.tabsByWorkspace) return 0;
    return Object.values(snapshot.tabsByWorkspace).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
}

async function remapOpenTabsFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.tabsByWorkspace) return;
    const tabs = await browser.tabs.query({});
    const urlToWsQueue = {};
    for (const [wsId, list] of Object.entries(snapshot.tabsByWorkspace)) {
        if (!Array.isArray(list)) continue;
        for (const info of list) {
            if (!info || !info.url) continue;
            if (!urlToWsQueue[info.url]) urlToWsQueue[info.url] = [];
            urlToWsQueue[info.url].push(wsId);
        }
    }
    for (const tab of tabs) {
        const url = tab.url || '';
        if (!url || url === 'about:blank' || url === 'about:newtab') continue;
        const queue = urlToWsQueue[url];
        if (queue && queue.length > 0) {
            const wsId = queue.shift();
            assignTabToWorkspace(tab.id, wsId);
        }
        rememberTabMeta(tab);
    }
    await saveState({ force: true });
}

async function restoreTabsFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.tabsByWorkspace) return;
    isRestoringData = true;
    try {
        const targetWs = resolveExistingWorkspaceId(snapshot.currentWorkspaceId)
            || resolveExistingWorkspaceId(snapshot.lastActiveWsId)
            || (snapshot.workspaces && snapshot.workspaces[0] && snapshot.workspaces[0].id)
            || getFallbackWorkspaceId();

        if (Array.isArray(snapshot.workspaces) && snapshot.workspaces.length > 0) {
            workspaces = snapshot.workspaces;
            await browser.storage.local.set({ workspaces });
        }

        for (const [wsId, list] of Object.entries(snapshot.tabsByWorkspace)) {
            if (!Array.isArray(list)) continue;
            for (const info of list) {
                if (!info || !info.url) continue;
                if (info.url.startsWith('about:') && info.url !== 'about:blank') continue;
                try {
                    const newTab = await browser.tabs.create({ url: info.url, active: false });
                    assignTabToWorkspace(newTab.id, wsId);
                    rememberTabMeta(newTab);
                } catch (e) {}
            }
        }

        currentWorkspaceId = targetWs;
        isAllTabsMode = false;
        if (targetWs) lastActiveWsId = targetWs;
        await saveState({ force: true });
        await switchWorkspace(targetWs, true);
    } finally {
        isRestoringData = false;
    }
}

async function maybeRecoverAfterUnexpectedClose() {
    const res = await browser.storage.local.get('crashRecoverySnapshot');
    const snap = res.crashRecoverySnapshot;
    if (!snap || !snap.timestamp) return;

    const ageMs = Date.now() - snap.timestamp;
    // Only auto-recover a very recent snapshot (window just died from last-visible-tab close).
    if (ageMs > 45 * 60 * 1000) return;

    const snapCount = countSnapshotTabs(snap);
    if (snapCount < 2) return;

    const tabs = await browser.tabs.query({});
    for (const t of tabs) rememberTabMeta(t);
    const realTabs = tabs.filter(t => {
        const url = t.url || '';
        return url && url !== 'about:blank' && url !== 'about:newtab' && url !== 'about:home';
    });

    // Browser already restored a normal session — just remap if needed.
    if (realTabs.length >= Math.min(snapCount, 3)) {
        await remapOpenTabsFromSnapshot(snap);
        return;
    }

    // Prefer Firefox's own recently-closed window (what Ctrl+Shift+T uses under the hood).
    try {
        if (browser.sessions && browser.sessions.getRecentlyClosed) {
            const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
            for (const entry of recent) {
                if (entry.window && entry.window.tabs && entry.window.tabs.length >= 2) {
                    await browser.sessions.restore(entry.window.sessionId);
                    await new Promise(r => setTimeout(r, 800));
                    await remapOpenTabsFromSnapshot(snap);
                    addLog(
                        'CRASH_RECOVERY',
                        `Restored ${entry.window.tabs.length} tab(s) after the window closed when the last visible workspace tab was closed.`,
                        null
                    );
                    return;
                }
            }
        }
    } catch (e) {}

    // Last resort: recreate tabs from our snapshot URLs.
    await restoreTabsFromSnapshot(snap);
    addLog(
        'CRASH_RECOVERY',
        `Recreated ${snapCount} tab(s) from the emergency snapshot after an unexpected window close.`,
        null
    );
}

let pendingTabAssignments = new Set();
let lastActiveWsId = null;
// tabId → windowId / url kept in memory so the last-visible-tab race can react with ZERO
// awaits (no tabs.query before tabs.show / crash snapshot).
const tabWindowMap = {};
const tabUrlCache = {};
let resolveInitReady = null;
const initReadyPromise = new Promise((resolve) => {
    resolveInitReady = resolve;
});
const pendingStoragePatches = [];
const pendingInitActions = [];

function applyStorageSnapshot(res) {
    if (!res || typeof res !== 'object') return;

    if ('currentWorkspaceId' in res) currentWorkspaceId = res.currentWorkspaceId;
    if (res.tabWorkspaceMap) tabWorkspaceMap = res.tabWorkspaceMap;
    if (res.workspaceActiveTabMap) workspaceActiveTabMap = res.workspaceActiveTabMap;
    if ('isAllTabsMode' in res) isAllTabsMode = !!res.isAllTabsMode;
    if (res.actionLogs) actionLogs = res.actionLogs;
    if (res.lastActiveWsId) lastActiveWsId = res.lastActiveWsId;

    if ('workspaces' in res) {
        if (Array.isArray(res.workspaces) && res.workspaces.length > 0) {
            workspaces = res.workspaces;
        } else if (Array.isArray(res.workspaces) && res.workspaces.length === 0) {
            // Explicit empty list (e.g. delete-all) — do NOT resurrect defaults.
            workspaces = [];
        }
    }
}

function normalizeLoadedWorkspaceSelection() {
    if (currentWorkspaceId) {
        currentWorkspaceId = normalizeWorkspaceId(currentWorkspaceId);
        if (!lastActiveWsId) lastActiveWsId = currentWorkspaceId;
    } else if (!isAllTabsMode) {
        currentWorkspaceId = resolveExistingWorkspaceId(lastActiveWsId)
            || (workspaces[0] ? workspaces[0].id : null)
            || getFallbackWorkspaceId();
        if (currentWorkspaceId && !lastActiveWsId) lastActiveWsId = currentWorkspaceId;
    } else if (!lastActiveWsId && workspaces.length > 0) {
        lastActiveWsId = workspaces[0].id;
    }
}

async function flushPendingInitActions() {
    while (pendingInitActions.length > 0) {
        const action = pendingInitActions.shift();
        try {
            await action();
        } catch (e) {}
    }
}

async function runWhenReady(action) {
    if (!isInitializingState) {
        return action();
    }
    return new Promise((resolve, reject) => {
        pendingInitActions.push(async () => {
            try {
                resolve(await action());
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function enforceNoCloseOnLastTabSetting() {
    // Unsupported by Firefox WebExtensions API
}

async function clearNoCloseOnLastTabSetting() {
    // Unsupported by Firefox WebExtensions API
}

async function rebuildTabWorkspaceMapFromOpenTabs() {
    const tabs = await browser.tabs.query({});
    const rebuiltMap = {};
    const preferredFallback = resolveExistingWorkspaceId(currentWorkspaceId)
        || resolveExistingWorkspaceId(lastActiveWsId)
        || (workspaces.length > 0 ? workspaces[0].id : null);

    // Track how many restored tabs we could actually re-identify vs. how many were unknown
    // ("orphans"). A handful of orphans among otherwise-recognized tabs is normal (e.g. a tab
    // whose session value never got written). But if EVERY tab is an orphan, that is not a
    // couple of stray tabs — it means tab/session tracking data was lost wholesale (private
    // browsing, "never remember history", a forced/unclean shutdown, a fresh profile, etc.).
    let consideredCount = 0;
    let resolvedCount = 0;

    for (const tab of tabs) {
        rememberTabMeta(tab);

        // Tabs mid-assignment: keep memory only; do not trust session (may be provisional Main).
        if (pendingTabAssignments.has(tab.id)) {
            const pendingWs = resolveExistingWorkspaceId(tabWorkspaceMap[tab.id]);
            if (pendingWs) rebuiltMap[tab.id] = pendingWs;
            continue;
        }

        consideredCount++;

        const sessionWorkspaceId = resolveExistingWorkspaceId(await getSessionWorkspace(tab.id));
        if (sessionWorkspaceId) {
            rebuiltMap[tab.id] = sessionWorkspaceId;
            setSessionWorkspace(tab.id, sessionWorkspaceId);
            resolvedCount++;
            continue;
        }

        const legacyWorkspaceId = resolveExistingWorkspaceId(tabWorkspaceMap[tab.id]);
        if (legacyWorkspaceId) {
            rebuiltMap[tab.id] = legacyWorkspaceId;
            setSessionWorkspace(tab.id, legacyWorkspaceId);
            resolvedCount++;
            continue;
        }

        if (preferredFallback) {
            rebuiltMap[tab.id] = preferredFallback;
            setSessionWorkspace(tab.id, preferredFallback);
        }
    }

    tabWorkspaceMap = rebuiltMap;

    // Safety net: never silently funnel every single restored tab into one workspace when we
    // have zero real evidence of where any of them belong — that is exactly what produced
    // reports like "I woke up and ALL my tabs were in workspace 4, which I never even opened".
    // Fail safe into All Tabs mode instead: nothing gets hidden/hidden-away, the user sees
    // everything they had, and can re-sort tabs into workspaces manually when data is missing.
    if (consideredCount > 1 && resolvedCount === 0 && workspaces.length > 1) {
        isAllTabsMode = true;
        if (currentWorkspaceId) lastActiveWsId = currentWorkspaceId;
        currentWorkspaceId = null;
        addLog(
            'SAFE_MODE_ALL_TABS',
            `Workspace assignment for ${consideredCount} restored tab(s) could not be recovered (browser/session data was lost) — switched to All Tabs so nothing appears hidden or moved.`,
            null
        );
    }
}

const STATE_KEYS = ['currentWorkspaceId', 'tabWorkspaceMap', 'workspaces', 'workspaceActiveTabMap', 'isAllTabsMode', 'actionLogs', 'lastActiveWsId'];

// Initialize state on startup
browser.storage.local.get(STATE_KEYS).then(async (res) => {
    try {
        if (window.initI18n) await window.initI18n();

        if (!('workspaces' in res) || res.workspaces == null) {
            workspaces = getLocalizedDefaults();
            await browser.storage.local.set({ workspaces });
            applyStorageSnapshot(res);
            // keep the defaults we just wrote (applyStorageSnapshot ignores missing workspaces key)
        } else {
            applyStorageSnapshot(res);
        }

        normalizeLoadedWorkspaceSelection();
        await rebuildTabWorkspaceMapFromOpenTabs();
        await enforceNoCloseOnLastTabSetting();

        // If the previous session died because Firefox closed the window on last-visible-tab,
        // recover tabs (sessions.restore or snapshot) before we hide anything.
        await maybeRecoverAfterUnexpectedClose();

        // Merge any storage writes that happened while we were loading (sidebar switch, etc.).
        while (pendingStoragePatches.length > 0) {
            applyStorageSnapshot(pendingStoragePatches.shift());
        }
        const fresh = await browser.storage.local.get(STATE_KEYS);
        applyStorageSnapshot(fresh);
        normalizeLoadedWorkspaceSelection();

        await saveState({ force: true });
        fireCrashRecoverySnapshot();
        updateContextMenus();

        // Soft visibility repair — never force-activate on wake (focus steal).
        if (!isAllTabsMode && currentWorkspaceId) {
            await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: false });
        }
    } finally {
        isInitializingState = false;
        if (resolveInitReady) resolveInitReady();
        await flushPendingInitActions();
    }
});

// Keyboard command handler
browser.commands.onCommand.addListener(async (command) => {
    if (command.startsWith("switch_workspace_")) {
        await initReadyPromise;
        const index = parseInt(command.replace("switch_workspace_", "")) - 1;
        
        const res = await browser.storage.local.get('workspaces');
        const currentWorkspaces = (res.workspaces && res.workspaces.length > 0)
            ? res.workspaces
            : workspaces;
        
        if (index >= 0 && index < currentWorkspaces.length) {
            const targetWs = currentWorkspaces[index];
            await switchWorkspace(targetWs.id);
        }
    }
});

// Save current state to local storage
function saveState(options = {}) {
    // Cold wake: listeners can fire before storage is loaded. Default memory is Main —
    // persisting that would overwrite the real current workspace and steal focus.
    if (isInitializingState && !options.force) {
        return Promise.resolve();
    }
    const payload = { currentWorkspaceId, tabWorkspaceMap, workspaceActiveTabMap, isAllTabsMode };
    if (lastActiveWsId) payload.lastActiveWsId = lastActiveWsId;
    return browser.storage.local.set(payload);
}

// Track tab activation to update active tab map
browser.tabs.onActivated.addListener(async (activeInfo) => {
    if (isInitializingState || isRestoringData || isSwitchingWorkspace) return;

    const tabId = activeInfo.tabId;
    const mapped = resolveExistingWorkspaceId(tabWorkspaceMap[tabId]);
    const wsId = mapped || resolveExistingWorkspaceId(currentWorkspaceId);
    if (!wsId) return;

    workspaceActiveTabMap[wsId] = tabId;
    saveState();
});

let isSwitchingWorkspace = false;
let pendingWorkspaceSwitch = null;

// Repair show/hide after background wake without forcing a different active tab.
async function repairWorkspaceVisibility(workspaceId, options = {}) {
    if (!workspaceId || isAllTabsMode) return;

    const allowActivate = options.allowActivate === true;
    const windowId = options.windowId;
    const tabQuery = typeof windowId === 'number' ? { windowId } : { currentWindow: true };

    const tabs = await browser.tabs.query(tabQuery);
    const toShow = [];
    const toHide = [];

    for (const tab of tabs) {
        let ws = tabWorkspaceMap[tab.id];
        if (!ws) {
            // Do not auto-claim orphans on wake — that migrates lost tabs into the wrong space.
            toHide.push(tab.id);
            continue;
        }

        const keepVisible = tab.groupId !== undefined && tab.groupId !== -1;
        if (ws === workspaceId || keepVisible) {
            toShow.push(tab.id);
        } else {
            toHide.push(tab.id);
        }
    }

    if (toShow.length > 0) {
        try { await browser.tabs.show(toShow); } catch (e) {}
    }

    if (allowActivate) {
        const activeQuery = typeof windowId === 'number'
            ? { active: true, windowId }
            : { active: true, currentWindow: true };
        const [active] = await browser.tabs.query(activeQuery);
        const activeBelongsHere = active && tabWorkspaceMap[active.id] === workspaceId;

        if (!activeBelongsHere) {
            let tabToActivate = workspaceActiveTabMap[workspaceId];
            if (!tabToActivate || !toShow.includes(tabToActivate) || tabWorkspaceMap[tabToActivate] !== workspaceId) {
                tabToActivate = null;
                for (let i = toShow.length - 1; i >= 0; i--) {
                    const id = toShow[i];
                    if (tabWorkspaceMap[id] === workspaceId) {
                        tabToActivate = id;
                        break;
                    }
                }
            }
            if (tabToActivate) {
                try { await browser.tabs.update(tabToActivate, { active: true }); } catch (e) {}
            }
        }
    }

    if (toHide.length > 0) {
        const activeQuery = typeof windowId === 'number'
            ? { active: true, windowId }
            : { active: true, currentWindow: true };
        const [stillActive] = await browser.tabs.query(activeQuery);
        let hideList = toHide;
        if (stillActive && hideList.includes(stillActive.id)) {
            hideList = hideList.filter(id => id !== stillActive.id);
        }
        if (hideList.length > 0) {
            try { await browser.tabs.hide(hideList); } catch (e) {}
        }
    }

    saveState({ force: !isInitializingState });
}

// Switch active workspace
async function switchWorkspace(workspaceId, preserveActiveTab = false) {
    if (isSwitchingWorkspace) {
        pendingWorkspaceSwitch = { workspaceId, preserveActiveTab };
        return;
    }
    isSwitchingWorkspace = true;

    try {
    if (currentWorkspaceId) {
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
            workspaceActiveTabMap[currentWorkspaceId] = currentTab.id;
            // Do not claim unmapped active tabs into the workspace we are leaving —
            // that race with onCreated was pushing tabs into Main.
        }
    }
    
    await saveState();

    currentWorkspaceId = workspaceId;
    isAllTabsMode = false;
    if (workspaceId) lastActiveWsId = workspaceId;
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
            if (pendingTabAssignments.has(tab.id)) {
                // Race with onCreated — do not claim into previous/Main; hide until assignment finishes.
                toHide.push(tab.id);
                continue;
            }
            // Adopt only visible orphans into the destination workspace.
            // Hidden unmapped tabs stay hidden and unassigned (avoids mass-migration on wake).
            if (tab.hidden) {
                toHide.push(tab.id);
                continue;
            }
            assignTabToWorkspace(tab.id, currentWorkspaceId);
            ws = currentWorkspaceId;
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
        pendingTabAssignments.add(newTab.id);
        assignTabToWorkspace(newTab.id, currentWorkspaceId);
        pendingTabAssignments.delete(newTab.id);
        workspaceActiveTabMap[currentWorkspaceId] = newTab.id;
    }
    
    saveState();
    
    if (toShow.length > 0) {
        try { await browser.tabs.show(toShow); } catch(e) {}

        let tabToActivate = null;
        const [activeNow] = await browser.tabs.query({ active: true, currentWindow: true });
        const activeBelongsHere = activeNow && tabWorkspaceMap[activeNow.id] === workspaceId && toShow.includes(activeNow.id);

        if (!preserveActiveTab || !activeBelongsHere) {
            tabToActivate = workspaceActiveTabMap[workspaceId];
            
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
                    // Never fall back to a keepVisible foreign tab (e.g. Main group tab).
                    tabToActivate = null;
                }
            }

            if (tabToActivate && toShow.includes(tabToActivate) && tabWorkspaceMap[tabToActivate] === workspaceId) {
                try { await browser.tabs.update(tabToActivate, { active: true }); } catch(e) {}
            }
        }
    }

    if (toHide.length > 0) {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTab && toHide.includes(activeTab.id)) {
            let fallback = null;
            for (let i = toShow.length - 1; i >= 0; i--) {
                const id = toShow[i];
                if (tabWorkspaceMap[id] === workspaceId) {
                    fallback = id;
                    break;
                }
            }
            if (fallback) {
                try { await browser.tabs.update(fallback, { active: true }); } catch(e) {}
            }
        }

        const [stillActive] = await browser.tabs.query({ active: true, currentWindow: true });
        if (stillActive && toHide.includes(stillActive.id)) {
            const idx = toHide.indexOf(stillActive.id);
            if (idx > -1) toHide.splice(idx, 1);
        }
        
        try { await browser.tabs.hide(toHide); } catch(e) {}
    }
    fireCrashRecoverySnapshot();
    } finally {
        isSwitchingWorkspace = false;
        if (pendingWorkspaceSwitch) {
            const next = pendingWorkspaceSwitch;
            pendingWorkspaceSwitch = null;
            switchWorkspace(next.workspaceId, next.preserveActiveTab);
        }
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

        // Firefox's `menus` API supports a real per-item icon (`icons: { "16": url }`).
        // Previously `img:`-type icons (all 5 default workspaces use one) were blanked out,
        // so the "Move tab to..." submenu showed no icon at all for them. Use the real icon
        // where the API supports it; only fall back to no icon on APIs that don't (e.g. Chrome's
        // contextMenus, which has no `icons` option for menu items).
        const supportsItemIcons = menuAPI === browser.menus;

        workspaces.forEach(ws => {
            let title = ws.name;
            const createOpts = {
                id: `move-to-${ws.id}`,
                parentId: parentId,
                contexts: ["tab"]
            };

            if (ws.icon && ws.icon.startsWith('img:')) {
                if (supportsItemIcons) {
                    createOpts.icons = { "16": ws.icon.substring(4) };
                }
            } else if (ws.icon) {
                title = `${ws.icon} ${ws.name}`;
            }
            createOpts.title = title;

            try {
                menuAPI.create(createOpts, () => {
                    if (browser.runtime.lastError) { /* ignore: e.g. icons unsupported on this platform */ }
                });
            } catch (e) {
                // Retry without icons if this platform rejected the extra option entirely.
                delete createOpts.icons;
                try { menuAPI.create(createOpts, () => { if (browser.runtime.lastError) {} }); } catch (e2) {}
            }
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
browser.runtime.onInstalled.addListener(async () => {
    enforceNoCloseOnLastTabSetting();
    updateContextMenus();
    await checkAutoBackupAlarms();
});

// Browser startup listener
browser.runtime.onStartup.addListener(async () => {
    enforceNoCloseOnLastTabSetting();
    updateContextMenus();
    await checkAutoBackupAlarms();
    const res = await browser.storage.local.get('backupOnStartup');
    if (res.backupOnStartup !== false) {
        createAutoBackup('startup');
    }
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
    if (isRestoringData) return;

    rememberTabMeta(tab);

    // Provisional sync assignment before any await — prevents switchWorkspace races.
    // During init: memory only (no session) so rebuild cannot cement default Main.
    const provisionalWorkspaceId = resolveNewTabWorkspaceSync(tab);
    pendingTabAssignments.add(tab.id);
    assignTabToWorkspace(tab.id, provisionalWorkspaceId, { persistSession: !isInitializingState });

    try {
        // Background may wake cold: wait until storage/map are loaded before final assign.
        if (isInitializingState) {
            await initReadyPromise;
        }

        // Do NOT use this tab's session value here — for user-opened tabs it is empty or
        // races with our own setTabValue; stale/fallback session was pushing tabs into Main.
        const targetWorkspaceId = await resolveNewTabWorkspaceAsync(tab);

        if (targetWorkspaceId !== tabWorkspaceMap[tab.id]) {
            assignTabToWorkspace(tab.id, targetWorkspaceId);
        } else {
            // Ensure session is persisted after init barrier.
            assignTabToWorkspace(tab.id, targetWorkspaceId, { persistSession: true });
        }

        // Background middle-click must not become the remembered active tab for the workspace.
        let isActiveTab = !!tab.active;
        try {
            const fresh = await browser.tabs.get(tab.id);
            isActiveTab = !!fresh.active;
        } catch (e) {}
        if (targetWorkspaceId && isActiveTab) {
            workspaceActiveTabMap[targetWorkspaceId] = tab.id;
        }
        saveState();

        if (!isAllTabsMode && currentWorkspaceId) {
            try {
                if (targetWorkspaceId === currentWorkspaceId) {
                    await browser.tabs.show(tab.id);
                } else {
                    const windowId = tab.windowId;
                    const query = typeof windowId === 'number'
                        ? { active: true, windowId }
                        : { active: true, currentWindow: true };
                    const [active] = await browser.tabs.query(query);
                    if (!active || active.id !== tab.id) {
                        await browser.tabs.hide(tab.id);
                    }
                }
            } catch (e) {}
        }
    } finally {
        pendingTabAssignments.delete(tab.id);
        fireCrashRecoverySnapshot();
    }
});

// Keep URL/window cache fresh for crash-recovery snapshots (no await needed on the hot path).
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || tab.url) {
        tabUrlCache[tabId] = changeInfo.url || tab.url;
    }
    if (tab && typeof tab.windowId === 'number') {
        tabWindowMap[tabId] = tab.windowId;
    }
});

if (browser.tabs.onAttached) {
    browser.tabs.onAttached.addListener((tabId, attachInfo) => {
        if (attachInfo && typeof attachInfo.newWindowId === 'number') {
            tabWindowMap[tabId] = attachInfo.newWindowId;
        }
    });
}

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

// Tab removal: unmap + keep the window alive if this was the last VISIBLE tab.
// Must stay a single listener so we can snapshot BEFORE clearing maps, then show hidden
// tabs with zero awaits (Firefox closes the window when zero visible tabs remain).
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (isRestoringData) return;

    const removedWorkspaceId = tabWorkspaceMap[tabId];
    const windowId = (removeInfo && typeof removeInfo.windowId === 'number')
        ? removeInfo.windowId
        : tabWindowMap[tabId];

    // Snapshot while this tab's URL is still in the cache.
    fireCrashRecoverySnapshot();

    // Collect siblings BEFORE unassign clears this tab's window mapping.
    const otherIds = getOtherTabIdsInWindow(windowId, tabId);

    unassignTab(tabId);
    if (removedWorkspaceId && workspaceActiveTabMap[removedWorkspaceId] === tabId) {
        delete workspaceActiveTabMap[removedWorkspaceId];
    }
    saveState();

    if (isInitializingState || isAllTabsMode) return;
    if (removeInfo && removeInfo.isWindowClosing) return;
    if (!currentWorkspaceId) return;

    // CRITICAL PATH — must not await anything before keeping at least one VISIBLE tab.
    // Hidden tabs (other workspaces) do NOT prevent Firefox from closing the window.
    // Showing already-present hidden tabs wins the race; tabs.create() often loses it.
    // Emergency snapshot above also lets the next startup recover via sessions.restore /
    // crashRecoverySnapshot if we still lose (same idea as Ctrl+Shift+T, plus workspace map).

    const currentWsOthersHere = otherIds.filter(id => tabWorkspaceMap[id] === currentWorkspaceId);

    if (currentWsOthersHere.length > 0) {
        browser.tabs.show(currentWsOthersHere).catch(() => {});
        return;
    }

    if (otherIds.length > 0) {
        browser.tabs.show(otherIds).catch(() => {});
        finishKeepWindowAlive(windowId, otherIds).catch(() => {});
        return;
    }

    const targetWorkspaceId = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
    currentWorkspaceId = targetWorkspaceId;
    const createOpts = typeof windowId === 'number' ? { windowId, active: true } : { active: true };
    browser.tabs.create(createOpts).then((newTab) => {
        pendingTabAssignments.add(newTab.id);
        assignTabToWorkspace(newTab.id, targetWorkspaceId);
        pendingTabAssignments.delete(newTab.id);
        rememberTabMeta(newTab);
        workspaceActiveTabMap[targetWorkspaceId] = newTab.id;
        fireCrashRecoverySnapshot();
        return saveState();
    }).catch(() => {});
});

async function finishKeepWindowAlive(windowId, otherIds) {
    // Pick a destination workspace that actually owns one of the surviving tabs.
    // Prefer lastActiveWsId / previous current only if they still have tabs here; otherwise the
    // first workspace that has a surviving tab. Tab↔workspace ownership is NOT rewritten —
    // we only change which workspace is active so the window stays open with real tabs visible.
    let destination = null;
    const candidates = [lastActiveWsId, currentWorkspaceId].concat(workspaces.map(w => w.id));
    for (const wsId of candidates) {
        if (!wsId) continue;
        if (otherIds.some(id => tabWorkspaceMap[id] === wsId)) {
            destination = wsId;
            break;
        }
    }
    if (!destination) {
        destination = normalizeWorkspaceId(currentWorkspaceId) || (workspaces[0] ? workspaces[0].id : 'ws_default');
    }

    currentWorkspaceId = destination;
    isAllTabsMode = false;
    lastActiveWsId = destination;
    await saveState();
    fireCrashRecoverySnapshot();

    try {
        await switchWorkspace(destination, true);
    } catch (e) {
        try {
            await repairWorkspaceVisibility(destination, { allowActivate: true, windowId });
        } catch (e2) {}
    }
}

// Storage change listener
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.workspaces) {
        workspaces = changes.workspaces.newValue || [];
        updateContextMenus();
    }

    if (isInitializingState) {
        const patch = {};
        if (changes.currentWorkspaceId) patch.currentWorkspaceId = changes.currentWorkspaceId.newValue;
        if (changes.isAllTabsMode) patch.isAllTabsMode = changes.isAllTabsMode.newValue;
        if (changes.lastActiveWsId) patch.lastActiveWsId = changes.lastActiveWsId.newValue;
        if (changes.tabWorkspaceMap) patch.tabWorkspaceMap = changes.tabWorkspaceMap.newValue;
        if (changes.workspaceActiveTabMap) patch.workspaceActiveTabMap = changes.workspaceActiveTabMap.newValue;
        if (changes.workspaces) patch.workspaces = changes.workspaces.newValue;
        if (Object.keys(patch).length > 0) pendingStoragePatches.push(patch);
        return;
    }

    // Sidebar writes these before SWITCH_WORKSPACE — keep memory in sync for new-tab assignment.
    if (changes.currentWorkspaceId && !isSwitchingWorkspace) {
        currentWorkspaceId = changes.currentWorkspaceId.newValue;
    }
    if (changes.isAllTabsMode) {
        isAllTabsMode = !!changes.isAllTabsMode.newValue;
    }
    if (changes.lastActiveWsId && changes.lastActiveWsId.newValue) {
        lastActiveWsId = changes.lastActiveWsId.newValue;
    }
});

// Message handler
browser.runtime.onMessage.addListener(async (message) => {
    if (message.action === 'SWITCH_WORKSPACE') {
        return runWhenReady(async () => {
            await switchWorkspace(message.workspaceId);
            return { currentWorkspaceId };
        });
    } else if (message.action === 'GET_CURRENT_WORKSPACE') {
        await initReadyPromise;
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
        
        // Explicitly get the current window to avoid background script context loss
        const targetWindow = await browser.windows.getCurrent();
        const targetWindowId = targetWindow.id;

        const safetyTab = await browser.tabs.create({ windowId: targetWindowId, url: 'about:blank', active: true });
        
        await new Promise(r => setTimeout(r, 500));

        let oldTabIds = [];
        if (mode === 'REPLACE') {
            const winTabs = await browser.tabs.query({ windowId: targetWindowId });
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
        
        let totalTabs = 0;
        
        if (mode !== 'NO_TABS') {
            isRestoringData = true;
            
            for (const ws of workspaces) {
                if (tabsData[ws.id]) totalTabs += tabsData[ws.id].length;
            }
            
            let restoredTabs = 0;
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
                                windowId: targetWindowId,
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

                            restoredTabs++;
                            const progress = totalTabs > 0 ? Math.round((restoredTabs / totalTabs) * 99) : 99; // Cap at 99% until fully done
                            browser.runtime.sendMessage({ action: 'RESTORE_PROGRESS', progress: progress, restored: restoredTabs, total: totalTabs }).catch(() => {});
                            
                            // Yield to the event loop every few tabs to prevent UI freezing and massive slowdowns
                            if (restoredTabs % 3 === 0) {
                                await new Promise(r => setTimeout(r, 30));
                            }

                        } catch (e) {
                            console.error("Failed to restore tab:", e);
                        }
                    }
                    if (lastTabId) {
                        workspaceActiveTabMap[ws.id] = lastTabId;
                    }
                }
            }
        }
        
        if (mode === 'REPLACE' && oldTabIds.length > 0) {
             if (totalTabs === 0) {
                 // Prevent window from closing if the backup was completely empty
                 const newTab = await browser.tabs.create({ windowId: targetWindowId, active: true });
                 assignTabToWorkspace(newTab.id, workspaces.length > 0 ? workspaces[0].id : 'ws_default');
             }
             
             // Safely close old tabs in small chunks to avoid browser crash
             const chunkSize = 5;
             for (let i = 0; i < oldTabIds.length; i += chunkSize) {
                 const chunk = oldTabIds.slice(i, i + chunkSize);
                 try {
                     await browser.tabs.remove(chunk);
                     await new Promise(r => setTimeout(r, 50));
                 } catch (e) {
                     console.error("Failed to remove old tab chunk:", e);
                 }
             }
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
        
        isRestoringData = false;
        
        if (mode !== 'NO_TABS') {
            browser.runtime.sendMessage({ action: 'RESTORE_PROGRESS', progress: 100, restored: totalTabs, total: totalTabs }).catch(() => {});
        }
        
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
            const tabs = await browser.tabs.query({ currentWindow: true });
            const visibleTabs = tabs.filter(t => !tabsToClose.includes(t.id) && !t.hidden);
            if (visibleTabs.length === 0) {
                const newTab = await browser.tabs.create({ active: true });
                assignTabToWorkspace(newTab.id, currentWorkspaceId);
                workspaceActiveTabMap[currentWorkspaceId] = newTab.id;
            }
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
            // Only count tabs that will remain and are actually visible.
            // If all remaining tabs are hidden, Firefox will close the window!
            const visibleTabs = tabs.filter(t => !tabsToRemove.includes(t.id) && !t.hidden);
            
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

        if (tabsToShow.length === 0) {
            await browser.tabs.create({ active: true });
        } else {
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
        
        if (message.closeTabs) {
            try {
                // User requested to close ALL tabs and wipe the slate clean
                const targetWindowId = message.windowId || (await browser.windows.getCurrent()).id;
                const finalTabs = await browser.tabs.query({ windowId: targetWindowId });
                
                // We must leave at least one tab open so the window doesn't crash
                await browser.tabs.create({ windowId: targetWindowId, active: true });
                
                // Now remove all old tabs safely in chunks
                const finalTabIds = finalTabs.map(t => t.id);
                const chunkSize = 5;
                for (let i = 0; i < finalTabIds.length; i += chunkSize) {
                    const chunk = finalTabIds.slice(i, i + chunkSize);
                    try {
                        await browser.tabs.remove(chunk);
                        await new Promise(r => setTimeout(r, 50));
                    } catch (e) {
                        console.error("Failed to remove all tabs during reset:", e);
                    }
                }
            } catch (e) {
                console.error("Critical error in closeTabs block:", e);
            }
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
        return runWhenReady(async () => {
            isAllTabsMode = true;
            if (currentWorkspaceId) lastActiveWsId = currentWorkspaceId;
            currentWorkspaceId = null;
            await saveState();

            const allTabs = await browser.tabs.query({ currentWindow: true });
            const tabsToShow = [];
            const tabsToHide = [];
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
                    } else {
                        tabsToHide.push(tab.id);
                    }
                } else {
                    tabsToShow.push(tab.id);
                }
            }
            
            if (tabsToShow.length > 0) {
                await browser.tabs.show(tabsToShow);
            }
            if (tabsToHide.length > 0) {
                try { await browser.tabs.hide(tabsToHide); } catch (e) {}
            }
            
            return { success: true, shownCount: tabsToShow.length };
        });
    } else if (message.action === 'GET_LOGS') {
        return { logs: actionLogs };
    } else if (message.action === 'CLEAR_LOGS') {
        actionLogs = [];
        await browser.storage.local.set({ actionLogs });
        return { success: true };
    } else if (message.action === 'UNDO_ACTION') {
        const { logId } = message;
        try {
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
                    try {
                        await switchWorkspace(currentWorkspaceId);
                    } catch (e) {
                        console.error("switchWorkspace failed in UNDO:", e);
                    }
                }
            }
            
            log.isUndone = true;
        }
        
            await browser.storage.local.set({ actionLogs });
            return { success: true, isRedo: isRedo };
        } catch (e) {
            console.error('UNDO_ACTION failed:', e);
            return { success: false, error: e.message };
        }
        
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
    fireCrashRecoverySnapshot();
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

// Frequency is stored as minutes. Older builds stored hours (1,3,6,8,12,24,72,168).
const LEGACY_BACKUP_HOUR_VALUES = new Set([1, 3, 6, 8, 12, 24, 72, 168]);

function resolveBackupPeriodMinutes(freqRaw, freqIsMinutes) {
    const n = parseInt(freqRaw, 10);
    if (!n || n <= 0) return 0;
    if (freqIsMinutes) return n;
    if (LEGACY_BACKUP_HOUR_VALUES.has(n)) return n * 60;
    // New minute options (5/15/30/60/…) saved before the flag existed.
    return n;
}

async function createAutoBackup(reason = 'scheduled') {
    await initReadyPromise;
    const res = await browser.storage.local.get(['autoBackupEnabled', 'autoBackupFrequency', 'autoBackups', 'autoBackupMax', 'autoBackupStorageMax']);
    if (res.autoBackupEnabled === false && reason === 'scheduled') return;
    if (!workspaces || workspaces.length === 0) return;
    
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
    
    const maxBackups = res.autoBackupMax || 1000;
    if (backups.length > maxBackups) {
        backups = backups.slice(backups.length - maxBackups);
    }
    
    // Enforce Max Storage (MB) Limit
    const maxStorageMB = res.autoBackupStorageMax || 200;
    const maxStorageBytes = maxStorageMB * 1024 * 1024;
    
    let currentBytes = new Blob([JSON.stringify(backups)]).size;
    while (currentBytes > maxStorageBytes && backups.length > 1) {
        backups.shift(); // Remove the oldest backup
        currentBytes = new Blob([JSON.stringify(backups)]).size;
    }
    
    await browser.storage.local.set({ autoBackups: backups });
}

async function checkAutoBackupAlarms() {
    if (!browser.alarms) return;

    const res = await browser.storage.local.get(['autoBackupEnabled', 'autoBackupFrequency', 'autoBackupFreqIsMinutes']);
    const isEnabled = res.autoBackupEnabled !== false;
    let periodInMinutes;
    if (res.autoBackupFrequency === undefined || res.autoBackupFrequency === null || res.autoBackupFrequency === '') {
        periodInMinutes = 180; // default 3 hours
    } else {
        periodInMinutes = resolveBackupPeriodMinutes(res.autoBackupFrequency, !!res.autoBackupFreqIsMinutes);
    }
    const existingAlarm = await browser.alarms.get('autoBackupAlarm');

    if (!isEnabled || periodInMinutes <= 0) {
        await browser.alarms.clear('autoBackupAlarm');
        return;
    }

    // Migrate legacy hour values to minutes once, so options UI and alarms stay consistent.
    if (!res.autoBackupFreqIsMinutes && LEGACY_BACKUP_HOUR_VALUES.has(parseInt(res.autoBackupFrequency, 10))) {
        await browser.storage.local.set({
            autoBackupFrequency: periodInMinutes,
            autoBackupFreqIsMinutes: true
        });
    }

    if (!existingAlarm || existingAlarm.periodInMinutes !== periodInMinutes) {
        await browser.alarms.clear('autoBackupAlarm');
        await browser.alarms.create('autoBackupAlarm', {
            delayInMinutes: Math.max(1, periodInMinutes),
            periodInMinutes: Math.max(1, periodInMinutes)
        });
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

checkAutoBackupAlarms();
setTimeout(checkAutoBackupAlarms, 2000);
