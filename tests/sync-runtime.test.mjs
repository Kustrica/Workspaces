import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const local = { syncEnabled: false, syncJoined: true, syncDeviceId: 'devA', theme: 'dark' };
const remote = {};
const sessions = new Map();
const tabs = new Map([[1, { id: 1, url: 'https://shop.test/?product=1', windowId: 1, status: 'complete' }]]);
const messages = [];
let nextId = 2;
let failPayloadWrite = false;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const area = store => ({
    async get(keys) { return keys == null ? structuredClone(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, structuredClone(store[k])])); },
    async set(patch) {
        if (store === remote && failPayloadWrite && Object.keys(patch).some(k => k.startsWith('sync_chunk_') || k === 'sync_meta')) {
            throw new Error('Simulated sync write failure');
        }
        Object.assign(store, structuredClone(patch));
    },
    async remove(keys) { for (const key of [].concat(keys)) delete store[key]; }
});
const browser = {
    storage: { local: area(local), sync: area(remote), onChanged: event() },
    runtime: { onInstalled: event(), onStartup: event(), async getPlatformInfo() { return { os: 'win' }; }, async sendMessage(m) { messages.push(m); } },
    alarms: { onAlarm: event(), async get() { return {}; }, async clear() {} },
    windows: { async getCurrent() { return { id: 1 }; }, async getAll() { return [{ id: 1 }]; } },
    tabs: {
        onUpdated: event(), async query() { return [...tabs.values()].map(t => ({ ...t })); },
        async create(info) { const tab = { id: nextId++, url: info.url || 'about:blank', windowId: 1, status: 'loading' }; tabs.set(tab.id, tab); return { ...tab }; },
        async remove(ids) { for (const id of [].concat(ids)) tabs.delete(id); }
    },
    sessions: {
        async setTabValue(id, key, value) { sessions.set(`${id}:${key}`, value); },
        async getTabValue(id, key) { return sessions.get(`${id}:${key}`); },
        async removeTabValue(id, key) { sessions.delete(`${id}:${key}`); }
    }
};
let timerId = 0;
const timers = new Map();
const context = vm.createContext({
    console, browser, TextEncoder, TextDecoder, Uint8Array, btoa, atob, Response,
    crypto: globalThis.crypto, CompressionStream, DecompressionStream,
    setTimeout(fn, ms) { const id = ++timerId; if (ms <= 50) queueMicrotask(fn); else timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    initReadyPromise: Promise.resolve(), isInitializingState: false, isRestoringData: false,
    workspaces: [{ id: 'shop', name: 'Shop', icon: 'x' }], tabWorkspaceMap: { 1: 'shop' },
    tabUrlCache: { 1: tabs.get(1).url }, tabWindowMap: {}, currentWorkspaceId: 'shop', lastActiveWsId: 'shop', isAllTabsMode: false, actionLogs: [],
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
const start = source.indexOf('browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {');
vm.runInContext(source.slice(start, source.indexOf('\nif (browser.tabs.onAttached)', start)), context);
const run = code => vm.runInContext(code, context);
await run('initSyncController()');
run('syncEnabled = true');
const S = context.WorkspacesSync;
context.target = S.buildSyncDoc(context.workspaces, { shop: [{ url: tabs.get(1).url }, { url: tabs.get(1).url }] }, { theme: 'dark' }, 'devB');
assert.equal((await run('applySyncedDocIncremental(target)')).added, 1);
const redirected = tabs.get(2);
redirected.url = 'https://shop.test/'; redirected.status = 'complete';
for (const fn of browser.tabs.onUpdated.listeners) fn(2, { url: redirected.url, status: 'complete' }, redirected);
assert.equal(sessions.get('2:syncIdentity').url, 'https://shop.test/?product=1');
for (let i = 0; i < 4; i++) assert.equal((await run('applySyncedDocIncremental(target)')).action, 'NO_CHANGES');
assert.equal(tabs.size, 2);
console.log('ok redirect identity and repeated applies');

await run('pushSyncNow()');
const spotify = { id: nextId++, url: 'https://open.spotify.com/', windowId: 1, status: 'complete' };
tabs.set(spotify.id, spotify); context.tabWorkspaceMap[spotify.id] = 'shop';
assert.equal((await run('pullSyncNow()')).success, true);
assert.ok((await S.readSyncDoc()).doc.t.shop.some(t => S.urlOf(t) === spotify.url));
console.log('ok self-echo preserves Spotify');

const exchangeTime = await run('syncLastSyncAt');
messages.length = 0;
await run('pullSyncNow()');
assert.equal(await run('syncLastSyncAt'), exchangeTime);
assert.equal(messages.filter(m => m.action === 'SYNC_ACTIVITY').length, 0);
local.theme = 'light';
await run('pullSyncNow()');
assert.equal((await S.readSyncDoc()).doc.s.theme, 'light');
console.log('ok idle poll stays quiet, settings change publishes');

const meta = remote.sync_meta;
remote[S.chunkKey(meta.gen, 0)] = 'interleaved-write';
assert.equal((await run('pullSyncNow()')).action, 'REPAIRED');
assert.equal((await S.readSyncDoc()).doc.s.theme, 'light');
remote.sync_meta.dev = 'other-device';
remote[S.chunkKey(meta.gen, 0)] = 'incomplete-peer-write';
const tabCountBeforePartial = tabs.size;
assert.equal((await run('pullSyncNow()')).error, 'INCOMPLETE');
assert.equal(await run('syncStatus'), 'waiting');
assert.equal(tabs.size, tabCountBeforePartial);
await run('pushSyncNow()'); // Restore a complete account copy for the navigation check.
console.log('ok only the winning snapshot author repairs mixed chunks');

redirected.url = 'https://shop.test/?product=2';
for (const fn of browser.tabs.onUpdated.listeners) fn(2, { url: redirected.url, status: 'loading' }, redirected);
assert.equal(sessions.get('2:syncIdentity'), undefined);
assert.ok((await run('collectLocalSyncDoc()')).t.shop.some(t => S.urlOf(t) === redirected.url));
console.log('ok subsequent navigation replaces identity');

let active = 0, max = 0;
context.operation = async () => { max = Math.max(max, ++active); await new Promise(r => setTimeout(r, 10)); active--; };
await Promise.all([run('enqueueSyncOperation(operation)'), run('enqueueSyncOperation(operation)')]);
assert.equal(max, 1);
console.log('ok sync operation queue is serialized');

// A successful local publication does not mean the laptop has received it.
const first = 'https://www.youtube.com/watch?v=part1';
const second = 'https://www.youtube.com/watch?v=part2';
tabs.clear();
tabs.set(100, { id: 100, url: first, windowId: 1, status: 'complete' });
context.tabWorkspaceMap = { 100: 'shop' };
context.tabUrlCache = { 100: first };
run('syncTombstones = WorkspacesSync.emptyTombstones(); syncTabBorn = {}; Object.keys(tabIntendedUrl).forEach(key => delete tabIntendedUrl[key]); syncBaseDoc = null; syncBaseFp = null');
remote.sync_dev_devB = { id: 'devB', joined: true, enabled: true, xfp: null };
await run('pushSyncNow()');
const staleLaptop = (await S.readSyncDoc()).doc;
context.closedUrl = first; context.openedUrl = second;
run('recordTabTombstone("shop", closedUrl); noteSyncTabUrlAlive("shop", openedUrl)');
tabs.delete(100);
tabs.set(101, { id: 101, url: second, windowId: 1, status: 'complete' });
context.tabWorkspaceMap = { 101: 'shop' }; context.tabUrlCache = { 101: second };
await run('pushSyncNow()');
staleLaptop.dev = 'devB'; staleLaptop.ts = Date.now();
await S.writeSyncDoc(staleLaptop);
assert.equal((await run('pullSyncNow()')).success, true);
assert.deepEqual([...tabs.values()].map(t => t.url), [second],
    'stale laptop cannot resurrect part 1 or close locally opened part 2');
console.log('ok stale publication after replacing a YouTube video');

context.history = { w: {}, u: Object.fromEntries(Array.from({ length: 1500 }, (_, i) =>
    [S.tombKey('shop', `https://old.test/${i}`), { t: Date.now() - 1000, n: 1 }])) };
run('syncTombstones = history');
await run('pushSyncNow()');
assert.equal((await S.readSyncDoc()).doc.x.u.length, 1500);
const oldPeer = structuredClone(remote.sync_dev_devB);
remote.sync_dev_devB.xfp = remote.sync_dev_devA.xfp;
failPayloadWrite = true;
assert.equal((await run('pullSyncNow()')).success, false);
assert.equal(await run('Object.keys(syncTombstones.u).length'), 1500,
    'a failed replacement cannot discard the durable close evidence');
failPayloadWrite = false;
const beforeCompaction = (await S.readSyncDoc()).doc;
for (const fn of browser.storage.onChanged.listeners) fn({ sync_dev_devB: {
    oldValue: oldPeer, newValue: structuredClone(remote.sync_dev_devB)
} }, 'sync');
for (const [id, timer] of [...timers]) if (timer.ms === 400) { timers.delete(id); timer.fn(); }
await run('syncOperationTail');
assert.equal(await run('Object.keys(syncTombstones.u).length'), 0);
const compacted = (await S.readSyncDoc()).doc;
assert.equal(compacted.x.u.length, 0);
assert.ok(compacted.g.fp);
assert.equal(S.mergeDocs(compacted, beforeCompaction, beforeCompaction).x.u.length, 0,
    'an acknowledged cleanup receipt prevents old deletion history coming back');
console.log('ok 1500 records compact on peer acknowledgement; failed writes retain history');

const missingReceipt = structuredClone(compacted);
delete missingReceipt.g;
missingReceipt.dev = 'devB';
await S.writeSyncDoc(missingReceipt);
await run('pullSyncNow()');
assert.deepEqual((await S.readSyncDoc()).doc.g, compacted.g,
    'an identical stale snapshot must not erase the compaction receipt');
console.log('ok identical stale data retains the latest cleanup receipt');

context.future = Date.now() + 3600_000;
run('syncTombstones.u[WorkspacesSync.tombKey("shop", openedUrl)] = { t: future, n: 1 }; noteSyncTabUrlAlive("shop", openedUrl)');
assert.ok(await run('syncTabBorn[WorkspacesSync.tombKey("shop", openedUrl)] > future'));
run('recordTabTombstone("shop", openedUrl)');
assert.ok(await run('syncTombstones.u[WorkspacesSync.tombKey("shop", openedUrl)].t > future + 1'));
console.log('ok reopen and subsequent close follow observed operations despite clock skew');

