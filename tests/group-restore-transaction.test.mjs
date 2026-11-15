import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function restoreData(');
const end = source.indexOf('\n// Message handler', start);
assert.ok(start >= 0 && end > start, 'restoreData is extractable');

async function runRestore({ failUrl = null, failGroup = false, failOldClose = false }) {
    const live = new Map([[1, { id: 1, windowId: 10, url: 'https://existing.test/', active: true }]]);
    const sessions = new Map([['1:workspaceId', 'old']]);
    const removed = [];
    let nextId = 2;
    const context = vm.createContext({
        console, Map, Set, Promise, Object, Array, String, Number, Error, Math,
        workspaces: [{ id: 'old', name: 'Old' }], currentWorkspaceId: 'old', lastActiveWsId: 'old',
        isAllTabsMode: false, isRestoringData: false, tabWorkspaceMap: { 1: 'old' }, workspaceActiveTabMap: { old: 1 },
        tabWindowMap: { 1: 10 }, tabUrlCache: { 1: 'https://existing.test/' },
        syncWsRevs: {}, tabIntendedUrl: {}, settledSyncTabs: new Set(), syncApplyInProgress: false,
        WorkspacesGroupSnapshot: { normalizeImport(data) { return { tabs: data.tabs || {}, groups: data.groups || [] }; } },
        browser: {
            windows: { async getCurrent() { return { id: 10 }; } },
            tabs: {
                async create(properties) {
                    if (properties.url === failUrl) throw new Error('create failed');
                    const tab = { id: nextId++, windowId: properties.windowId, url: properties.url, status: 'loading' };
                    live.set(tab.id, tab);
                    return tab;
                },
                async query(query = {}) { return [...live.values()].filter(tab => query.windowId == null || tab.windowId === query.windowId); },
                async remove(ids) {
                    if (failOldClose && (Array.isArray(ids) ? ids : [ids]).includes(1)) throw new Error('close failed');
                    for (const id of (Array.isArray(ids) ? ids : [ids])) {
                        removed.push(id);
                        live.delete(id);
                    }
                },
                async group() { if (failGroup) throw new Error('group failed'); return 9; }
            },
            tabGroups: { async update() {} },
            sessions: {
                async getTabValue(id, key) { return sessions.get(`${id}:${key}`); },
                async setTabValue(id, key, value) { sessions.set(`${id}:${key}`, value); },
                async removeTabValue(id, key) { sessions.delete(`${id}:${key}`); }
            },
            runtime: { sendMessage() { return Promise.resolve(); } },
            storage: { local: { async set() {} } }
        },
        async assignTabToWorkspace(id, wsId) {
            context.tabWorkspaceMap[id] = wsId;
            sessions.set(`${id}:workspaceId`, wsId);
        },
        unassignTab(id) { delete context.tabWorkspaceMap[id]; sessions.delete(`${id}:workspaceId`); },
        async clearSessionWorkspace(id) { sessions.delete(`${id}:workspaceId`); },
        rememberTabMeta(tab) { context.tabWindowMap[tab.id] = tab.windowId; context.tabUrlCache[tab.id] = tab.url; },
        getSessionWorkspace(id) { return Promise.resolve(sessions.get(`${id}:workspaceId`) || null); },
        setSessionWorkspace(id, wsId) { sessions.set(`${id}:workspaceId`, wsId); return Promise.resolve(); },
        async saveState() {}, updateContextMenus() {}, async switchWorkspace() {}, async repairWorkspaceVisibility() {},
        getLocalizedDefaults() { return [{ id: 'ws_default', name: 'Main' }]; },
        setTimeout(callback) { callback(); return 0; }
    });
    vm.runInContext(source.slice(start, end), context);
    const data = {
        workspaces: [{ id: 'new', name: 'New' }],
        tabs: { new: [{ url: 'https://restore.test/', ...(failGroup ? { groupRef: 'g1' } : {}) }] },
        groups: failGroup ? [{ id: 'g1', workspaceId: 'new', title: 'Group', color: 'blue', collapsed: false }] : []
    };
    const result = await context.restoreData(data, 'REPLACE');
    return { result, live, removed, map: context.tabWorkspaceMap, sessions };
}

{
    const { result, live, map } = await runRestore({ failOldClose: true });
    assert.equal(result.error, 'RESTORE_PARTIAL');
    assert.ok(live.has(1), 'unclosed original survives');
    assert.ok([...live.values()].some(tab => tab.url === 'https://restore.test/'), 'restored tabs survive partial close');
    assert.ok(map[1], 'unclosed original keeps a workspace');
}

for (const scenario of [
    { failUrl: 'https://restore.test/' },
    { failGroup: true }
]) {
    const { result, live, removed, map, sessions } = await runRestore(scenario);
    assert.equal(result.success, false, 'failed creation/group returns a failure');
    assert.ok(live.has(1), 'original user tab remains open');
    assert.ok(removed.length > 0 && removed.every(id => id !== 1), 'rollback closes only operation-owned tabs');
    assert.ok(![...live.keys()].some(id => id !== 1), 'no operation-owned tabs remain after rollback');
    assert.deepEqual(JSON.parse(JSON.stringify(map)), { 1: 'old' }, 'original workspace map is restored');
    assert.equal(sessions.get('1:workspaceId'), 'old', 'original session mapping remains intact');
}

console.log('group restore transaction: failed create/group preserves existing tabs and mappings');
