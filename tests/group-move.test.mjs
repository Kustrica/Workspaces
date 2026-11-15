import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function moveTabGroupToWorkspace(');
const end = source.indexOf('\nasync function moveTabsToWorkspace(', start);
assert.ok(start >= 0 && end > start);

function fixture(allTabsMode = false) {
    const tabs = [
        { id: 1, groupId: 8, windowId: 3 },
        { id: 2, groupId: 8, windowId: 3 },
        { id: 3, groupId: 9, windowId: 3 }
    ];
    const calls = [];
    const context = vm.createContext({
        Number, Set, Promise, Error,
        workspaces: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        tabWorkspaceMap: { 1: 'a', 2: 'a', 3: 'a' }, currentWorkspaceId: 'a', isAllTabsMode: allTabsMode,
        workspaceExists(id) { return context.workspaces.some(ws => ws.id === id); },
        async assignTabToWorkspace(id, ws) { context.tabWorkspaceMap[id] = ws; calls.push(['assign', id, ws]); },
        async saveState() { calls.push(['save']); },
        addLog(action, details, undoData) { calls.push(['log', action, undoData]); },
        async switchWorkspace(...args) { calls.push(['switch', ...args]); },
        browser: { tabs: {
            async get(id) { return tabs.find(tab => tab.id === id); },
            async query(query) { return tabs.filter(tab => tab.groupId === query.groupId && tab.windowId === query.windowId); },
            async move() { throw new Error('Group transfer must not move or ungroup native tabs'); }
        } }
    });
    vm.runInContext(source.slice(start, end), context);
    return { context, calls, tabs };
}

{
    const { context, calls, tabs } = fixture();
    assert.equal(await context.moveTabGroupToWorkspace(tabs[0], 'b'), true);
    assert.equal(context.tabWorkspaceMap[1], 'b');
    assert.equal(context.tabWorkspaceMap[2], 'b');
    assert.equal(context.tabWorkspaceMap[3], 'a');
    assert.equal(calls.filter(call => call[0] === 'switch').length, 1);
    assert.equal(calls.find(call => call[0] === 'log')[2].type, 'MOVE_GROUP');
    assert.deepEqual(Array.from(calls.find(call => call[0] === 'log')[2].data.members, m => m.workspaceId), ['a', 'a']);
}

{
    const { context, calls, tabs } = fixture(true);
    await context.moveTabGroupToWorkspace(tabs[0], 'b');
    assert.equal(calls.some(call => call[0] === 'switch'), false, 'All Tabs mode remains active');
    assert.equal(await context.moveTabGroupToWorkspace(tabs[0], 'missing'), false);
    tabs[0].groupId = -1;
    assert.equal(await context.moveTabGroupToWorkspace(tabs[0], 'b'), false);
}
console.log('group move tests passed');
