// Exercise the actual background apply/controller functions with deterministic browser APIs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const helperSource = readFileSync(new URL('../sync.js', import.meta.url), 'utf8');
function source(name) {
    const start = background.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    return background.slice(start, background.indexOf('\n}', start) + 2);
}
function fixture(initial = []) {
    const stored = { theme: 'dark', ui_language: 'ru' };
    const messages = [];
    const writes = [];
    const tabs = initial.map(t => ({ windowId: 1, hidden: false, status: 'loading', ...t }));
    const ctx = vm.createContext({ console, TextEncoder, TextDecoder, Date, Map, Set, Promise,
        setTimeout: fn => { fn(); return 1; },
        workspaces: [{ id: 'shop', name: 'Shop' }], currentWorkspaceId: 'shop', lastActiveWsId: 'shop',
        isAllTabsMode: false, isRestoringData: false, syncApplyInProgress: false,
        syncTabBorn: {}, syncWsRevs: {}, syncTombstones: { w: {}, u: {} }, tabIntendedUrl: {}, settledSyncTabs: new Set(),
        tabWorkspaceMap: Object.fromEntries(tabs.map(t => [t.id, 'shop'])),
        syncPrefs: { theme: true, language: true, sidebar: true, uiSettings: true },
        actionLogs: [], syncDeviceId: 'local', syncWsShape: {},
        syncDeviceJoinedAt: 0,
        initReadyPromise: Promise.resolve(), pendingSyncApply: null, pendingSyncApplyDoc: null,
        syncBaseFp: null, syncBaseDoc: null, syncLastFingerprint: null, syncLastSyncAt: 0, syncJoined: true,
        browser: {
            storage: { local: {
                async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in stored).map(k => [k, stored[k]])); },
                async set(patch) { writes.push(patch); Object.assign(stored, patch); }
            } },
            tabs: {
                async query() { return tabs.map(t => ({ ...t })); },
                async create(info) {
                    if (ctx.failCreate) throw Error('create failed');
                    const tab = { id: Math.max(0, ...tabs.map(t => t.id)) + 1, windowId: info.windowId ?? 1, url: 'about:blank', status: 'loading', active: info.active };
                    tabs.push(tab); return tab;
                },
                async remove(ids) {
                    if (ctx.failRemove) throw Error('remove failed');
                    for (const id of ids) tabs.splice(tabs.findIndex(t => t.id === id), 1);
                }
            },
            windows: { async getCurrent() { return { id: 1 }; }, async getAll() { return [{ id: 1 }, { id: 2 }]; } },
            runtime: { async sendMessage(m) { messages.push(m); } }
        },
        setSyncStatus(status, error) { ctx.status = status; ctx.error = error; },
        async assignTabToWorkspace(id, wsId) { ctx.tabWorkspaceMap[id] = wsId; },
        unassignTab(id) { delete ctx.tabWorkspaceMap[id]; },
        rememberTabMeta() {}, noteSyncTabUrlAlive() {}, scheduleSyncMetaPersist() {},
        async persistTabSyncIdentity() {}, adoptSyncTabBornFromDoc() {},
        async persistSyncState() {}, async writeOwnDeviceRosterEntry() {}, async updateSyncActionBadge() {},
        async saveState() {}, updateContextMenus() {}, async repairWorkspaceVisibility() {}, addLog() {},
        resolveExistingWorkspaceId(id) { return ctx.workspaces.some(w => w.id === id) ? id : null; },
        getFallbackWorkspaceId() { return ctx.workspaces[0]?.id || null; }
    });
    ctx.window = ctx;
    vm.runInContext(helperSource, ctx);
    vm.runInContext(['syncApi', 'syncTombstoneFingerprint', 'areTombstonesAcknowledged', 'scheduleTombstoneCompactionIfReady', 'ensureSyncJoinedAt', 'collectLocalSyncDoc', 'applySyncedSettings', 'broadcastSyncBreath',
        'broadcastSyncApplyProgress', 'applySyncedDocIncremental', 'applySyncedDoc'].map(source).join('\n'), ctx);
    const target = urls => ctx.WorkspacesSync.buildSyncDoc([{ id: 'shop', name: 'Shop' }],
        { shop: urls.map(url => ({ url })) }, stored, 'remote');
    return { ctx, tabs, stored, messages, writes, target };
}
let passed = 0;
async function test(name, fn) { await fn(); console.log('  ok  ' + name); passed++; }

await test('unchanged remote language/theme causes no storage writes or sidebar reload', async () => {
    const f = fixture();
    await f.ctx.applySyncedSettings({ theme: 'dark', ui_language: 'ru' });
    assert.equal(f.writes.length, 0);
    await f.ctx.applySyncedSettings({ theme: 'light', ui_language: 'ru' });
    assert.deepEqual(Object.keys(f.writes[0]), ['theme']);
});
await test('local snapshot preparation uses a trailing five-second debounce', async () => {
    let nextId = 0;
    const timers = new Map();
    const cleared = [];
    let pulls = 0;
    const debounce = vm.createContext({
        syncEnabled: true, syncJoined: true, syncPrepareTimer: null, SYNC_PREPARE_DEBOUNCE_MS: 5000,
        setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { cleared.push(id); },
        runWhenReady(fn) { return fn(); },
        enqueueSyncOperation(fn) { return fn(); },
        pullSyncNow(options) { assert.equal(options.reason, 'local-change'); pulls++; return Promise.resolve(); }
    });
    vm.runInContext(source('scheduleSyncSnapshotPreparation'), debounce);
    debounce.scheduleSyncSnapshotPreparation();
    debounce.scheduleSyncSnapshotPreparation();
    assert.equal(timers.get(1).delay, 5000);
    assert.deepEqual(cleared, [1]);
    timers.get(2).fn();
    await Promise.resolve();
    assert.equal(pulls, 1);
});
await test('deletion history compacts only after every joined active device acknowledges it', async () => {
    const x = { w: [], u: [['shop', 'https://example.test/closed', 1234, 1]] };
    const context = vm.createContext({
        Math,
        readDeviceRoster: async () => context.devices
    });
    context.window = context;
    vm.runInContext(helperSource, context);
    vm.runInContext(['syncApi', 'syncTombstoneFingerprint', 'areTombstonesAcknowledged'].map(source).join('\n'), context);
    const xfp = context.syncTombstoneFingerprint(x);
    context.devices = [
        { joined: true, enabled: true, status: 'synced', xfp },
        { joined: true, enabled: true, status: 'synced', xfp: 'old' }
    ];
    assert.equal(await context.areTombstonesAcknowledged(x), false);
    context.devices[1].xfp = xfp;
    assert.equal(await context.areTombstonesAcknowledged(x), true);
    context.devices[1].status = 'left';
    context.devices[1].xfp = 'old';
    assert.equal(await context.areTombstonesAcknowledged(x), true);
});
await test('join merge applies exactly three copies including complete search URLs', async () => {
    const u = 'https://ozon.by/search/?q=phone&sort=price#results';
    const f = fixture([{ id: 1, url: u }]);
    const doc = f.target([u, u, u]);
    const applied = await f.ctx.applySyncedDoc(doc, 'MERGE', 'join-merge');
    assert.equal(applied.success, true);
    assert.equal(applied.added, 2);
    assert.equal(f.tabs.length, 3);
    for (let i = 0; i < 5; i++) {
        assert.equal((await f.ctx.applySyncedDocIncremental(doc)).action, 'NO_CHANGES');
        assert.equal(f.tabs.length, 3);
    }
    assert.equal(f.messages.filter(m => m.action === 'SYNC_ACTIVITY').length, 1);
});
await test('workspace-only changes never pulse', async () => {
    const f = fixture([{ id: 1, url: 'https://a/' }]);
    const doc = f.target(['https://a/']); doc.ws[0].n = 'Renamed';
    assert.equal((await f.ctx.applySyncedDocIncremental(doc)).success, true);
    assert.equal(f.messages.filter(m => m.action === 'SYNC_ACTIVITY').length, 0);
});
await test('close updates maps and protects every affected window', async () => {
    const f = fixture([{ id: 1, windowId: 1, url: 'https://a/' }, { id: 2, windowId: 2, url: 'https://a/' }]);
    const applied = await f.ctx.applySyncedDocIncremental(f.target([]));
    assert.equal(applied.success, true);
    assert.equal(applied.removed, 2);
    assert.equal(f.ctx.tabWorkspaceMap[1], undefined);
    assert.equal(f.ctx.tabWorkspaceMap[2], undefined);
    assert.deepEqual(f.tabs.map(t => t.windowId).sort(), [1, 2]);
    const pulse = f.messages.find(m => m.action === 'SYNC_ACTIVITY');
    assert.equal(pulse.removed, 2);
});
await test('failed tab creation does not acknowledge target or report success', async () => {
    const f = fixture(); f.ctx.failCreate = true;
    assert.equal((await f.ctx.applySyncedDocIncremental(f.target(['https://a/']))).success, false);
    assert.equal(f.ctx.syncBaseFp, null);
    assert.equal(f.messages.filter(m => m.action === 'SYNC_ACTIVITY').length, 0);
    assert.equal(f.ctx.isRestoringData, false);
});
await test('failed close leaves the common ancestor unchanged', async () => {
    const f = fixture([{ id: 1, url: 'https://a/' }, { id: 2, url: 'https://b/' }]); f.ctx.failRemove = true;
    assert.equal((await f.ctx.applySyncedDocIncremental(f.target(['https://b/']))).success, false);
    assert.equal(f.ctx.syncBaseFp, null);
    assert.equal(f.ctx.tabWorkspaceMap[1], 'shop');
});
console.log(`${passed} controller tests passed`);
