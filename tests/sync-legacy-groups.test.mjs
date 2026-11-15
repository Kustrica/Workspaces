import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
new Function(readFileSync(new URL('../sync.js', import.meta.url), 'utf8'))();
const S = globalThis.WorkspacesSync;

const ws = [{ id: 'ws_work', name: 'Work', icon: '📁' }];
const url = 'https://example.test/same';
const group = { id: 'group:stable', workspaceId: 'ws_work', title: 'Research', color: 'blue', collapsed: false };
const groupsExtra = { groups: [group] };

function modernDoc(tabRows, deviceId = 'new-device', extra = {}) {
    return S.buildSyncDoc(ws, { ws_work: tabRows }, {}, deviceId, { ...groupsExtra, ...extra });
}

function legacyDoc(tabRows, tombstoneRows = []) {
    return {
        v: 2,
        ts: Date.now(),
        dev: 'old-device',
        ws: [{ i: 'ws_work', n: 'Work', c: '📁', o: 0, r: 2, m: Date.now() }],
        t: { ws_work: tabRows },
        s: {},
        x: { w: [], u: tombstoneRows }
    };
}

console.log('sync legacy group metadata tests');

{
    const local = modernDoc([
        { url, instanceId: 'tab:one', groupRef: group.id },
        { url, instanceId: 'tab:two', groupRef: group.id }
    ]);
    // Old v2 writers preserve URL multiplicity but do not serialize gr/h/k.
    const remote = legacyDoc([url, url]);

    const merged = S.mergeDocs(local, remote);
    assert.equal(merged.t.ws_work.length, 2);
    assert.deepEqual(merged.t.ws_work.map(row => row.k), ['tab:one', 'tab:two']);
    assert.deepEqual(merged.t.ws_work.map(row => row.h), [group.id, group.id]);
    assert.deepEqual(merged.gr, [{ i: group.id, w: group.workspaceId, t: group.title, c: group.color, x: false }]);
    console.log('  ok  legacy peer omission preserves known group metadata and tab identities');
}

{
    const base = modernDoc([
        { url, instanceId: 'tab:one', groupRef: group.id },
        { url, instanceId: 'tab:two', groupRef: group.id }
    ], 'new-device', { revs: { ws_work: { r: 1, m: Date.now() - 10_000 } } });
    const local = modernDoc([
        { url, instanceId: 'tab:one', groupRef: group.id },
        { url, instanceId: 'tab:two', groupRef: group.id }
    ], 'new-device', { revs: { ws_work: { r: 1, m: Date.now() - 10_000 } } });
    const closedAt = Date.now() - 1000;
    // A legacy client can only express this as a URL-count tombstone, not an instance tombstone.
    const remote = legacyDoc([url], [['ws_work', url, closedAt, 1]]);

    const merged = S.mergeDocs(local, remote, base);
    assert.equal(merged.t.ws_work.length, 1, 'legacy close still reduces the URL multiset');
    assert.equal(merged.t.ws_work[0].h, group.id, 'surviving row keeps the known group reference');
    assert.ok(merged.t.ws_work[0].k, 'surviving row keeps a stable identity');
    console.log('  ok  legacy close remains applied while surviving duplicate keeps metadata');
}

