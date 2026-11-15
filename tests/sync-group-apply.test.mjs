import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function applySyncedTabGroups(');
const end = source.indexOf('\n// 1.19 hardening', start);
assert.ok(start >= 0 && end > start);
const tabs = [
    { id: 1, windowId: 1, groupId: -1, hidden: false, url: 'https://same.test/' },
    { id: 2, windowId: 1, groupId: -1, hidden: false, url: 'https://same.test/' }
];
const values = new Map([['1:workspacesSyncTabId', 'one'], ['2:workspacesSyncTabId', 'two']]);
const grouped = [];
const context = vm.createContext({
    console, Map, Set, Promise, String, Error,
    tabWorkspaceMap: { 1: 'work', 2: 'work' }, tabIntendedUrl: {}, tabSyncInstanceIds: new Map(),
    syncApi: () => ({ identityKey: (ws, url) => `${ws}\n${url}`, tabSyncIdentity: tab => tab.url,
        urlOf: row => typeof row === 'string' ? row : row.u }),
    browser: {
        sessions: {
            async getTabValue(id, key) { return values.get(`${id}:${key}`); },
            async setTabValue(id, key, value) { values.set(`${id}:${key}`, value); },
            async removeTabValue(id, key) { values.delete(`${id}:${key}`); }
        },
        tabs: {
            async query() { return tabs.map(tab => ({ ...tab })); },
            async group({ tabIds }) { grouped.push([...tabIds]); return 40 + grouped.length; },
            async ungroup() { throw Error('unexpected ungroup'); }
        },
        tabGroups: { async query() { return []; }, async update() {} }
    }
});
vm.runInContext(source.slice(start, end), context);
await context.applySyncedTabGroups({
    ws: [{ i: 'work' }], gr: [
        { i: 'a', w: 'work', t: 'A', c: 'blue', x: false },
        { i: 'b', w: 'work', t: 'B', c: 'red', x: false }
    ],
    t: { work: [ { u: 'https://same.test/', k: 'two', h: 'a' }, { u: 'https://same.test/', k: 'one', h: 'b' } ] }
});
assert.deepEqual(grouped, [[2], [1]], 'match duplicated URLs by stable tab identity, not row order');
assert.equal(values.get('1:workspacesGroupSyncRef'), 'b');
assert.equal(values.get('2:workspacesGroupSyncRef'), 'a');
console.log('sync group apply: duplicate URLs retain their own group');
