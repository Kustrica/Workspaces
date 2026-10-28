
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
    const previousWorkspaceId = tabWorkspaceMap[tabId];
    tabWorkspaceMap[tabId] = workspaceId;
    // 1.18: a tab entering/leaving a workspace changes that workspace's content.
    if (typeof bumpWorkspaceRev === 'function' && previousWorkspaceId !== workspaceId) {
        bumpWorkspaceRev(workspaceId);
        if (previousWorkspaceId) {
            const movedUrl = tabUrlCache[tabId];
            if (movedUrl && typeof recordTabTombstone === 'function') {
                // It is gone from the old workspace on purpose — record it so the peer
                // does not add it back there.
                recordTabTombstone(previousWorkspaceId, movedUrl);
            } else {
                bumpWorkspaceRev(previousWorkspaceId);
            }
        }
    }
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

function applyStorageSnapshot(res, options = {}) {
    if (!res || typeof res !== 'object') return;

    if ('currentWorkspaceId' in res) currentWorkspaceId = res.currentWorkspaceId;
    if (res.tabWorkspaceMap && !options.preserveTabMaps) tabWorkspaceMap = res.tabWorkspaceMap;
    if (res.workspaceActiveTabMap && !options.preserveTabMaps) workspaceActiveTabMap = res.workspaceActiveTabMap;
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
        if (browser.sessions && browser.sessions.getTabValue) {
            try {
                const identity = await browser.sessions.getTabValue(tab.id, 'syncIdentity');
                if (identity && identity.url && (!identity.actualUrl || identity.actualUrl === tab.url || tab.status === 'loading')) {
                    tabIntendedUrl[tab.id] = identity.url;
                    if (identity.settled) settledSyncTabs.add(tab.id);
                }
            } catch (e) { /* sessions unavailable */ }
        }

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

    // Rebuild active-tab memory carefully:
    // NEVER reset every workspace to "first tab in query order" — that made switching back
    // to a workspace jump to its leftmost tab ~every time the background woke and rebuilt.
    // Preserve remembered IDs that still point at open tabs in the same workspace; let the
    // currently active tab win for its workspace; only fill gaps for workspaces with no memory.
    const openTabIds = new Set(tabs.map(t => t.id));
    const rebuiltActiveMap = {};

    for (const [wsId, rawId] of Object.entries(workspaceActiveTabMap || {})) {
        const tabId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
        if (!Number.isFinite(tabId)) continue;
        if (!openTabIds.has(tabId)) continue;
        if (tabWorkspaceMap[tabId] !== wsId) continue;
        rebuiltActiveMap[wsId] = tabId;
    }

    for (const tab of tabs) {
        if (!tab.active) continue;
        const wsId = tabWorkspaceMap[tab.id];
        if (wsId) rebuiltActiveMap[wsId] = tab.id;
    }

    // Gap-fill: prefer most recently accessed tab in that workspace (not leftmost).
    const bestByWs = {};
    for (const tab of tabs) {
        const wsId = tabWorkspaceMap[tab.id];
        if (!wsId || rebuiltActiveMap[wsId]) continue;
        const prev = bestByWs[wsId];
        if (!prev || (tab.lastAccessed || 0) > (prev.lastAccessed || 0)) {
            bestByWs[wsId] = tab;
        }
    }
    for (const [wsId, tab] of Object.entries(bestByWs)) {
        rebuiltActiveMap[wsId] = tab.id;
    }

    workspaceActiveTabMap = rebuiltActiveMap;

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

        // Strictly rely on Firefox native session restore (as in stable commit 8479da3).
        // Remove any remnant crash recovery snapshots so they never cause duplicates or orphan tabs.
        browser.storage.local.remove('crashRecoverySnapshot').catch(() => {});

        // Merge any storage writes that happened while we were loading (sidebar switch, etc.),
        // but preserve the newly rebuilt tabWorkspaceMap and workspaceActiveTabMap.
        while (pendingStoragePatches.length > 0) {
            applyStorageSnapshot(pendingStoragePatches.shift(), { preserveTabMaps: true });
        }
        const fresh = await browser.storage.local.get(STATE_KEYS);
        applyStorageSnapshot(fresh, { preserveTabMaps: true });
        normalizeLoadedWorkspaceSelection();

        await saveState({ force: true });
        updateContextMenus();

        // Soft visibility repair across all normal browser windows — never force-activate on wake (focus steal).
        if (!isAllTabsMode && currentWorkspaceId) {
            try {
                const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
                for (const win of windows) {
                    await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: false, windowId: win.id });
                }
            } catch (e) {
                await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: false });
            }
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
            let tabToActivate = pickBestWorkspaceTabId(
                tabs.filter(t => toShow.includes(t.id)),
                workspaceId,
                [workspaceActiveTabMap[workspaceId]]
            );
            if (tabToActivate) {
                try {
                    await browser.tabs.update(tabToActivate, { active: true });
                    workspaceActiveTabMap[workspaceId] = tabToActivate;
                } catch (e) {}
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

function normalizeTabId(rawId) {
    if (typeof rawId === 'number' && Number.isFinite(rawId)) return rawId;
    const n = parseInt(rawId, 10);
    return Number.isFinite(n) ? n : null;
}

function pickBestWorkspaceTabId(tabs, workspaceId, preferredIds) {
    const preferred = Array.isArray(preferredIds) ? preferredIds : [preferredIds];
    for (const raw of preferred) {
        const id = normalizeTabId(raw);
        if (id == null) continue;
        const tab = tabs.find(t => t.id === id);
        if (tab && tabWorkspaceMap[id] === workspaceId) return id;
    }

    let bestId = null;
    let bestAccessed = -1;
    for (const tab of tabs) {
        if (tabWorkspaceMap[tab.id] !== workspaceId) continue;
        const accessed = tab.lastAccessed || 0;
        if (accessed >= bestAccessed) {
            bestAccessed = accessed;
            bestId = tab.id;
        }
    }
    return bestId;
}

// Switch active workspace
async function switchWorkspace(workspaceId, preserveActiveTab = false, options = {}) {
    if (isSwitchingWorkspace) {
        pendingWorkspaceSwitch = { workspaceId, preserveActiveTab, options };
        return;
    }
    isSwitchingWorkspace = true;

    const windowId = (options && typeof options.windowId === 'number') ? options.windowId : undefined;
    const tabQuery = typeof windowId === 'number' ? { windowId } : { currentWindow: true };
    const activeQuery = typeof windowId === 'number'
        ? { active: true, windowId }
        : { active: true, currentWindow: true };

    try {
    if (currentWorkspaceId) {
        const [currentTab] = await browser.tabs.query(activeQuery);
        if (currentTab) {
            const mapped = resolveExistingWorkspaceId(tabWorkspaceMap[currentTab.id]);
            // Only remember this tab for the workspace we are leaving if it actually belongs there.
            // (A keepVisible group tab / race must not overwrite the real last-active memory.)
            if (mapped === currentWorkspaceId) {
                workspaceActiveTabMap[currentWorkspaceId] = currentTab.id;
            } else if (mapped) {
                workspaceActiveTabMap[mapped] = currentTab.id;
            }
        }
    }
    
    await saveState();

    currentWorkspaceId = workspaceId;
    isAllTabsMode = false;
    if (workspaceId) lastActiveWsId = workspaceId;
    await saveState();
    
    const tabs = await browser.tabs.query(tabQuery);
    
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
            // Unassigned tabs (orphans not in map) must be hidden regardless of visibility.
            // Never adopt visible orphans into current workspace: they may belong to another workspace
            // temporarily revealed via SHOW_ALL_TABS. onCreated and repairVisibility properly assign tabs.
            toHide.push(tab.id);
            continue;
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
        const createOpts = typeof windowId === 'number'
            ? { windowId, active: true }
            : { active: true };
        const newTab = await browser.tabs.create(createOpts);
        toShow.push(newTab.id);
        pendingTabAssignments.add(newTab.id);
        assignTabToWorkspace(newTab.id, currentWorkspaceId);
        pendingTabAssignments.delete(newTab.id);
        rememberTabMeta(newTab);
        workspaceActiveTabMap[currentWorkspaceId] = newTab.id;
    }
    
    saveState();
    
    if (toShow.length > 0) {
        try { await browser.tabs.show(toShow); } catch(e) {}

        let tabToActivate = null;
        const [activeNow] = await browser.tabs.query(activeQuery);
        const activeBelongsHere = activeNow && tabWorkspaceMap[activeNow.id] === workspaceId && toShow.includes(activeNow.id);

        if (!preserveActiveTab || !activeBelongsHere) {
            const remembered = normalizeTabId(workspaceActiveTabMap[workspaceId]);
            tabToActivate = pickBestWorkspaceTabId(
                tabs.filter(t => toShow.includes(t.id)),
                workspaceId,
                [remembered]
            );

            if (tabToActivate && toShow.includes(tabToActivate) && tabWorkspaceMap[tabToActivate] === workspaceId) {
                try {
                    await browser.tabs.update(tabToActivate, { active: true });
                    workspaceActiveTabMap[workspaceId] = tabToActivate;
                } catch(e) {}
            }
        } else if (activeNow) {
            workspaceActiveTabMap[workspaceId] = activeNow.id;
        }
    }

    if (toHide.length > 0) {
        const [activeTab] = await browser.tabs.query(activeQuery);
        if (activeTab && toHide.includes(activeTab.id)) {
            const fallback = pickBestWorkspaceTabId(
                tabs.filter(t => toShow.includes(t.id)),
                workspaceId,
                [workspaceActiveTabMap[workspaceId]]
            );
            if (fallback) {
                try { await browser.tabs.update(fallback, { active: true }); } catch(e) {}
            }
        }

        const [stillActive] = await browser.tabs.query(activeQuery);
        if (stillActive && toHide.includes(stillActive.id)) {
            const idx = toHide.indexOf(stillActive.id);
            if (idx > -1) toHide.splice(idx, 1);
        }
        
        try { await browser.tabs.hide(toHide); } catch(e) {}
    }
    } finally {
        isSwitchingWorkspace = false;
        if (pendingWorkspaceSwitch) {
            const next = pendingWorkspaceSwitch;
            pendingWorkspaceSwitch = null;
            switchWorkspace(next.workspaceId, next.preserveActiveTab, next.options || {});
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
        noteSyncTabUrlAlive(targetWorkspaceId, syncApi() && syncApi().tabSyncIdentity(tab));

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
    }
});

// Keep URL/window cache fresh for crash-recovery snapshots (no await needed on the hot path).
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const previousUrl = tabIntendedUrl[tabId] || tabUrlCache[tabId];
    const navigated = changeInfo.url && (!tabIntendedUrl[tabId] || settledSyncTabs.has(tabId));
    if (navigated && previousUrl && previousUrl !== changeInfo.url && !isRestoringData) {
        const wsId = tabWorkspaceMap[tabId];
        if (wsId) recordTabTombstone(wsId, previousUrl);
        delete tabIntendedUrl[tabId];
        settledSyncTabs.delete(tabId);
        if (browser.sessions && browser.sessions.removeTabValue) {
            browser.sessions.removeTabValue(tabId, 'syncIdentity').catch(() => {});
        }
    }
    if (changeInfo.url || tab.url) {
        tabUrlCache[tabId] = changeInfo.url || tab.url;
    }
    // Keep the requested URL through redirects, including background wake/restart.
    // Only subsequent navigation changes its sync identity.
    if (tabIntendedUrl[tabId] && changeInfo.status === 'complete' && syncApi().isSyncableUrl(tab.url)) {
        settledSyncTabs.add(tabId);
        persistTabSyncIdentity(tabId, tab.url, true);
    }
    if (tab && typeof tab.windowId === 'number') {
        tabWindowMap[tabId] = tab.windowId;
    }
    // Intentional open/navigate after a peer close: stamp birth > tombstone.
    if (!isRestoringData && navigated && typeof noteSyncTabUrlAlive === 'function') {
        const wsId = tabWorkspaceMap[tabId];
        if (wsId) noteSyncTabUrlAlive(wsId, changeInfo.url);
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
    const closedUrl = tabIntendedUrl[tabId] || tabUrlCache[tabId] || null;
    delete tabIntendedUrl[tabId];
    settledSyncTabs.delete(tabId);
    // 1.18: a real close is a fact that must travel to the other devices, otherwise a
    // union merge brings the tab back on the next exchange, forever.
    if (removedWorkspaceId && !(removeInfo && removeInfo.isWindowClosing) &&
        typeof recordTabTombstone === 'function') {
        recordTabTombstone(removedWorkspaceId, closedUrl);
    }
    const windowId = (removeInfo && typeof removeInfo.windowId === 'number')
        ? removeInfo.windowId
        : tabWindowMap[tabId];

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

    // tabWindowMap may be incomplete (temp addon reload, missed events). Also ask the browser
    // which tabs still exist in this window and show them — do not await before create().
    if (typeof windowId === 'number') {
        browser.tabs.query({ windowId }).then((tabs) => {
            const ids = tabs.map(t => t.id).filter(id => id !== tabId);
            if (ids.length === 0) return;
            browser.tabs.show(ids).catch(() => {});
            finishKeepWindowAlive(windowId, ids).catch(() => {});
        }).catch(() => {});
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

    try {
        await switchWorkspace(destination, true, typeof windowId === 'number' ? { windowId } : {});
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

// Restore/import pipeline. Extracted from the RESTORE_DATA message handler (1.14) so the
// Firefox Sync apply path reuses the exact same, already hardened restore flow
// (safety tab, chunked close, explicit windowId, visibility repair) instead of
// reimplementing hide/show races.
async function restoreData(data, mode = 'REPLACE') {
    const { workspaces: newWorkspaces, tabs: tabsData } = data;
        
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
                            if (syncApplyInProgress) {
                                tabIntendedUrl[newTab.id] = url;
                                await persistTabSyncIdentity(newTab.id, newTab.url, newTab.status === 'complete');
                                if (newTab.status === 'complete') settledSyncTabs.add(newTab.id);
                            }
                            await assignTabToWorkspace(newTab.id, ws.id);
                            rememberTabMeta(newTab);
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
        lastActiveWsId = currentWorkspaceId;
        isAllTabsMode = false;
        
        await saveState();
        await browser.storage.local.set({ workspaces, currentWorkspaceId, isAllTabsMode: false, lastActiveWsId }); 
        updateContextMenus();

        // Finish restore flag BEFORE visibility pass so tab listeners behave normally,
        // then hide non-current workspace tabs in the SAME window we restored into.
        // (background scripts have no reliable "currentWindow" — that was why all restored
        // tabs stayed visible in Main until the user manually switched workspaces.)
        isRestoringData = false;
        await switchWorkspace(currentWorkspaceId, true, { windowId: targetWindowId });
        await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: true, windowId: targetWindowId });
        
        await new Promise(r => setTimeout(r, 300));

        try {
            await browser.tabs.remove(safetyTab.id);
        } catch (e) { }
        
        if (mode !== 'NO_TABS') {
            browser.runtime.sendMessage({ action: 'RESTORE_PROGRESS', progress: 100, restored: totalTabs, total: totalTabs }).catch(() => {});
        }
        
        return { success: true };
}

// Message handler
browser.runtime.onMessage.addListener(async (message) => {
    // Firefox Sync actions are handled by the sync controller at the bottom of this file.
    if (message && typeof message.action === 'string' && message.action.startsWith('SYNC_')) {
        return handleSyncMessage(message);
    }
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
        return restoreData(message.data, message.mode || 'REPLACE');
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
const DEFAULT_BACKUP_PERIOD_MINUTES = 60; // 1 hour
const VALID_BACKUP_PERIOD_MINUTES = new Set([5, 15, 30, 60, 180, 360, 480, 720, 1440, 4320, 10080]);

function resolveBackupPeriodMinutes(freqRaw, freqIsMinutes) {
    const n = parseInt(freqRaw, 10);
    if (!n || n <= 0) return 0;
    if (freqIsMinutes) return n;
    if (LEGACY_BACKUP_HOUR_VALUES.has(n)) return n * 60;
    // New minute options (5/15/30/60/…) saved before the flag existed.
    return n;
}

function normalizeBackupPeriodMinutes(freqRaw, freqIsMinutes) {
    const resolved = resolveBackupPeriodMinutes(freqRaw, freqIsMinutes);
    if (resolved > 0 && VALID_BACKUP_PERIOD_MINUTES.has(resolved)) return resolved;
    // Legacy hour value that wasn't flagged, or unknown — fall back to default 1 hour.
    if (!freqIsMinutes && LEGACY_BACKUP_HOUR_VALUES.has(parseInt(freqRaw, 10))) {
        return resolveBackupPeriodMinutes(freqRaw, false);
    }
    return DEFAULT_BACKUP_PERIOD_MINUTES;
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
    if (res.autoBackupEnabled === false || parseInt(res.autoBackupFrequency, 10) === 0) {
        periodInMinutes = 0;
    } else if (res.autoBackupFrequency === undefined || res.autoBackupFrequency === null || res.autoBackupFrequency === '') {
        periodInMinutes = DEFAULT_BACKUP_PERIOD_MINUTES;
    } else {
        periodInMinutes = normalizeBackupPeriodMinutes(res.autoBackupFrequency, !!res.autoBackupFreqIsMinutes);
    }

    // Persist a valid default so the options page always has a matching <option>.
    if (isEnabled && periodInMinutes > 0) {
        const needsWrite = !res.autoBackupFreqIsMinutes
            || res.autoBackupFrequency === undefined
            || res.autoBackupFrequency === null
            || res.autoBackupFrequency === ''
            || parseInt(res.autoBackupFrequency, 10) !== periodInMinutes;
        if (needsWrite) {
            await browser.storage.local.set({
                autoBackupEnabled: true,
                autoBackupFrequency: periodInMinutes,
                autoBackupFreqIsMinutes: true
            });
        }
    }

    const existingAlarm = await browser.alarms.get('autoBackupAlarm');

    if (!isEnabled || periodInMinutes <= 0) {
        await browser.alarms.clear('autoBackupAlarm');
        return;
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

// --- Firefox Sync (browser.storage.sync) — added in 1.14 -------------------------------
//
// Invariants respected here (see .project/context.md):
//   * Remote data is applied ONLY through restoreData(), the existing hardened restore path.
//   * A push never happens while initializing, while restoring, or while a conflict is
//     waiting for the user — so nothing is silently overwritten on either side.
//   * An empty local document never overwrites a non-empty remote one.
//   * No orphan adoption, no extra permissions: storage.sync is part of "storage".

const SYNC_LOCAL_KEYS = [
    'syncEnabled', 'syncDeviceId', 'syncLastSyncAt', 'syncLastPreparedAt', 'syncLastRemoteUpdateAt',
    'syncLastRemoteVersion', 'syncLastTransferStats', 'syncLastFingerprint', 'syncJoined', 'syncPrefs',
    'syncDeviceJoinedAt', 'syncDeviceReceivedAt',
    // 1.18: convergence bookkeeping
    'syncBaseFp', 'syncWsRevs', 'syncTombstones', 'syncWsShape', 'syncLocalChangedAt',
    // 1.19.5: per-URL birth times so a close tombstone is not cleared while the tab is still open
    'syncTabBorn', 'syncBaseDoc'
];
const SYNC_PREPARE_ALARM = 'syncPrepareSnapshot';
const LEGACY_SYNC_PULL_ALARM = 'syncPeriodicPull';
const SYNC_PREPARE_DEBOUNCE_MS = 5000;
const SYNC_DEV_PREFIX = 'sync_dev_';
const SYNC_LEAVE_PREFIX = 'sync_leave_';
const SYNC_LEAVE_FORCE_MS = 7 * 24 * 60 * 60 * 1000;

let syncEnabled = true;            // master toggle, default ON
let syncDeviceId = null;
let syncLastSyncAt = 0;
let syncLastPreparedAt = 0;
let syncLastRemoteUpdateAt = 0;
let syncLastRemoteVersion = null;
let syncDeviceJoinedAt = 0;
let syncDeviceReceivedAt = {};
let syncLastTransferStats = null;
let syncLastFingerprint = null;
let syncJoined = false;
// Fingerprint at the last successful exchange — the point both sides diverged from.
let syncBaseFp = null;
let syncBaseDoc = null;              // local-only common ancestor for multiset reconciliation
let syncWsRevs = {};                 // { wsId: { r, m } }
let syncTombstones = { w: {}, u: {} };
let syncWsShape = {};                // { wsId: { n, c, o } } — rename/reorder detection
// URL birth map: tombKey(wsId, url) → ms. Reopen stamps a newer value to beat a tombstone.
let syncTabBorn = {};
let syncLocalChangedAt = 0;
let syncPrefs = { theme: true, language: true, sidebar: true, uiSettings: true, actionLogs: true };
let syncLastError = null;
let syncLastMessage = null;
let syncStatus = 'idle';           // idle | syncing | join | error | unavailable | waiting
let pendingSyncJoin = null;
let pendingSyncJoinDoc = null;
let syncBusy = false;
let syncApplyInProgress = false;
let syncInitialized = false;
let syncInitPromise = null;
let syncOperationTail = Promise.resolve();

function enqueueSyncOperation(operation) {
    const result = syncOperationTail.then(operation);
    syncOperationTail = result.catch(() => {});
    return result;
}
let syncDeviceLabel = null;

// --- 1.19 safety rails -----------------------------------------------------------------
// A remote document must never be applied silently when it means opening a pile of tabs.
// Duplicate opens are prevented by tabIntendedUrl identity + live planCreations guard —
// not by stopping sync after "same URL N times" (that only fires after flooding already
// started and confuses the user).
const SYNC_SNOOZE_MS = 10 * 60 * 1000;  // "Later" on first-join prompt keeps quiet for this long

// tabId → the URL the sync apply asked for. While a tab is still loading, tab.url is
// about:blank (and after a redirect it differs from what we requested), so without this the
// diff keeps seeing the URL as missing and creates it again on every single cycle — that is
// exactly how 165 tabs became 300+.
const tabIntendedUrl = {};
const settledSyncTabs = new Set();

function persistTabSyncIdentity(tabId, actualUrl, settled = false) {
    if (!browser.sessions || !browser.sessions.setTabValue) return Promise.resolve();
    return browser.sessions.setTabValue(tabId, 'syncIdentity', {
        url: tabIntendedUrl[tabId], actualUrl, settled
    }).catch(() => {});
}
let pendingSyncApply = null;            // { adds, removes, fp, summary }
let pendingSyncApplyDoc = null;
let syncApplySnoozeUntil = 0;

function broadcastSyncApplyProgress(phase, done, total, details = {}) {
    if (!total) return;
    const safeDone = Math.max(0, Math.min(total, done));
    const progress = Math.round((safeDone / total) * 100);
    browser.runtime.sendMessage({
        action: 'SYNC_APPLY_PROGRESS',
        phase,
        done: safeDone,
        total,
        progress,
        ...details
    }).catch(() => {});
}

/** Soft edge pulse + toast in sidebar/options when those pages are open. */
function broadcastSyncBreath(kind, details = {}) {
    if (kind !== 'changed' || details.working || !(details.added > 0 || details.removed > 0)) return;
    const payloadKind = kind === 'quiet' ? 'quiet' : 'changed';
    // Quiet pulses never toast; changed toasts only when the caller wants counts.
    const showToast = payloadKind === 'quiet' ? false : (details.showToast !== false);
    browser.storage.local.get('syncBreathTheme').then((res) => {
        browser.runtime.sendMessage({
            action: 'SYNC_ACTIVITY',
            kind: payloadKind,
            theme: (res && res.syncBreathTheme) || 'orange',
            added: details.added || 0,
            removed: details.removed || 0,
            working: !!details.working,
            showToast
        }).catch(() => {});
    }).catch(() => {
        browser.runtime.sendMessage({
            action: 'SYNC_ACTIVITY',
            kind: payloadKind,
            theme: 'orange',
            added: details.added || 0,
            removed: details.removed || 0,
            working: !!details.working,
            showToast
        }).catch(() => {});
    });
}

function syncApi() {
    return (typeof WorkspacesSync !== 'undefined') ? WorkspacesSync : null;
}

function syncTombstoneFingerprint(value) {
    return syncApi().tombstoneFingerprint(value);
}

function ensureSyncJoinedAt() {
    if (!syncDeviceJoinedAt) syncDeviceJoinedAt = Date.now();
}

function generateDeviceId() {
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
    } catch (e) { /* fall through */ }
    return 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function getSyncState() {
    const api = syncApi();
    return {
        available: !!(api && api.isAvailable()),
        enabled: syncEnabled,
        joined: syncJoined,
        baseFp: syncBaseFp,
        pendingApply: pendingSyncApply,
        localChangedAt: syncLocalChangedAt,
        status: syncStatus,
        lastSyncAt: syncLastSyncAt || 0,
        lastPreparedAt: syncLastPreparedAt || 0,
        lastRemoteUpdateAt: syncLastRemoteUpdateAt || 0,
        lastTransferStats: syncLastTransferStats,
        lastError: syncLastError,
        lastMessage: syncLastMessage,
        deviceId: syncDeviceId,
        deviceLabel: syncDeviceLabel,
        prefs: { ...syncPrefs },
        join: pendingSyncJoin,
        // legacy alias so older options pages still open the join modal
        conflict: pendingSyncJoin
    };
}

function broadcastSyncState() {
    browser.runtime.sendMessage({ action: 'SYNC_STATE_CHANGED', state: getSyncState() }).catch(() => {});
}

function setSyncStatus(status, error = null, message = null) {
    syncStatus = status;
    syncLastError = error;
    if (message !== undefined) syncLastMessage = message;
    broadcastSyncState();
    updateSyncActionBadge().catch(() => {});
}

async function updateSyncActionBadge() {
    try {
        if (!browser.action || !browser.action.setBadgeText) return;
        if (pendingSyncJoin || pendingSyncApply) {
            await browser.action.setBadgeText({ text: '!' });
            await browser.action.setBadgeBackgroundColor({ color: '#ff9400' });
            await browser.action.setTitle({
                title: (typeof getMessage === 'function' && getMessage('syncJoinTitle')) || 'Sync join needed'
            });
        } else if (syncStatus === 'error') {
            await browser.action.setBadgeText({ text: '!' });
            await browser.action.setBadgeBackgroundColor({ color: '#ff5555' });
        } else {
            await browser.action.setBadgeText({ text: '' });
            await browser.action.setTitle({ title: 'Workspaces' });
        }
    } catch (e) { /* badge is best-effort */ }
}

async function persistSyncState() {
    await browser.storage.local.set({
        syncEnabled,
        syncDeviceId,
        syncLastSyncAt,
        syncLastPreparedAt,
        syncLastRemoteUpdateAt,
        syncLastRemoteVersion,
        syncDeviceJoinedAt,
        syncDeviceReceivedAt,
        syncLastTransferStats,
        syncLastFingerprint,
        syncJoined,
        syncBaseFp,
        syncBaseDoc,
        syncWsRevs,
        syncTombstones,
        syncWsShape,
        syncLocalChangedAt,
        syncTabBorn,
        syncPrefs
    });
}

async function resolveDeviceLabel() {
    try {
        const info = await browser.runtime.getPlatformInfo();
        const os = (info && info.os) || 'unknown';
        const pretty = ({ win: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android', cros: 'ChromeOS' })[os] || os;
        // Firefox exposes neither the Sync device name nor the account e-mail to extensions
        // (sessions.getDevices was never implemented — bugzilla 1308059), so two machines on
        // the same OS would otherwise be indistinguishable. A short stable suffix from the
        // device id fixes that without inventing a fake identity. Proper nouns only, so the
        // label needs no translation.
        const suffix = String(syncDeviceId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
        return suffix ? `Firefox · ${pretty} · ${suffix}` : `Firefox · ${pretty}`;
    } catch (e) {
        return 'Firefox';
    }
}

async function writeOwnDeviceRosterEntry(extra = {}) {
    try {
        if (!browser.storage.sync) return;
        if (!syncDeviceLabel) syncDeviceLabel = await resolveDeviceLabel();
        const key = SYNC_DEV_PREFIX + syncDeviceId;
        if (!syncDeviceJoinedAt) {
            const saved = await browser.storage.sync.get(key);
            const previous = saved && saved[key];
            syncDeviceJoinedAt = Number(previous && previous.joinedAt) || 0;
            if (syncDeviceJoinedAt) await browser.storage.local.set({ syncDeviceJoinedAt });
        }
        const entry = {
            id: syncDeviceId,
            label: syncDeviceLabel,
            lastSeen: Date.now(),
            joined: syncJoined,
            joinedAt: syncDeviceJoinedAt,
            fp: syncLastFingerprint,
            xfp: syncBaseDoc ? syncTombstoneFingerprint(syncBaseDoc.x) : null,
            enabled: syncEnabled,
            ...extra
        };
        await browser.storage.sync.set({ [key]: entry });
    } catch (e) { /* roster is best-effort; never block sync */ }
}

async function readDeviceRoster() {
    try {
        if (!browser.storage.sync) return [];
        const all = await browser.storage.sync.get(null);
        const devices = [];
        const leaves = {};
        for (const [key, value] of Object.entries(all || {})) {
            if (key.startsWith(SYNC_LEAVE_PREFIX) && value) {
                leaves[key.slice(SYNC_LEAVE_PREFIX.length)] = value;
            }
        }
        for (const [key, value] of Object.entries(all || {})) {
            if (!key.startsWith(SYNC_DEV_PREFIX) || !value || !value.id) continue;
            const leave = leaves[value.id];
            let status = value.enabled === false ? 'left' : (value.joined ? 'synced' : 'pending_join');
            // A device that switched sync back on after leaving is active again, even if the
            // old leave record has not been cleared yet (older versions never cleared it).
            const rejoinedAfterLeave = leave && leave.state === 'acked' && value.enabled !== false &&
                (value.lastSeen || 0) > (leave.ackedAt || 0);
            if (leave && leave.state === 'pending') status = 'pending_leave';
            if (leave && leave.state === 'acked' && !rejoinedAfterLeave) status = 'left';
            devices.push({
                id: value.id,
                label: value.label || value.id,
                lastSeen: value.lastSeen || 0,
                joinedAt: value.joinedAt || 0,
                joined: !!value.joined,
                enabled: value.enabled !== false,
                xfp: value.xfp || null,
                lastReceivedAt: syncDeviceReceivedAt[value.id] || 0,
                status,
                isSelf: value.id === syncDeviceId,
                leaveRequestedAt: leave && leave.requestedAt
            });
        }
        devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return devices;
    } catch (e) {
        return [];
    }
}

async function processLeaveIntents() {
    try {
        if (!browser.storage.sync || !syncDeviceId) return;
        const key = SYNC_LEAVE_PREFIX + syncDeviceId;
        const res = await browser.storage.sync.get(key);
        const leave = res && res[key];
        if (!leave) return;
        // "Remove now" on another device while this one was offline: the record is already
        // acknowledged on our behalf. Turn sync off here too, but do not publish this stale copy.
        const removedWhileAway = leave.state === 'acked' && leave.forced && leave.by !== syncDeviceId && syncEnabled;
        if (leave.state !== 'pending' && !removedWhileAway) return;

        // Final push optional; then disable sync locally and ack.
        if (!removedWhileAway && syncJoined && syncEnabled) {
            try { await pushSyncNow({ reason: 'leave-final', force: true }); } catch (e) { /* continue */ }
        }
        syncEnabled = false;
        syncJoined = false;
        pendingSyncJoin = null;
        pendingSyncJoinDoc = null;
        await persistSyncState();
        await browser.storage.sync.set({
            [key]: { ...leave, state: 'acked', ackedAt: Date.now(), by: syncDeviceId }
        });
        if (removedWhileAway) {
            // The other device removed us from the list on purpose; stay off it.
            await browser.storage.sync.remove(SYNC_DEV_PREFIX + syncDeviceId);
        } else {
            await writeOwnDeviceRosterEntry({ enabled: false, joined: false });
        }
        setSyncStatus('idle', null, 'LEFT');
    } catch (e) { /* ignore */ }
}


// --- 1.18: local change tracking (revisions + tombstones) -----------------------------
//
// Why this exists: automatic convergence without dialogs needs to know WHAT changed and
// WHETHER a missing tab was deleted or simply never seen. Without it a union merge
// resurrects every closed tab forever, and a timestamp comparison (1.17) always favoured
// the local snapshot, so the two devices just overwrote each other.

let syncMetaPersistTimer = null;
let syncPrepareTimer = null;

function scheduleSyncSnapshotPreparation() {
    if (!syncEnabled || !syncJoined) return;
    if (syncPrepareTimer) clearTimeout(syncPrepareTimer);
    syncPrepareTimer = setTimeout(() => {
        syncPrepareTimer = null;
        runWhenReady(() => enqueueSyncOperation(() => pullSyncNow({ reason: 'local-change' }))).catch(() => {});
    }, SYNC_PREPARE_DEBOUNCE_MS);
}

async function areTombstonesAcknowledged(x) {
    const count = ((x && x.u) || []).length + ((x && x.w) || []).length;
    if (!count) return false;
    const fingerprint = syncTombstoneFingerprint(x);
    const roster = await readDeviceRoster();
    const participants = roster.filter(device => device.joined && device.enabled &&
        device.status !== 'left' && device.status !== 'pending_join');
    return participants.length > 0 && participants.every(device => device.xfp === fingerprint);
}

async function scheduleTombstoneCompactionIfReady(doc) {
    if (!doc || !(await areTombstonesAcknowledged(doc.x))) return;
    runWhenReady(() => enqueueSyncOperation(() => pullSyncNow({ reason: 'tombstones-acknowledged' }))).catch(() => {});
}

function scheduleSyncMetaPersist() {
    if (syncMetaPersistTimer) return;
    syncMetaPersistTimer = setTimeout(() => {
        syncMetaPersistTimer = null;
        browser.storage.local.set({
            syncWsRevs,
            syncTombstones,
            syncWsShape,
            syncLocalChangedAt,
            syncTabBorn
        }).catch(() => {});
    }, 2000);
}

function syncTrackingAllowed() {
    // syncInitialized matters: before the controller has loaded syncWsShape from storage,
    // every existing workspace would look brand new and get a pointless revision bump.
    return syncInitialized && !isInitializingState && !isRestoringData && !syncApplyInProgress;
}

function bumpWorkspaceRev(workspaceId, when) {
    if (!workspaceId || !syncTrackingAllowed()) return;
    const current = syncWsRevs[workspaceId] || { r: 0, m: 0 };
    const stamp = when || Date.now();
    syncWsRevs[workspaceId] = { r: (Number(current.r) || 0) + 1, m: stamp };
    syncLocalChangedAt = stamp;
    scheduleSyncMetaPersist();
    scheduleSyncSnapshotPreparation();
}

function recordTabTombstone(workspaceId, url) {
    const api = syncApi();
    if (!api || !workspaceId || !url || !api.isSyncableUrl(url)) return;
    if (!syncTrackingAllowed()) return;
    if (!syncTombstones || !syncTombstones.u) syncTombstones = api.emptyTombstones();
    const key = api.tombKey(workspaceId, url);
    const prev = syncTombstones.u[key];
    const prevN = (prev && typeof prev === 'object') ? (Number(prev.n) || 0)
        : (prev ? 1 : 0);
    const previousClose = typeof prev === 'object' ? Number(prev.t) || 0 : Number(prev) || 0;
    const stamp = Math.max(Date.now(), previousClose + 1, (Number(syncTabBorn[key]) || 0) + 1);
    syncTombstones.u[key] = { t: stamp, n: prevN + 1 };
    if (syncTabBorn[key]) delete syncTabBorn[key];
    bumpWorkspaceRev(workspaceId);
}

/** User opened/navigated to a URL: reopen clears one close-count for that URL. */
function noteSyncTabUrlAlive(workspaceId, url) {
    const api = syncApi();
    if (!api || !workspaceId || !url || !api.isSyncableUrl(url)) return;
    if (!syncTrackingAllowed()) return;
    const key = api.tombKey(workspaceId, url);
    const tomb = syncTombstones.u && syncTombstones.u[key];
    // A reopen follows the close we have observed, even if device clocks differ.
    const closeTime = typeof tomb === 'object' ? Number(tomb.t) || 0 : Number(tomb) || 0;
    const now = Math.max(Date.now(), closeTime + 1);
    if (tomb) {
        const n = (typeof tomb === 'object') ? (Number(tomb.n) || 0) : 1;
        if (n <= 1) delete syncTombstones.u[key];
        else syncTombstones.u[key] = { t: (tomb.t || now), n: n - 1 };
        syncTabBorn[key] = now;
        scheduleSyncMetaPersist();
        scheduleSyncSnapshotPreparation();
        return;
    }
    if (!syncTabBorn[key]) {
        syncTabBorn[key] = now;
        scheduleSyncMetaPersist();
    }
    scheduleSyncSnapshotPreparation();
}

function adoptSyncTabBornFromDoc(doc) {
    const api = syncApi();
    if (!api || !doc || !doc.t) return;
    for (const [wsId, list] of Object.entries(doc.t)) {
        for (const entry of list || []) {
            const url = typeof entry === 'string' ? entry : entry && entry.u;
            const born = (entry && typeof entry === 'object') ? Number(entry.a) || 0 : 0;
            if (!url || !born) continue;
            const key = api.tombKey(wsId, url);
            const prev = Number(syncTabBorn[key]) || 0;
            if (born > prev) syncTabBorn[key] = born;
        }
    }
}

function recordWorkspaceTombstone(workspaceId) {
    const api = syncApi();
    if (!api || !workspaceId || !syncTrackingAllowed()) return;
    if (!syncTombstones || !syncTombstones.w) syncTombstones = api.emptyTombstones();
    syncTombstones.w[workspaceId] = Date.now();
    delete syncWsRevs[workspaceId];
    syncLocalChangedAt = Date.now();
    scheduleSyncMetaPersist();
    scheduleSyncSnapshotPreparation();
}

// The workspaces array is written by the sidebar too, so renames/reorders/deletions are
// detected by diffing against the last known shape rather than by hooking every call site.
function reconcileWorkspaceShape(list) {
    const api = syncApi();
    if (!api) return;
    const next = {};
    (list || []).forEach((ws, index) => {
        if (!ws || !ws.id) return;
        next[ws.id] = { n: ws.name || '', c: ws.icon || '', o: index };
    });

    if (syncTrackingAllowed()) {
        for (const [id, shape] of Object.entries(next)) {
            const before = syncWsShape[id];
            if (!before) {
                // Newly created here — or re-created after a deletion: drop the tombstone.
                if (syncTombstones.w && syncTombstones.w[id]) delete syncTombstones.w[id];
                bumpWorkspaceRev(id);
            } else if (before.n !== shape.n || before.c !== shape.c || before.o !== shape.o) {
                bumpWorkspaceRev(id);
            }
        }
        for (const id of Object.keys(syncWsShape)) {
            if (!next[id]) recordWorkspaceTombstone(id);
        }
    }

    syncWsShape = next;
    scheduleSyncMetaPersist();
}

function initSyncController() {
    if (!syncInitPromise) syncInitPromise = initSyncControllerInternal();
    return syncInitPromise;
}

async function initSyncControllerInternal() {
    if (syncInitialized) return;

    if (browser.storage.local.remove) {
        await browser.storage.local.remove('syncPrepareFrequencyMinutes').catch(() => {});
    }
    const res = await browser.storage.local.get(SYNC_LOCAL_KEYS);
    syncEnabled = res.syncEnabled !== false;                 // default true
    syncDeviceId = res.syncDeviceId || generateDeviceId();
    syncBaseFp = res.syncBaseFp || null;
    syncBaseDoc = res.syncBaseDoc || null;
    syncWsRevs = res.syncWsRevs || {};
    syncWsShape = res.syncWsShape || {};
    syncLocalChangedAt = res.syncLocalChangedAt || 0;
    syncTabBorn = (res.syncTabBorn && typeof res.syncTabBorn === 'object') ? res.syncTabBorn : {};
    {
        const api = syncApi();
        syncTombstones = api ? api.gcTombstones(res.syncTombstones || api.emptyTombstones())
                             : (res.syncTombstones || { w: {}, u: {} });
    }
    syncLastSyncAt = res.syncLastSyncAt || 0;
    // The legacy timestamp mixed incoming updates with local writes, so it cannot
    // establish when a payload was actually prepared.
    syncLastPreparedAt = res.syncLastPreparedAt || 0;
    syncLastRemoteUpdateAt = res.syncLastRemoteUpdateAt || 0;
    syncLastRemoteVersion = res.syncLastRemoteVersion || null;
    syncDeviceJoinedAt = Number(res.syncDeviceJoinedAt) || 0;
    syncDeviceReceivedAt = (res.syncDeviceReceivedAt && typeof res.syncDeviceReceivedAt === 'object') ? res.syncDeviceReceivedAt : {};
    const hasPreparedTimestamp = Number(res.syncLastPreparedAt) > 0;
    syncLastTransferStats = hasPreparedTimestamp ? (res.syncLastTransferStats || null) : null;
    syncLastFingerprint = res.syncLastFingerprint || null;
    // Migration 1.14 → 1.17: prior successful sync means already in the circle.
    if (typeof res.syncJoined === 'boolean') {
        syncJoined = res.syncJoined;
    } else {
        syncJoined = !!(res.syncLastFingerprint);
    }
    if (res.syncPrefs && typeof res.syncPrefs === 'object') {
        syncPrefs = { ...syncPrefs, ...res.syncPrefs };
        // Migrate 1.17 combined sidebarUi → split sidebar + uiSettings
        if (res.syncPrefs.sidebarUi !== undefined) {
            if (res.syncPrefs.sidebar === undefined) syncPrefs.sidebar = !!res.syncPrefs.sidebarUi;
            if (res.syncPrefs.uiSettings === undefined) syncPrefs.uiSettings = !!res.syncPrefs.sidebarUi;
            delete syncPrefs.sidebarUi;
        }
    }
    syncDeviceLabel = await resolveDeviceLabel();

    if (!res.syncDeviceId || res.syncEnabled === undefined || res.syncJoined === undefined ||
        res.syncLastPreparedAt === undefined) {
        await persistSyncState();
    }

    syncInitialized = true;
    const api = syncApi();
    if (!api || !api.isAvailable()) {
        setSyncStatus('unavailable');
        return;
    }

    await ensureSyncAlarm();
    // Handle a pending leave/removal first, and only announce this device while sync is on:
    // a device that left (or was removed from the list) must not reappear on every startup.
    await processLeaveIntents();
    if (syncEnabled) await writeOwnDeviceRosterEntry();
    if (syncEnabled) {
        enqueueSyncOperation(() => pullSyncNow({ reason: 'startup' })).catch(() => {});
    }
}

async function ensureSyncAlarm() {
    if (!browser.alarms) return;
    try {
        await browser.alarms.clear(LEGACY_SYNC_PULL_ALARM);
        await browser.alarms.clear(SYNC_PREPARE_ALARM);
    } catch (e) { /* Remove legacy polling when alarms are available. */ }
}

// Collect the local document from LIVE state (never from a stale storage snapshot).
async function collectLocalSyncDoc() {
    await initReadyPromise;
    const api = syncApi();
    if (!api) return null;

    const settings = await browser.storage.local.get(api.SYNCED_SETTING_KEYS);
    // Same collection shape as export/import / createAutoBackup.
    const tabsByWorkspace = {};
    for (const ws of workspaces) tabsByWorkspace[ws.id] = [];

    const allTabs = await browser.tabs.query({});
    for (const tab of allTabs) {
        const wsId = tabWorkspaceMap[tab.id];
        if (wsId && tabsByWorkspace[wsId]) {
            const identity = api.tabSyncIdentity(tab, tabIntendedUrl[tab.id]);
            if (!identity || !api.isSyncableUrl(identity)) continue;
            tabsByWorkspace[wsId].push({
                url: identity,
                groupId: tab.groupId !== undefined ? tab.groupId : -1,
                a: syncTabBorn[api.tombKey(wsId, identity)] || 0
            });
        }
    }

    // First run after the 1.18 upgrade: adopt the current shape without pretending
    // everything just changed.
    if (Object.keys(syncWsShape).length === 0 && workspaces.length > 0) {
        syncWsShape = {};
        workspaces.forEach((ws, index) => {
            syncWsShape[ws.id] = { n: ws.name || '', c: ws.icon || '', o: index };
        });
        scheduleSyncMetaPersist();
    }

    const doc = api.buildSyncDoc(workspaces, tabsByWorkspace, settings, syncDeviceId, {
        revs: syncWsRevs,
        tombstones: syncTombstones
    });
    if (syncBaseDoc && syncBaseDoc.g) doc.g = syncBaseDoc.g;
    return doc;
}

// Settings coming from another device. ui_language is applied too (the user asked for
// settings to travel), but nothing here can resurrect tab ids or workspaces.
async function applySyncedSettings(settings) {
    const api = syncApi();
    if (!api || !settings) return;
    const patch = {};
    const current = await browser.storage.local.get(api.SYNCED_SETTING_KEYS);
    for (const key of api.SYNCED_SETTING_KEYS) {
        if (settings[key] === undefined) continue;
        if (key === 'theme' && !syncPrefs.theme) continue;
        // Language is handled below: only a newer explicit choice may replace this device's.
        if (key === 'ui_language' || key === 'ui_language_set_at') continue;
        if (key === 'areActionsVisible' && !syncPrefs.sidebar) continue;
        if (key.startsWith('autoBackup') || key === 'backupOnStartup') {
            if (!syncPrefs.uiSettings) continue;
        }
        if (JSON.stringify(current[key]) !== JSON.stringify(settings[key])) patch[key] = settings[key];
    }
    const remoteChoiceAt = Number(settings.ui_language_set_at) || 0;
    const validLanguage = typeof settings.ui_language === 'string' &&
        /^(auto|[a-z]{2}(_[A-Z]{2})?)$/.test(settings.ui_language);
    if (syncPrefs.language && validLanguage && remoteChoiceAt > (Number(current.ui_language_set_at) || 0)) {
        if (current.ui_language !== settings.ui_language) patch.ui_language = settings.ui_language;
        patch.ui_language_set_at = remoteChoiceAt;
    }
    if (Object.keys(patch).length > 0) {
        await browser.storage.local.set(patch);
    }
}

async function pushSyncNow(options = {}) {
    const api = syncApi();
    if (!api || !api.isAvailable()) return { success: false, error: 'UNAVAILABLE' };
    if (!syncEnabled && !options.force) return { success: false, error: 'DISABLED' };
    if (syncBusy) return { success: false, error: 'BUSY' };

    // Non-members may only seed when the account is empty (options.allowSeed).
    if (!syncJoined && !options.allowSeed && !options.force) {
        return { success: false, error: 'NOT_JOINED' };
    }

    const wasJoined = syncJoined;
    syncBusy = true;
    setSyncStatus('syncing', null, 'WAITING_FIREFOX');
    try {
        const doc = await collectLocalSyncDoc();
        if (!doc) throw new Error('No local document');
        if (options.tombstones) {
            const previousX = doc.x;
            doc.x = api.tombstonesToDoc(options.tombstones);
            if ((previousX.w.length || previousX.u.length) && !doc.x.w.length && !doc.x.u.length) {
                doc.g = { fp: syncTombstoneFingerprint(previousX), ts: Math.max(Date.now(), (doc.g && doc.g.ts || 0) + 1) };
            }
        }

        if (api.isEmptyDoc(doc) && !options.allowEmpty && !(syncJoined && syncBaseDoc)) {
            const remote = await api.readSyncDoc();
            if (remote && remote.doc && !api.isEmptyDoc(remote.doc)) {
                setSyncStatus('idle');
                return { success: false, error: 'LOCAL_EMPTY' };
            }
        }

        // If seeding, refuse to overwrite a remote that appeared meanwhile.
        if (options.allowSeed || !syncJoined) {
            const remote = await api.readSyncDoc();
            if (remote && remote.doc && !api.isEmptyDoc(remote.doc)) {
                setSyncStatus('idle');
                return { success: false, error: 'REMOTE_EXISTS' };
            }
        }

        const meta = await api.writeSyncDoc(doc);
        // Commit compaction only after the complete replacement was written.
        if (options.tombstones) syncTombstones = options.tombstones;
        syncLastFingerprint = meta.fp;
        syncBaseFp = meta.fp;           // Local ancestor; delivery to peers is not confirmed.
        syncBaseDoc = doc;
        syncLastSyncAt = Date.now();
        syncLastPreparedAt = syncLastSyncAt;
        syncLastTransferStats = {
            at: syncLastSyncAt,
            rawBytes: meta.rawBytes || new TextEncoder().encode(JSON.stringify(doc)).length,
            packedBytes: meta.packedBytes || meta.len || 0
        };
        if (!wasJoined) ensureSyncJoinedAt();
        syncJoined = true;
        await persistSyncState();
        await writeOwnDeviceRosterEntry();
        await scheduleTombstoneCompactionIfReady(doc);
        setSyncStatus('idle', null, 'WAITING_FIREFOX');
        return {
            success: true,
            summary: api.summarize(doc),
            lastSyncAt: syncLastSyncAt,
            message: 'WAITING_FIREFOX'
        };
    } catch (e) {
        const code = e && e.code ? e.code : 'WRITE_FAILED';
        setSyncStatus('error', code);
        return { success: false, error: code, message: e && e.message };
    } finally {
        syncBusy = false;
    }
}

function raiseJoinPrompt(localDoc, remoteDoc, remoteMeta) {
    const api = syncApi();
    pendingSyncJoinDoc = remoteDoc;
    pendingSyncJoin = {
        local: api.summarize(localDoc),
        remote: api.summarize(remoteDoc),
        remoteTs: (remoteMeta && remoteMeta.ts) || remoteDoc.ts || 0,
        remoteDev: (remoteMeta && remoteMeta.dev) || remoteDoc.dev || null
    };
    setSyncStatus('join');
    browser.runtime.sendMessage({
        action: 'SYNC_JOIN',
        join: pendingSyncJoin,
        conflict: pendingSyncJoin // legacy alias for options page
    }).catch(() => {});
    return { success: true, action: 'JOIN', join: pendingSyncJoin, conflict: pendingSyncJoin };
}

async function pullSyncNow(options = {}) {
    const api = syncApi();
    if (!api || !api.isAvailable()) return { success: false, error: 'UNAVAILABLE' };
    if (!syncEnabled && !options.force) return { success: false, error: 'DISABLED' };
    if (syncBusy) return { success: false, error: 'BUSY' };

    await processLeaveIntents();

    // An apply is waiting for the user's answer: keep showing it instead of re-diffing
    // hundreds of tabs on every cycle.
    if (pendingSyncApply && !options.confirmed && !options.force) {
        setSyncStatus('apply-prompt');
        return { success: false, error: 'APPLY_PENDING', pendingApply: pendingSyncApply };
    }

    // Pending join on THIS device: keep surfacing it; do not freeze other logic forever.
    if (pendingSyncJoin && !options.force && !options.resolution) {
        setSyncStatus('join');
        return { success: false, error: 'JOIN_PENDING', join: pendingSyncJoin, conflict: pendingSyncJoin };
    }

    syncBusy = true;
    setSyncStatus('syncing');
    try {
        const remote = await api.readSyncDoc();
        const remoteDoc = remote && remote.doc;
        const remoteMeta = (remote && remote.meta) || null;
        const localDoc = await collectLocalSyncDoc();
        const localFp = api.dataFingerprint(localDoc);

        // Account empty → this device may seed (first writer into an empty account).
        if (!remoteDoc) {
            syncBusy = false;
            if (localDoc && !api.isEmptyDoc(localDoc)) {
                return await pushSyncNow({ reason: 'seed', allowSeed: true });
            }
            setSyncStatus('idle');
            return { success: true, action: 'NOOP_EMPTY_BOTH' };
        }

        const remoteFp = (remoteMeta && remoteMeta.fp) || api.dataFingerprint(remoteDoc);

        const remoteVersion = remoteMeta && remoteMeta.dev
            ? JSON.stringify([remoteMeta.dev, remoteMeta.ts || remoteDoc.ts || 0, remoteFp])
            : null;
        if (remoteMeta && remoteMeta.dev && remoteMeta.dev !== syncDeviceId &&
            remoteVersion !== syncLastRemoteVersion) {
            syncLastRemoteUpdateAt = Date.now();
            syncLastRemoteVersion = remoteVersion;
            syncDeviceReceivedAt[remoteMeta.dev] = syncLastRemoteUpdateAt;
            await persistSyncState();
            broadcastSyncState();
        }

        // Reading the same local storage copy is not another successful transfer.
        if (syncJoined && syncBaseFp === remoteFp && remoteFp === localFp &&
            JSON.stringify(syncBaseDoc) === JSON.stringify(remoteDoc) &&
            JSON.stringify(localDoc.x || { w: [], u: [] }) === JSON.stringify(remoteDoc.x || { w: [], u: [] }) &&
            JSON.stringify(localDoc.s || {}) === JSON.stringify(remoteDoc.s || {})) {
            if (await areTombstonesAcknowledged(remoteDoc.x)) {
                syncBusy = false;
                return await pushSyncNow({ reason: 'tombstone-compaction', tombstones: api.emptyTombstones() });
            }
            setSyncStatus('idle', null, syncLastMessage);
            return { success: true, action: 'IN_SYNC' };
        }

        // Identical data
        if (remoteFp === localFp) {
            // URL/workspace fingerprints intentionally exclude deletion history. Still
            // converge and expire that history when the live tabs are already identical,
            // otherwise old close records can occupy quota forever without another tab edit.
            let mergedTombstones = api.gcTombstones(api.mergeDocTombstones(localDoc, remoteDoc, syncBaseDoc));
            const currentX = api.tombstonesToDoc(mergedTombstones);
            if (await areTombstonesAcknowledged(currentX)) mergedTombstones = api.emptyTombstones();
            const compactTombstones = api.tombstonesToDoc(mergedTombstones);
            if (JSON.stringify(compactTombstones) !== JSON.stringify(remoteDoc.x || { w: [], u: [] })) {
                syncBusy = false;
                return await pushSyncNow({ reason: 'tombstone-maintenance', tombstones: mergedTombstones });
            }
            syncTombstones = mergedTombstones;
            if (localDoc.g && (!remoteDoc.g || localDoc.g.ts > remoteDoc.g.ts)) {
                syncBusy = false;
                return await pushSyncNow({ reason: 'compaction-receipt', tombstones: mergedTombstones });
            }

            const settings = { ...(remoteDoc.s || {}) };
            if (syncBaseDoc) {
                for (const [key, value] of Object.entries(localDoc.s || {})) {
                    if (JSON.stringify(value) !== JSON.stringify((syncBaseDoc.s || {})[key])) settings[key] = value;
                }
            }
            await applySyncedSettings(settings);
            if (JSON.stringify(settings) !== JSON.stringify(remoteDoc.s || {})) {
                syncBusy = false;
                return await pushSyncNow({ reason: 'local-settings' });
            }
            syncLastFingerprint = remoteFp;
            syncBaseFp = remoteFp;
            syncBaseDoc = remoteDoc;
            syncLastSyncAt = Date.now();
            if (!syncJoined) {
                ensureSyncJoinedAt();
                syncJoined = true;
            }
            await persistSyncState();
            await writeOwnDeviceRosterEntry();
            await scheduleTombstoneCompactionIfReady(remoteDoc);
            setSyncStatus('idle');
            // An unchanged document must never trigger a breathing pulse.
            return { success: true, action: 'IN_SYNC' };
        }

        const localEmpty = api.isEmptyDoc(localDoc) || api.isPristineDefaultDoc(localDoc);
        const remoteEmpty = api.isEmptyDoc(remoteDoc);

        // --- Not yet a member of the sync circle ---
        if (!syncJoined) {
            if (remoteEmpty && !localEmpty) {
                syncBusy = false;
                return await pushSyncNow({ reason: 'seed', allowSeed: true });
            }
            if (!remoteEmpty) {
                // One-time join on THIS device only. Never push over the account copy.
                if (localEmpty) {
                    // Fresh / pristine device adopting the account copy — always ask once
                    // (Sync now / Later / Turn off). Day-to-day member sync never uses this
                    // dialog; that was the user's complaint about the old ">15 tabs" gate.
                    syncBusy = false;
                    return await applySyncedDocIncremental(remoteDoc, 'join-adopt', {
                        requireConsent: true
                    });
                }
                // Local has real data + remote exists → ask once (Replace or Merge).
                return raiseJoinPrompt(localDoc, remoteDoc, remoteMeta);
            }
            setSyncStatus('idle');
            return { success: true, action: 'NOOP' };
        }

        // --- Established member: silent automatic convergence, no dialogs ever ---------
        //
        // 1.17 compared remoteDoc.ts with localDoc.ts. localDoc.ts is Date.now() at collect
        // time, so "local is newer" was always true and every device overwrote the account
        // with itself — data never crossed. The comparison is now against syncBaseFp, the
        // last locally published/applied fingerprint, with explicit close reconciliation.

        const decision = api.decideSync({
            hasRemote: true,
            joined: true,
            localEmpty,
            remoteEmpty,
            localFp,
            remoteFp,
            baseFp: syncBaseFp
        });

        // Even a fast-forward must reconcile explicit operations: a published local
        // base is not proof that the peer received it before publishing its own copy.

        // Only we moved → publish.
        if (decision === 'PUSH') {
            syncBusy = false;
            return await pushSyncNow({ reason: 'local-ahead' });
        }

        // Both moved (or we have no common ancestor yet, e.g. right after the 1.17 upgrade)
        // → real merge: revisions decide renames, tombstones decide deletions, tab lists are
        // unioned. Then publish the result so the peer converges on the same document.
        const merged = api.mergeDocs(localDoc, remoteDoc,
            syncBaseDoc && api.dataFingerprint(syncBaseDoc) === syncBaseFp ? syncBaseDoc : null);
        syncBusy = false;
        const applied = await applySyncedDocIncremental(merged, 'merge');
        if (!applied.success) return applied;
        // The apply may be waiting for the user's confirmation. Publishing the local document
        // now would overwrite the account and delete the peer's tabs from it.
        if (applied.action === 'APPLY_PROMPT') {
            pendingSyncApplyDoc = merged;
            return applied;
        }
        const pushed = await pushSyncNow({ reason: 'merge-push' });
        return {
            success: pushed.success,
            action: 'MERGED',
            applied,
            pushed,
            summary: api.summarize(merged)
        };
    } catch (e) {
        const code = e && e.code ? e.code : 'READ_FAILED';
        if (code === 'INCOMPLETE') {
            // Per-key conflicts may temporarily mix slot contents. Only the author
            // named by the winning meta may repair it from its durable snapshot.
            if (e.meta && e.meta.dev === syncDeviceId && syncBaseDoc &&
                api.dataFingerprint(syncBaseDoc) === e.meta.fp) {
                const candidate = await api.pack(syncBaseDoc, e.meta.gen);
                if (candidate.meta.digest === e.meta.digest) {
                    const repaired = await api.writeSyncDoc(syncBaseDoc);
                    syncLastFingerprint = repaired.fp;
                    setSyncStatus('idle', null, 'WAITING_FIREFOX');
                    return { success: true, action: 'REPAIRED', message: 'WAITING_FIREFOX' };
                }
            }
            setSyncStatus('waiting', null, 'WAITING_FIREFOX');
            return { success: false, error: 'INCOMPLETE' };
        }
        setSyncStatus('error', code);
        return { success: false, error: code, message: e && e.message };
    } finally {
        syncBusy = false;
    }
}

// Join resolutions: 'REMOTE' (replace) | 'MERGE'. 'LOCAL' kept for legacy but only marks
// joined after pushing when account was empty — members must not overwrite via LOCAL join.
async function resolveSyncConflict(resolution, remoteDocInput = null, localDocInput = null) {
    const api = syncApi();
    if (!api) return { success: false, error: 'UNAVAILABLE' };

    const remoteDoc = remoteDocInput || pendingSyncJoinDoc;
    if (!remoteDoc && resolution !== 'LOCAL') {
        return { success: false, error: 'NO_REMOTE_DOC' };
    }

    pendingSyncJoin = null;
    pendingSyncJoinDoc = null;
    await updateSyncActionBadge();

    if (resolution === 'LOCAL') {
        // Joining device keeping local only: push after join mark (overwrites account).
        // Allowed only as explicit "use this device as the new source" during join.
        syncJoined = true;
        await persistSyncState();
        const pushed = await pushSyncNow({ reason: 'join-local', force: true });
        await writeOwnDeviceRosterEntry();
        return pushed;
    }

    if (resolution === 'REMOTE') {
        const applied = await applySyncedDoc(remoteDoc, 'REPLACE', 'join-remote');
        if (applied.success) {
            syncJoined = true;
            await persistSyncState();
            await writeOwnDeviceRosterEntry();
            await pushSyncNow({ reason: 'join-remote-ack', force: true });
        }
        return applied;
    }

    if (resolution === 'MERGE') {
        const localDoc = localDocInput || await collectLocalSyncDoc();
        const merged = api.mergeDocs(localDoc, remoteDoc);
        // Prefer icon from the side with more tabs when names collide (mergeDocs handles name).
        const applied = await applySyncedDoc(merged, 'MERGE', 'join-merge');
        if (!applied.success) return applied;
        syncJoined = true;
        await persistSyncState();
        await writeOwnDeviceRosterEntry();
        return await pushSyncNow({ reason: 'join-merge-push', force: true });
    }

    return { success: false, error: 'UNKNOWN_RESOLUTION' };
}

// Routine convergence applies only the difference. A full REPLACE would close and
// recreate every tab on every remote edit — unusable on a 160-tab profile.
//
// 1.19 hardening after the field report ("tabs just kept opening, 165 → 300+, all of them
// in Main, with no indication"):
//   * the apply runs with isRestoringData set, so tabs.onCreated does NOT re-resolve the
//     workspace of the tabs we create (that was why everything landed in Main, and why the
//     next cycle still saw them missing from the target workspace and opened them AGAIN);
//   * a tab keeps its requested URL as identity while it loads (tabIntendedUrl);
//   * first join (requireConsent) asks once before opening the account session;
//     established members converge silently — no ">N tabs" nag on every pull;
//   * progress is broadcast so the sidebar and the options page can show it.
async function applySyncedDocIncremental(targetDoc, reason = 'remote', options = {}) {
    const api = syncApi();
    if (!api || !targetDoc) return { success: false, error: 'NO_DOC' };

    const joinedBeforeApply = syncJoined;
    const localDoc = await collectLocalSyncDoc();
    const diff = api.docDiff(localDoc, targetDoc);

    const finish = async () => {
        for (const ws of targetDoc.ws || []) {
            const rev = { r: Number(ws.r) || 0, m: Number(ws.m) || 0 };
            const mine = syncWsRevs[ws.i] || { r: 0, m: 0 };
            syncWsRevs[ws.i] = (rev.r >= (Number(mine.r) || 0)) ? rev : mine;
        }
        syncTombstones = api.gcTombstones(api.tombstonesFromDoc(targetDoc));
        adoptSyncTabBornFromDoc(targetDoc);
        syncBaseFp = api.dataFingerprint(targetDoc);
        syncBaseDoc = targetDoc;
        syncLastFingerprint = syncBaseFp;
        syncLastSyncAt = Date.now();
        if (!joinedBeforeApply) ensureSyncJoinedAt();
        syncJoined = true;
        pendingSyncApply = null;
        pendingSyncApplyDoc = null;
        await persistSyncState();
        await writeOwnDeviceRosterEntry();
        await scheduleTombstoneCompactionIfReady(targetDoc);
        setSyncStatus('idle');
    };

    if (!diff.changed) {
        await applySyncedSettings(targetDoc.s);
        await finish();
        broadcastSyncBreath('quiet', { added: 0, removed: 0, showToast: false });
        return { success: true, action: 'NO_CHANGES', reason };
    }

    // --- First join only: never open another device's session without asking ----------
    if (options.requireConsent && !options.confirmed) {
        if (Date.now() < syncApplySnoozeUntil) {
            return { success: false, error: 'SNOOZED', pendingApply: pendingSyncApply };
        }
        pendingSyncApplyDoc = targetDoc;
        pendingSyncApply = {
            adds: diff.tabsAdd.length,
            removes: diff.tabsRemove.length,
            workspaces: (targetDoc.ws || []).length,
            fp: api.dataFingerprint(targetDoc),
            reason,
            firstJoin: true
        };
        setSyncStatus('apply-prompt');
        await updateSyncActionBadge();
        browser.runtime.sendMessage({
            action: 'SYNC_APPLY_PROMPT',
            pendingApply: pendingSyncApply
        }).catch(() => {});
        return { success: true, action: 'APPLY_PROMPT', pendingApply: pendingSyncApply };
    }

    setSyncStatus('syncing');
    syncApplyInProgress = true;
    // tabs.onCreated / onRemoved / onActivated all bail out on this flag — exactly what the
    // import path relies on. Without it our own created tabs get re-assigned to the current
    // workspace by the new-tab resolver.
    const previousRestoringFlag = isRestoringData;
    isRestoringData = true;
    const wasAllTabsMode = isAllTabsMode;
    const totalSteps = diff.tabsAdd.length + diff.tabsRemove.length;
    let doneSteps = 0;
    let created = 0;
    let removed = 0;
    let failedCreates = 0;
    let creationTotal = 0;
    let closingTotal = 0;

    broadcastSyncBreath('changed', { working: true, showToast: true });

    try {
        await applySyncedSettings(targetDoc.s);

        const targetWindow = await browser.windows.getCurrent().catch(() => null);
        const targetWindowId = targetWindow ? targetWindow.id : undefined;

        // 1. Workspace list: upsert, delete, then reorder exactly as the target says.
        const order = new Map((targetDoc.ws || []).map((ws, index) => [ws.i, index]));
        const byId = new Map(workspaces.map((ws) => [ws.id, ws]));
        for (const up of diff.workspacesUpsert) {
            const existing = byId.get(up.id);
            if (existing) {
                existing.name = up.name;
                if (up.icon) existing.icon = up.icon;
            } else {
                const created = { id: up.id, name: up.name, icon: up.icon || 'img:icons/main-64.png' };
                workspaces.push(created);
                byId.set(up.id, created);
            }
        }
        if (diff.workspaceIdsRemove.length > 0) {
            const removeSet = new Set(diff.workspaceIdsRemove);
            workspaces = workspaces.filter((ws) => !removeSet.has(ws.id));
        }
        workspaces.sort((a, b) => {
            const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
            const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        // Workspaces must exist before any tab is assigned to them.
        await browser.storage.local.set({ workspaces });

        // 2. Which open tabs must go — one remove row closes one matching URL (multiset).
        const closeQueue = []; // { wsId, url }
        for (const row of diff.tabsRemove) {
            if (!row.url) continue;
            closeQueue.push({ wsId: row.wsId, url: row.url });
            const bornKey = api.tombKey(row.wsId, row.url);
            if (syncTabBorn[bornKey]) delete syncTabBorn[bornKey];
        }
        const tabIdsToClose = [];
        if (closeQueue.length > 0) {
            const allTabs = await browser.tabs.query({});
            const candidates = allTabs.map((tab) => ({
                id: tab.id,
                wsId: tabWorkspaceMap[tab.id],
                url: api.tabSyncIdentity(tab, tabIntendedUrl[tab.id])
            })).filter((t) => t.wsId && t.url);

            for (const need of closeQueue) {
                const idx = candidates.findIndex((t) =>
                    t.wsId === need.wsId && t.url === need.url);
                if (idx < 0) continue;
                tabIdsToClose.push(candidates[idx].id);
                candidates.splice(idx, 1);
            }
        }
        closingTotal = tabIdsToClose.length;

        // 3. Create missing tabs — export-style: N rows with the same URL → N creates.
        const existingCounts = new Map();
        {
            const allTabs = await browser.tabs.query({});
            for (const tab of allTabs) {
                const wsId = tabWorkspaceMap[tab.id];
                if (!wsId) continue;
                const identity = api.tabSyncIdentity(tab, tabIntendedUrl[tab.id]);
                if (!identity) continue;
                const key = api.identityKey(wsId, identity);
                existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
            }
        }

        // planCreations expects the desired full multiset, not a delta that has
        // already subtracted local tabs. Re-diff the live state to cover new arrivals.
        const desiredAdds = [];
        for (const ws of targetDoc.ws || []) {
            for (const row of (targetDoc.t && targetDoc.t[ws.i]) || []) {
                desiredAdds.push({ wsId: ws.i, url: api.urlOf(row), groupId: typeof row === 'object' ? row.g : -1 });
            }
        }
        const creationPlan = api.planCreations(desiredAdds, existingCounts);
        creationTotal = creationPlan.length;
        doneSteps = (diff.tabsAdd.length - creationTotal) + (diff.tabsRemove.length - closingTotal);

        const initialPhase = creationTotal > 0 ? 'creating' : 'closing';
        broadcastSyncApplyProgress(initialPhase, doneSteps, totalSteps, {
            phaseDone: 0,
            phaseTotal: creationTotal > 0 ? creationTotal : closingTotal
        });
        for (const add of creationPlan) {
            try {
                const tab = await browser.tabs.create({
                    windowId: targetWindowId,
                    url: add.url,
                    active: false
                });
                tabIntendedUrl[tab.id] = add.url;
                const settled = tab.status === 'complete' && api.isSyncableUrl(tab.url);
                await persistTabSyncIdentity(tab.id, tab.url, settled);
                if (settled) settledSyncTabs.add(tab.id);
                await assignTabToWorkspace(tab.id, add.wsId);
                rememberTabMeta(tab);
                noteSyncTabUrlAlive(add.wsId, add.url);
                const key = api.identityKey(add.wsId, add.url);
                existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
                created++;
            } catch (e) {
                failedCreates++;
            }
            doneSteps = (diff.tabsAdd.length - creationTotal) + (diff.tabsRemove.length - closingTotal) + created + removed;
            broadcastSyncApplyProgress('creating', doneSteps, totalSteps, {
                phaseDone: created,
                phaseTotal: creationTotal
            });
        }

        // 4. Close the departed tabs — never leaving the current workspace with nothing
        //    visible in this window (Firefox destroys a window with zero visible tabs).
        if (tabIdsToClose.length > 0) {
            const closing = new Set(tabIdsToClose);
            const liveTabs = await browser.tabs.query({});
            const affectedWindows = new Set(liveTabs.filter(tab => closing.has(tab.id)).map(tab => tab.windowId));
            const safetyWorkspace = resolveExistingWorkspaceId(currentWorkspaceId) || getFallbackWorkspaceId();
            for (const windowId of affectedWindows) {
                const visibleSurvivor = liveTabs.some(tab => tab.windowId === windowId && !closing.has(tab.id) && !tab.hidden);
                if (!visibleSurvivor) {
                    // Guarantee one visible survivor in EACH window before any close.
                    const keepAlive = await browser.tabs.create({ windowId, active: true });
                    if (safetyWorkspace) await assignTabToWorkspace(keepAlive.id, safetyWorkspace);
                    rememberTabMeta(keepAlive);
                }
            }
            const chunkSize = 5;
            let closedIds = 0;
            broadcastSyncApplyProgress('closing', doneSteps, totalSteps, {
                phaseDone: 0,
                phaseTotal: closingTotal
            });
            for (let i = 0; i < tabIdsToClose.length; i += chunkSize) {
                const chunk = tabIdsToClose.slice(i, i + chunkSize);
                try {
                    await browser.tabs.remove(chunk);
                    for (const id of chunk) {
                        unassignTab(id);
                        delete tabIntendedUrl[id];
                        settledSyncTabs.delete(id);
                    }
                    closedIds += chunk.length;
                    await new Promise((r) => setTimeout(r, 40));
                } catch (e) {
                    // A rejected batch can still have closed some tabs. Count only IDs
                    // that are actually gone; the remaining work must stay visible.
                    try {
                        const live = await browser.tabs.query({});
                        const liveIds = new Set(live.map((tab) => tab.id));
                        const actuallyClosed = chunk.filter((id) => !liveIds.has(id));
                        for (const id of actuallyClosed) {
                            unassignTab(id);
                            delete tabIntendedUrl[id];
                            settledSyncTabs.delete(id);
                        }
                        closedIds = tabIdsToClose.filter((id) => !liveIds.has(id)).length;
                    } catch (_) { /* leave the count unchanged when the live state is unknown */ }
                }
                removed = closedIds;
                doneSteps = (diff.tabsAdd.length - creationTotal) + (diff.tabsRemove.length - closingTotal) + created + removed;
                broadcastSyncApplyProgress('closing', doneSteps, totalSteps, {
                    phaseDone: removed,
                    phaseTotal: closingTotal
                });
            }
        }

        // 5. Persist and repair visibility across every normal window.
        currentWorkspaceId = resolveExistingWorkspaceId(currentWorkspaceId) || getFallbackWorkspaceId();
        lastActiveWsId = currentWorkspaceId;
        // A sync apply must never flip the view into All Tabs mode by itself.
        isAllTabsMode = wasAllTabsMode;
        await browser.storage.local.set({ workspaces, currentWorkspaceId, isAllTabsMode });
        await saveState({ force: true });
        updateContextMenus();

        broadcastSyncApplyProgress('arranging', doneSteps, totalSteps, {
            phaseDone: doneSteps,
            phaseTotal: totalSteps
        });

        if (!isAllTabsMode && currentWorkspaceId) {
            try {
                const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
                for (const win of windows) {
                    await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: false, windowId: win.id });
                }
            } catch (e) {
                await repairWorkspaceVisibility(currentWorkspaceId, { allowActivate: false, windowId: targetWindowId });
            }
        }

        if (created > 0 || tabIdsToClose.length > 0 || diff.workspaceIdsRemove.length > 0) {
            const summary = api.summarize(targetDoc);
            addLog('SYNC_APPLIED', `i18n:logDetailsSyncApplied:${summary.workspaces}:${summary.tabs}`);
            await browser.storage.local.set({ actionLogs });
        }

        if (failedCreates || removed !== tabIdsToClose.length) throw new Error('Incomplete sync tab apply');
        await finish();
        broadcastSyncApplyProgress('done', doneSteps, totalSteps, {
            phaseDone: totalSteps,
            phaseTotal: totalSteps
        });
        await updateSyncActionBadge();
        const didChange = created > 0 || removed > 0;
        broadcastSyncBreath(didChange ? 'changed' : 'quiet', {
            added: created,
            removed,
            showToast: didChange
        });
        return {
            success: true,
            action: 'APPLIED_INCREMENTAL',
            reason,
            added: created,
            removed: tabIdsToClose.length,
            workspacesChanged: diff.workspacesUpsert.length + diff.workspaceIdsRemove.length
        };
    } catch (e) {
        setSyncStatus('error', 'APPLY_FAILED');
        broadcastSyncApplyProgress('error', doneSteps, totalSteps, {
            phaseDone: doneSteps,
            phaseTotal: totalSteps,
            failed: Math.max(0, totalSteps - doneSteps)
        });
        return { success: false, error: 'APPLY_FAILED', message: e && e.message };
    } finally {
        isRestoringData = previousRestoringFlag;
        syncApplyInProgress = false;
    }
}

async function applySyncedDoc(doc, mode = 'REPLACE', reason = 'remote') {
    // Join targets are already resolved (remote or merged). Reuse the incremental
    // multiset apply; restore/import MERGE would add the whole session twice.
    return applySyncedDocIncremental(doc, reason, { confirmed: true });
}

async function setSyncEnabled(enabled) {
    syncEnabled = !!enabled;
    await persistSyncState();
    await ensureSyncAlarm();

    if (!syncEnabled) {
        pendingSyncJoin = null;
        pendingSyncJoinDoc = null;
        pendingSyncApply = null;
        pendingSyncApplyDoc = null;
        syncApplySnoozeUntil = 0;
        await writeOwnDeviceRosterEntry({ enabled: false });
        setSyncStatus('idle');
        return { success: true, enabled: false };
    }

    setSyncStatus('idle');
    // Rejoining: turning sync back on here overrides an earlier leave or removal record.
    try {
        if (browser.storage.sync && syncDeviceId) await browser.storage.sync.remove(SYNC_LEAVE_PREFIX + syncDeviceId);
    } catch (e) { /* best-effort */ }
    await writeOwnDeviceRosterEntry({ enabled: true });
    const result = await pullSyncNow({ reason: 'enabled' });
    return { success: true, enabled: true, pull: result };
}

async function requestDeviceLeave(targetDeviceId, options = {}) {
    if (!targetDeviceId) return { success: false, error: 'NO_TARGET' };
    if (targetDeviceId === syncDeviceId) {
        // Leave self immediately.
        syncEnabled = false;
        syncJoined = false;
        pendingSyncJoin = null;
        pendingSyncJoinDoc = null;
        await persistSyncState();
        await ensureSyncAlarm();
        try {
            await browser.storage.sync.set({
                [SYNC_LEAVE_PREFIX + syncDeviceId]: {
                    state: 'acked',
                    requestedAt: Date.now(),
                    ackedAt: Date.now(),
                    by: syncDeviceId
                }
            });
        } catch (e) { /* ignore */ }
        await writeOwnDeviceRosterEntry({ enabled: false, joined: false });
        setSyncStatus('idle', null, 'LEFT');
        return { success: true, self: true };
    }

    try {
        await browser.storage.sync.set({
            [SYNC_LEAVE_PREFIX + targetDeviceId]: {
                state: 'pending',
                requestedAt: Date.now(),
                by: syncDeviceId
            }
        });
        return { success: true, pending: true };
    } catch (e) {
        return { success: false, error: 'LEAVE_WRITE_FAILED' };
    }
}

async function forceRemoveDevice(targetDeviceId) {
    try {
        const leaveKey = SYNC_LEAVE_PREFIX + targetDeviceId;
        const devKey = SYNC_DEV_PREFIX + targetDeviceId;
        await browser.storage.sync.set({
            [leaveKey]: {
                state: 'acked',
                requestedAt: Date.now(),
                ackedAt: Date.now(),
                by: syncDeviceId,
                forced: true
            }
        });
        await browser.storage.sync.remove(devKey);
        return { success: true };
    } catch (e) {
        return { success: false, error: 'FORCE_REMOVE_FAILED' };
    }
}

// Remove a device whose sync is already off from the roster list. Nothing is sent to it:
// if sync is switched on there again, it simply registers itself again.
async function forgetDevice(targetDeviceId) {
    if (!targetDeviceId || targetDeviceId === syncDeviceId) return { success: false, error: 'NO_TARGET' };
    try {
        await browser.storage.sync.remove(SYNC_DEV_PREFIX + targetDeviceId);
        return { success: true };
    } catch (e) {
        return { success: false, error: 'FORGET_FAILED' };
    }
}

// Sync-area changes from other devices (payload or leave intents / roster).
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const api = syncApi();
    if (!api) return;

    const leaveKey = SYNC_LEAVE_PREFIX + syncDeviceId;
    if (Object.prototype.hasOwnProperty.call(changes, leaveKey)) {
        runWhenReady(() => enqueueSyncOperation(() => processLeaveIntents())).catch(() => {});
    }

    if (!syncEnabled) return;
    const peerAcknowledged = Object.entries(changes).some(([key, change]) => {
        if (!key.startsWith(SYNC_DEV_PREFIX) || key === SYNC_DEV_PREFIX + syncDeviceId) return false;
        const relevant = value => value ? [value.xfp, value.joined, value.enabled] : null;
        return JSON.stringify(relevant(change.oldValue)) !== JSON.stringify(relevant(change.newValue));
    });
    if (!peerAcknowledged && !Object.keys(changes).some(key => key === api.META_KEY || key.startsWith(api.CHUNK_PREFIX))) return;

    const meta = changes[api.META_KEY] && changes[api.META_KEY].newValue;
    if (changes[api.META_KEY] && !meta) return;
    if (!peerAcknowledged && meta && meta.dev && meta.dev === syncDeviceId && meta.fp === syncLastFingerprint) return;
    setTimeout(() => {
        runWhenReady(() => enqueueSyncOperation(() => pullSyncNow({ reason: 'remote-change' }))).catch(() => {});
    }, 400);
});

// Local workspace-shape changes prepare a snapshot after the edit burst settles.
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.workspaces) {
        // Detects create / rename / re-icon / reorder / delete regardless of who wrote it.
        reconcileWorkspaceShape(changes.workspaces.newValue || []);
    }
});

browser.runtime.onInstalled.addListener(() => {
    initSyncController().catch(() => {});
});

browser.runtime.onStartup.addListener(() => {
    initSyncController().catch(() => {});
});

// Script load (event page wake) — safe because initSyncController only reads storage
// and, at most, schedules a pull; it never writes tab state.
initSyncController().catch(() => {});

function handleSyncMessage(message) {
    if (/^SYNC_(GET_|BREATH_PREVIEW)/.test(message.action)) return handleSyncMessageInternal(message);
    return enqueueSyncOperation(() => handleSyncMessageInternal(message));
}

async function handleSyncMessageInternal(message) {
    switch (message.action) {
        case 'SYNC_GET_STATE':
            await initSyncController();
            return { state: getSyncState() };
        case 'SYNC_SET_ENABLED':
            await initSyncController();
            return await setSyncEnabled(message.enabled);
        case 'SYNC_SET_PREFS':
            await initSyncController();
            if (message.prefs && typeof message.prefs === 'object') {
                syncPrefs = { ...syncPrefs, ...message.prefs };
                await persistSyncState();
            }
            return { success: true, prefs: syncPrefs };
        case 'SYNC_RESOLVE_CONFLICT':
        case 'SYNC_RESOLVE_JOIN':
            await initSyncController();
            return await resolveSyncConflict(message.resolution);
        case 'SYNC_GET_CONFLICT':
        case 'SYNC_GET_JOIN':
            return { conflict: pendingSyncJoin, join: pendingSyncJoin };
        case 'SYNC_DISMISS_CONFLICT':
        case 'SYNC_DISMISS_JOIN':
            pendingSyncJoin = null;
            pendingSyncJoinDoc = null;
            setSyncStatus(syncEnabled ? 'idle' : 'idle');
            await updateSyncActionBadge();
            return { success: true };
        case 'SYNC_GET_DEVICES':
            await initSyncController();
            return { devices: await readDeviceRoster() };
        case 'SYNC_LEAVE_DEVICE':
            await initSyncController();
            return await requestDeviceLeave(message.deviceId);
        case 'SYNC_FORCE_REMOVE_DEVICE':
            await initSyncController();
            return await forceRemoveDevice(message.deviceId);
        case 'SYNC_FORGET_DEVICE':
            await initSyncController();
            return await forgetDevice(message.deviceId);
        case 'SYNC_CLEAR_REMOTE': {
            const api = syncApi();
            if (!api) return { success: false, error: 'UNAVAILABLE' };
            try {
                await api.clearSyncDoc();
                syncLastFingerprint = null;
                syncJoined = false;
                await persistSyncState();
                setSyncStatus('idle');
                return { success: true };
            } catch (e) {
                return { success: false, error: 'CLEAR_FAILED', message: e && e.message };
            }
        }
        case 'SYNC_CONFIRM_APPLY': {
            await initSyncController();
            const doc = pendingSyncApplyDoc;
            if (!doc) return { success: false, error: 'NO_PENDING' };
            pendingSyncApply = null;
            syncApplySnoozeUntil = 0;
            const applied = await applySyncedDocIncremental(doc, 'user-confirmed', { confirmed: true });
            if (applied.success) {
                const pushed = await pushSyncNow({ reason: 'after-confirmed-apply' });
                return Object.assign({}, applied, { pushed });
            }
            return applied;
        }
        case 'SYNC_SNOOZE_APPLY': {
            syncApplySnoozeUntil = Date.now() + SYNC_SNOOZE_MS;
            setSyncStatus('idle');
            await updateSyncActionBadge();
            return { success: true, snoozedUntil: syncApplySnoozeUntil };
        }
        case 'SYNC_GET_PENDING_APPLY':
            return { pendingApply: pendingSyncApply };
        case 'SYNC_BREATH_PREVIEW': {
            const theme = message.theme || 'orange';
            browser.runtime.sendMessage({
                action: 'SYNC_ACTIVITY',
                kind: 'changed',
                theme,
                showToast: false,
                preview: true
            }).catch(() => {});
            return { success: true };
        }
        case 'SYNC_GET_QUOTA': {
            const api = syncApi();
            if (!api) return { used: 0, total: 0 };
            return await api.getQuotaUsage();
        }
        default:
            return { success: false, error: 'UNKNOWN_SYNC_ACTION' };
    }
}
