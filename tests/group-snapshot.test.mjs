import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../group-snapshot.js', import.meta.url), 'utf8');
const context = vm.createContext({ Map, Set, Promise, TypeError, Object, String, Number, Boolean, Array });
vm.runInContext(source, context);
const API = context.WorkspacesGroupSnapshot;
assert.ok(API, 'global API is available');

function fixture({ tabs, groups, saved = {}, failQuery = false, failReadId = null }) {
    const browser = {
        sessions: {
            async getTabValue(id, key) {
                assert.equal(key, 'workspacesNativeGroup');
                if (id === failReadId) throw new Error('session read failed');
                return saved[id] || null;
            }
        },
        tabGroups: { async query() { if (failQuery) throw new Error('group query failed'); return groups; } }
    };
    return API.create(browser).capture(tabs, id => ({ 1: 'work', 2: 'work', 3: 'work', 4: 'study' })[id]);
}

{
    const result = await fixture({
        tabs: [
            { id: 1, windowId: 10, groupId: 7, url: 'https://same.test/' },
            { id: 2, windowId: 10, groupId: 7, url: 'https://same.test/' },
            { id: 3, windowId: 20, groupId: 8, url: 'https://same.test/' }
        ],
        groups: [
            { id: 7, title: 'First', color: 'blue', collapsed: true },
            { id: 8, title: 'Second', color: 'red', collapsed: false }
        ]
    });
    assert.equal(result.tabs.work.length, 3, 'duplicate URL rows remain distinct');
    assert.equal(result.tabs.work[0].groupRef, result.tabs.work[1].groupRef, 'same native group shares one ref');
    assert.notEqual(result.tabs.work[0].groupRef, result.tabs.work[2].groupRef, 'same native ID in another window gets a distinct ref');
    assert.equal(result.groups.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result.groups.map(g => [g.title, g.color, g.collapsed]))), [
        ['First', 'blue', true], ['Second', 'red', false]
    ]);
}

{
    const result = await fixture({
        tabs: [{ id: 4, windowId: 30, groupId: -1, url: 'https://hidden.test/' }],
        groups: [],
        saved: { 4: { version: 1, identity: 'native-group:1:study', workspaceId: 'study', title: 'Saved', color: 'purple', collapsed: false } }
    });
    assert.equal(result.groups[0].title, 'Saved', 'ungrouped hidden tab uses session metadata');
    assert.equal(result.groups[0].color, 'purple');
    assert.equal(result.tabs.study[0].groupRef, result.groups[0].id);
}

{
    const imported = API.normalizeImport({
        formatVersion: 2,
        groups: [{ id: 'g1', workspaceId: 'work', title: 'Edited', color: 'not-a-color', collapsed: 1 }],
        tabs: { work: [
            { url: 'https://same.test/', groupRef: 'g1' },
            { url: 'https://same.test/', groupRef: 'missing' },
            { url: 'https://other.test/', groupRef: 'g1' }
        ] }
    });
    assert.equal(imported.groups[0].title, 'Edited', 'manual group edits are retained');
    assert.equal(imported.groups[0].color, 'grey', 'invalid color is normalized');
    assert.equal(imported.groups[0].collapsed, true);
    assert.equal(imported.tabs.work[0].groupRef, 'g1');
    assert.equal(imported.tabs.work[1].groupRef, undefined, 'dangling refs are ignored');
    assert.equal(imported.tabs.work.length, 3, 'duplicate URL rows remain distinct');
}

{
    const imported = API.normalizeImport({ tabs: { work: [
        'https://plain.test/',
        { url: 'https://legacy-a.test/', groupId: 4 },
        { url: 'https://legacy-b.test/', groupId: 4 },
        { url: 'https://plain.test/', groupId: -1 }
    ] } });
    assert.equal(imported.groups.length, 1, 'legacy native group ID creates a temporary import group');
    assert.equal(imported.groups[0].legacy, true);
    assert.equal(imported.tabs.work[1].groupRef, imported.tabs.work[2].groupRef);
    assert.equal(imported.tabs.work[0].groupRef, undefined);
    assert.equal(imported.tabs.work[3].groupRef, undefined);
}

{
    const absent = await fixture({
        tabs: [{ id: 1, windowId: 10, groupId: -1, url: 'https://a.test/' }], groups: []
    });
    assert.equal(absent.groups.length, 0, 'a successful lookup with no saved metadata is valid');
    assert.equal(absent.tabs.work[0].groupRef, undefined);

    await assert.rejects(
        fixture({ tabs: [{ id: 1, windowId: 10, groupId: -1, url: 'https://a.test/' }], groups: [], failQuery: true }),
        error => error.code === 'GROUP_SNAPSHOT_FAILED' && error.message.includes('group query failed')
    );
    await assert.rejects(
        fixture({ tabs: [{ id: 1, windowId: 10, groupId: -1, url: 'https://a.test/' }], groups: [], failReadId: 1 }),
        error => error.code === 'GROUP_SNAPSHOT_FAILED' && error.message.includes('session read failed')
    );
    await assert.rejects(
        fixture({ tabs: [{ id: 1, windowId: 10, groupId: 99, url: 'https://a.test/' }], groups: [] }),
        error => error.code === 'GROUP_SNAPSHOT_FAILED' && error.message.includes('Native group 99 is missing')
    );
}

console.log('group-snapshot tests passed (5 scenarios)');
