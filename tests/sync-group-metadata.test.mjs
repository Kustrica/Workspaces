import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../sync.js', import.meta.url), 'utf8');
globalThis.window = globalThis;
globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');
new Function(source)();
const S = globalThis.WorkspacesSync;
const ws = [{ id: 'work', name: 'Work' }];
const groups = [
    { id: 'stable-g1', workspaceId: 'work', title: 'Research', color: 'blue', collapsed: true },
    { id: 'stable-g2', workspaceId: 'work', title: 'Reading', color: 'red', collapsed: false }
];
const rows = [
    { url: 'https://same.test/', groupRef: 'stable-g1', instanceId: 'tab-a' },
    { url: 'https://same.test/', groupRef: 'stable-g2', instanceId: 'tab-b' },
    { url: 'https://same.test/', groupRef: 'stable-g1', instanceId: 'tab-c' }
];
const doc = S.buildSyncDoc(ws, { work: rows }, {}, 'device-a', { groups });
assert.equal(doc.v, 2, 'group support stays additive to v2');
assert.equal(doc.t.work.length, 3, 'identical URL copies remain separate');
assert.deepEqual(doc.t.work.map(row => row.h), ['stable-g1', 'stable-g2', 'stable-g1']);
assert.deepEqual(doc.t.work.map(row => row.k), ['tab-a', 'tab-b', 'tab-c']);
assert.deepEqual(S.docToRestoreData(doc).tabs.work.map(row => row.groupRef), ['stable-g1', 'stable-g2', 'stable-g1']);
assert.deepEqual(S.docToRestoreData(doc).tabs.work.map(row => row.instanceId), ['tab-a', 'tab-b', 'tab-c']);
assert.deepEqual(S.docToRestoreData(doc).groups.map(group => group.title), ['Research', 'Reading']);

const legacy = { v: 2, ws: [{ i: 'work', n: 'Work' }], t: { work: ['https://same.test/'] } };
const legacyObject = { ...legacy, t: { work: [{ u: 'https://same.test/' }] } };
assert.equal(S.dataFingerprint(legacy), S.dataFingerprint(legacyObject), 'legacy URL fingerprint is unchanged');
const changedGroup = S.buildSyncDoc(ws, { work: [{ url: 'https://same.test/', groupRef: 'stable-g2', instanceId: 'tab-a' }] }, {}, 'device-a', { groups });
const otherGroup = S.buildSyncDoc(ws, { work: [{ url: 'https://same.test/', groupRef: 'stable-g1', instanceId: 'tab-a' }] }, {}, 'device-a', { groups });
assert.notEqual(S.dataFingerprint(changedGroup), S.dataFingerprint(otherGroup), 'group assignment participates in fingerprint');
const changedInstance = S.buildSyncDoc(ws, { work: [{ url: 'https://same.test/', groupRef: 'stable-g1', instanceId: 'tab-b' }] }, {}, 'device-a', { groups });
assert.notEqual(S.dataFingerprint(otherGroup), S.dataFingerprint(changedInstance), 'per-tab identity participates in fingerprint');

const left = S.buildSyncDoc(ws, { work: rows }, {}, 'device-a', { groups, revs: { work: { r: 2, m: 20 } } });
const right = S.buildSyncDoc(ws, { work: rows.slice(0, 2) }, {}, 'device-b', { groups: [groups[0]], revs: { work: { r: 1, m: 10 } } });
const merged = S.mergeDocs(left, right);
assert.deepEqual(merged.t.work.map(row => row.h), ['stable-g1', 'stable-g2', 'stable-g1']);
assert.deepEqual(merged.t.work.map(row => row.k), ['tab-a', 'tab-b', 'tab-c']);
assert.deepEqual(merged.gr.map(group => group.i).sort(), ['stable-g1', 'stable-g2']);
assert.equal(merged.t.work.length, 3);

const empty = S.buildSyncDoc(ws, { work: [] }, {}, 'device-b');
const diff = S.docDiff(empty, left);
assert.deepEqual(diff.tabsAdd.map(row => row.groupRef), ['stable-g1', 'stable-g2', 'stable-g1']);
assert.deepEqual(diff.tabsAdd.map(row => row.instanceId), ['tab-a', 'tab-b', 'tab-c']);
const closeOne = S.docDiff(left, S.buildSyncDoc(ws, { work: [rows[0], rows[2]] }, {}, 'device-b', { groups }));
assert.equal(closeOne.tabsRemove.length, 1);
assert.equal(closeOne.tabsRemove[0].instanceId, 'tab-b', 'removal targets the correct duplicate URL instance');
const regrouped = S.docDiff(left, changedGroup);
assert.equal(regrouped.tabsGroup[0].groupRef, 'stable-g2');
assert.equal(regrouped.tabsGroup[0].occurrence, 0);
assert.equal(regrouped.tabsGroup[0].instanceId, 'tab-a');
const appearanceEdit = S.docDiff(left, S.buildSyncDoc(ws, { work: rows }, {}, 'device-b', {
    groups: [{ ...groups[0], title: 'Updated', collapsed: false }, groups[1]]
}));
assert.equal(appearanceEdit.changed, true);
assert.deepEqual(appearanceEdit.groupsUpsert, [{
    id: 'stable-g1', workspaceId: 'work', title: 'Updated', color: 'blue', collapsed: false
}]);

const reorderedLocal = S.buildSyncDoc(ws, { work: [rows[0], rows[1]] }, {}, 'local');
const reorderedTarget = S.buildSyncDoc(ws, { work: [
    { url: rows[0].url, groupRef: 'stable-g1', instanceId: 'tab-c' },
    { ...rows[0], groupRef: 'stable-g2' }
] }, {}, 'remote');
const reorderDiff = S.docDiff(reorderedLocal, reorderedTarget);
assert.deepEqual(reorderDiff.tabsAdd, [], 'k3 reuses the remaining same-URL tab k2');
assert.deepEqual(reorderDiff.tabsRemove, [], 'different remaining keys do not cause close and recreate');
assert.equal(reorderDiff.tabsGroup.find(row => row.instanceId === 'tab-a')?.occurrence, 0);
assert.equal(reorderDiff.tabsGroup.find(row => row.instanceId === 'tab-c')?.occurrence, 1,
    'exact k1 stays paired while k2 is reused for k3');
const loneLocal = S.buildSyncDoc(ws, { work: [{ url: rows[0].url, groupRef: 'stable-g1', instanceId: 'k2' }] }, {}, 'local');
const loneTarget = S.buildSyncDoc(ws, { work: [{ url: rows[0].url, groupRef: 'stable-g1', instanceId: 'k3' }] }, {}, 'remote');
const loneDiff = S.docDiff(loneLocal, loneTarget);
assert.deepEqual(loneDiff.tabsAdd, [], 'a single new peer key reuses the local tab');
assert.deepEqual(loneDiff.tabsRemove, [], 'a single new peer key does not recreate the tab');
assert.equal(loneDiff.changed, true, 'the peer instance key must be adopted even with an unchanged group');
assert.deepEqual(loneDiff.tabsGroup, [{
    wsId: 'work', url: rows[0].url, occurrence: 0, instanceId: 'k3', groupRef: 'stable-g1'
}]);
const ungroupedLocal = S.buildSyncDoc(ws, { work: [{ url: rows[0].url, instanceId: 'k1' }] }, {}, 'local');
const ungroupedRemote = S.buildSyncDoc(ws, { work: [{ url: rows[0].url, instanceId: 'k2' }] }, {}, 'remote');
const ungroupedKeyDiff = S.docDiff(ungroupedLocal, ungroupedRemote);
assert.equal(ungroupedKeyDiff.changed, true, 'different keys are adopted when both groups are null');
assert.deepEqual(ungroupedKeyDiff.tabsAdd, []);
assert.deepEqual(ungroupedKeyDiff.tabsRemove, []);
assert.equal(ungroupedKeyDiff.tabsGroup[0].instanceId, 'k2');

const baseWithCopies = S.buildSyncDoc(ws, { work: rows.slice(0, 2) }, {}, 'base');
const localCloseStore = S.emptyTombstones();
const closeAt = Date.now();
S.recordInstanceTombstone(localCloseStore, 'work', rows[0].url, 'tab-a', closeAt);
assert.deepEqual(Object.keys(S.normalizeTombstones(localCloseStore).u), [],
    'an instance close does not also increment the URL close counter');
const localAfterClose = S.buildSyncDoc(ws, { work: [rows[1]] }, {}, 'local', {
    tombstones: localCloseStore, groups
});
const stalePeer = S.buildSyncDoc(ws, { work: rows.slice(0, 2) }, {}, 'peer', { groups });
const mergedAfterClose = S.mergeDocs(localAfterClose, stalePeer, baseWithCopies);
assert.deepEqual(mergedAfterClose.t.work.map(row => row.k), ['tab-b'],
    'the tombstone removes only the exact closed duplicate, preserving its grouped sibling');
assert.equal(mergedAfterClose.t.work[0].h, 'stable-g2');
assert.deepEqual(mergedAfterClose.x.k, [['work', rows[0].url, 'tab-a', closeAt]]);
const staleLaterBirth = S.buildSyncDoc(ws, { work: [
    { ...rows[0], a: closeAt + 10_000 },
    rows[1]
] }, {}, 'stale-peer', { groups });
const stillClosed = S.mergeDocs(localAfterClose, staleLaterBirth, baseWithCopies);
assert.deepEqual(stillClosed.t.work.map(row => row.k), ['tab-b'],
    'a later URL-cohort birth cannot resurrect the exact tombstoned k1');
const oldPeerView = structuredClone(mergedAfterClose);
delete oldPeerView.x.k;
assert.equal(S.dataFingerprint(oldPeerView), S.dataFingerprint({ ...oldPeerView, x: { ...oldPeerView.x, k: [] } }),
    'the additional tombstone section is not required by legacy payload readers');
console.log('sync group metadata tests passed');

