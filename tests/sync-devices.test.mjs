// Device roster: disconnect, "Remove now", "Remove from list" and rejoining sync.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const local = { syncEnabled: true, syncJoined: true, syncDeviceId: 'devA', theme: 'dark' };
const remote = {};
const tabs = new Map([[1, { id: 1, url: 'https://example.test/', windowId: 1, status: 'complete' }]]);
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const area = store => ({
    async get(keys) { return keys == null ? structuredClone(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, structuredClone(store[k])])); },
    async set(patch) { Object.assign(store, structuredClone(patch)); },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
});
const browser = {
    storage: { local: area(local), sync: area(remote), onChanged: event() },
    runtime: { onInstalled: event(), onStartup: event(), async getPlatformInfo() { return { os: 'win' }; }, async sendMessage() {} },
    alarms: { onAlarm: event(), async get() { return {}; }, async clear() {} },
    windows: { async getCurrent() { return { id: 1 }; }, async getAll() { return [{ id: 1 }]; } },
    tabs: {
        onUpdated: event(), async query() { return [...tabs.values()].map(t => ({ ...t })); },
        async create(info) { const tab = { id: 100 + tabs.size, url: info.url, windowId: 1, status: 'complete' }; tabs.set(tab.id, tab); return { ...tab }; },
        async remove(ids) { for (const id of [].concat(ids)) tabs.delete(id); }
    },
    sessions: { async setTabValue() {}, async getTabValue() {}, async removeTabValue() {} }
};
const context = vm.createContext({
    console, browser, TextEncoder, TextDecoder, Uint8Array, btoa, atob, Response,
    crypto: globalThis.crypto, CompressionStream, DecompressionStream,
    setTimeout(fn, ms) { if (ms <= 50) queueMicrotask(fn); return 0; }, clearTimeout() {},
    initReadyPromise: Promise.resolve(), isInitializingState: false, isRestoringData: false,
    workspaces: [{ id: 'main', name: 'Main', icon: 'x' }], tabWorkspaceMap: { 1: 'main' },
    tabUrlCache: { 1: tabs.get(1).url }, tabWindowMap: {}, currentWorkspaceId: 'main', lastActiveWsId: 'main', isAllTabsMode: false, actionLogs: [],
    async assignTabToWorkspace(id, ws) { context.tabWorkspaceMap[id] = ws; },
    unassignTab(id) { delete context.tabWorkspaceMap[id]; },
    rememberTabMeta(tab) { context.tabUrlCache[tab.id] = tab.url; },
    resolveExistingWorkspaceId(id) { return context.workspaces.some(w => w.id === id) ? id : null; },
    getFallbackWorkspaceId() { return context.workspaces[0]?.id; },
    async saveState() {}, updateContextMenus() {}, async repairWorkspaceVisibility() {}, addLog() {}, runWhenReady(fn) { return fn(); }
});
context.window = context;
vm.runInContext(readFileSync(new URL('../sync.js', import.meta.url), 'utf8'), context);
vm.runInContext(source.slice(source.indexOf('// --- Firefox Sync (browser.storage.sync)')), context);
const run = code => vm.runInContext(code, context);
const statusOf = async id => (await run('readDeviceRoster()')).find(d => d.id === id)?.status;

await run('initSyncController()');
await run('pushSyncNow()');
assert.equal(await statusOf('devA'), 'synced');
remote.sync_dev_devB = { id: 'devB', label: 'Laptop', joined: true, enabled: true, lastSeen: 1 };

// Disconnect another device: it waits until that device processes the request.
assert.equal((await run("requestDeviceLeave('devB')")).pending, true);
assert.equal(await statusOf('devB'), 'pending_leave');
console.log('ok disconnecting another device waits for it');

// The disconnected device turns sync off itself and shows as not syncing.
remote.sync_leave_devA = { state: 'pending', requestedAt: Date.now(), by: 'devB' };
await run('processLeaveIntents()');
assert.equal(await run('syncEnabled'), false);
assert.equal(remote.sync_leave_devA.state, 'acked');
assert.equal(await statusOf('devA'), 'left');
console.log('ok a pending leave turns sync off on that device and keeps its roster entry');

// Rejoin: turning sync on again clears the old leave record.
await run('setSyncEnabled(true)');
assert.equal(remote.sync_leave_devA, undefined);
assert.notEqual(await statusOf('devA'), 'left');
console.log('ok turning sync back on rejoins');

// Even without clearing the record (older versions), a newer active roster entry wins.
remote.sync_leave_devC = { state: 'acked', ackedAt: 1000, by: 'devC' };
remote.sync_dev_devC = { id: 'devC', joined: true, enabled: true, lastSeen: 2000 };
assert.equal(await statusOf('devC'), 'synced');
console.log('ok a device active after its leave record is not shown as left');

// "Remove now" for the waiting device: drops it from the list immediately.
assert.equal((await run("forceRemoveDevice('devB')")).success, true);
assert.equal(remote.sync_dev_devB, undefined);
assert.equal(remote.sync_leave_devB.forced, true);
console.log('ok remove now drops a waiting device');

// The removed device comes online later: sync turns off there and it stays off the list.
remote.sync_leave_devA = { state: 'acked', requestedAt: 1, ackedAt: 1, by: 'devB', forced: true };
const metaBefore = JSON.stringify(remote.sync_meta);
await run('processLeaveIntents()');
assert.equal(await run('syncEnabled'), false);
assert.equal(remote.sync_dev_devA, undefined);
assert.equal(JSON.stringify(remote.sync_meta), metaBefore, 'a removed device must not publish its stale copy');
assert.equal(remote.sync_leave_devA.by, 'devA');
console.log('ok a device removed while offline turns sync off and stays removed');

// A disabled device does not re-register itself on startup.
run('syncInitialized = false');
await run('initSyncController()');
assert.equal(remote.sync_dev_devA, undefined);
console.log('ok a disabled device does not reappear on startup');

// Remove from list: only for other devices.
remote.sync_dev_devD = { id: 'devD', joined: false, enabled: false, lastSeen: 5 };
assert.equal(await statusOf('devD'), 'left');
assert.equal((await run("forgetDevice('devD')")).success, true);
assert.equal(remote.sync_dev_devD, undefined);
assert.equal((await run("forgetDevice('devA')")).success, false);
console.log('ok remove from list');

// Rejoin after being removed while away.
await run('setSyncEnabled(true)');
assert.equal(remote.sync_leave_devA, undefined);
assert.ok(remote.sync_dev_devA && remote.sync_dev_devA.enabled);
console.log('ok a removed device can rejoin by turning sync on');

// Interface language from another device: only a newer explicit choice is applied.
delete local.ui_language; delete local.ui_language_set_at;
await run("applySyncedSettings({ ui_language: 'en' })");
assert.equal(local.ui_language, undefined, 'a value nobody chose must not replace Auto');
local.ui_language = 'auto'; local.ui_language_set_at = 500;
await run("applySyncedSettings({ ui_language: 'en', ui_language_set_at: 100 })");
assert.equal(local.ui_language, 'auto', 'an older choice must not replace a newer one');
await run("applySyncedSettings({ ui_language: 'de', ui_language_set_at: 900 })");
assert.equal(local.ui_language, 'de');
assert.equal(local.ui_language_set_at, 900);
console.log('ok synced language respects Auto and the newest explicit choice');
console.log('10 device roster and settings tests passed');
