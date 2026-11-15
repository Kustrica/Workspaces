import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../group-visibility.js', import.meta.url), 'utf8');
const start = background.indexOf('async function switchWorkspace(');
const end = background.indexOf('\n// Move specified tabs to the end', start);
assert.ok(start >= 0 && end > start, 'switchWorkspace source is available');

const tabs = [
    { id: 1, windowId: 9, groupId: 40, active: true, hidden: false, lastAccessed: 10 },
    { id: 2, windowId: 9, groupId: 40, active: false, hidden: true, lastAccessed: 20 }
];
const saved = new Map();
const calls = [];
const eventSuppressions = [];
const nativeGroups = new Map([[40, { id: 40, title: 'Research', color: 'blue', collapsed: true }]]);
const browser = {
    tabs: {
        async query(query = {}) {
            if (query.active) return tabs.filter(tab => tab.active).map(tab => ({ ...tab }));
            if (query.windowId != null) return tabs.filter(tab => tab.windowId === query.windowId).map(tab => ({ ...tab }));
            return tabs.map(tab => ({ ...tab }));
        },
        async show(ids) { calls.push(['show', [...ids]]); for (const tab of tabs) if (ids.includes(tab.id)) tab.hidden = false; },
        async hide(ids) {
            calls.push(['hide', [...ids]]);
            assert.ok(!ids.some(id => tabs.find(tab => tab.id === id)?.active), 'active tab is never hidden');
            for (const tab of tabs) if (ids.includes(tab.id)) tab.hidden = true;
        },
        async update(id, props) {
            calls.push(['update', id, props]);
            if (props.active) for (const tab of tabs) tab.active = tab.id === id;
        },
        async ungroup(ids) {
            calls.push(['ungroup', [...ids]]);
            for (const id of ids) eventSuppressions.push(context.WorkspacesGroupVisibility.consumeInternalTabGroupChange(id, -1));
            for (const tab of tabs) if (ids.includes(tab.id)) tab.groupId = -1;
        },
        async group({ tabIds, createProperties }) {
            const groupId = 77;
            calls.push(['group', [...tabIds], createProperties]);
            for (const id of tabIds) eventSuppressions.push(context.WorkspacesGroupVisibility.consumeInternalTabGroupChange(id, groupId));
            for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = groupId;
            nativeGroups.set(groupId, { id: groupId, title: '', color: 'grey', collapsed: false });
            return groupId;
        }
    },
    tabGroups: {
        async query() { return [...nativeGroups.values()].map(group => ({ ...group })); },
        async update(id, props) {
            Object.assign(nativeGroups.get(id), props);
            eventSuppressions.push(context.WorkspacesGroupVisibility.consumeInternalGroupUpdate(nativeGroups.get(id)));
        }
    },
    sessions: {
        async getTabValue(id, key) { return saved.get(`${id}:${key}`) || null; },
        async setTabValue(id, key, value) { saved.set(`${id}:${key}`, structuredClone(value)); },
        async removeTabValue(id, key) { saved.delete(`${id}:${key}`); }
    }
};

const context = vm.createContext({
    browser, console, Map, Set, Promise, Object, String, Number, Boolean, Array, Date, Math, TypeError, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'group-switch-test' },
    currentWorkspaceId: 'workspace-a', isAllTabsMode: false, lastActiveWsId: 'workspace-a',
    tabWorkspaceMap: { 1: 'workspace-a', 2: 'workspace-b' },
    workspaceActiveTabMap: {}, pendingTabAssignments: new Set(),
    isSwitchingWorkspace: false, pendingWorkspaceSwitch: null,
    resolveExistingWorkspaceId: id => id,
    saveState: async () => {},
    normalizeTabId: value => Number(value),
    pickBestWorkspaceTabId: (list, workspaceId) => list.find(tab => context.tabWorkspaceMap[tab.id] === workspaceId)?.id ?? null,
    assignTabToWorkspace: async () => {}, rememberTabMeta: () => {}
});
vm.runInContext(moduleSource, context);
vm.runInContext(background.slice(start, end), context);

await context.switchWorkspace('workspace-b');

assert.deepEqual(calls.find(call => call[0] === 'ungroup'), ['ungroup', [1, 2]], 'all source group members are ungrouped before hiding');
assert.deepEqual(calls.find(call => call[0] === 'hide'), ['hide', [1]], 'old workspace tab is hidden after ungrouping');
assert.equal(tabs.find(tab => tab.id === 2).hidden, false, 'target workspace tab stays visible');
assert.equal(tabs.find(tab => tab.id === 2).active, true, 'target workspace tab becomes active');
assert.equal(calls.some(call => call[0] === 'group' && call[1].includes(2)), true, 'visible destination fragment is regrouped after ungrouping all members');
assert.notEqual(tabs.find(tab => tab.id === 2).groupId, -1, 'mixed source group target member is restored as a native group');
assert.equal(eventSuppressions.every(Boolean), true, 'native group API events from workspace switching are suppressed');
assert.equal(saved.get('1:workspacesNativeGroup').workspaceId, 'workspace-a');
assert.equal(saved.get('2:workspacesNativeGroup'), undefined, 'restored destination fragment clears its temporary metadata');

// Exercise the real assignment hook for a tab already ungrouped by workspace hiding.
const assignStart = background.indexOf('function assignTabToWorkspace(');
const assignEnd = background.indexOf('\nfunction unassignTab(', assignStart);
assert.ok(assignStart >= 0 && assignEnd > assignStart, 'assignTabToWorkspace source is available');
context.tabWorkspaceMap[1] = 'workspace-a';
vm.runInContext(background.slice(assignStart, assignEnd), context);
context.TAB_WORKSPACE_SESSION_KEY = 'workspaceId';
context.setSessionWorkspace = (tabId, workspaceId) => browser.sessions.setTabValue(tabId, 'workspaceId', workspaceId);
await context.assignTabToWorkspace(1, 'workspace-c');
assert.equal(saved.get('1:workspaceId'), 'workspace-c', 'workspace ownership session value follows the move');
assert.equal(saved.get('1:workspacesNativeGroup').workspaceId, 'workspace-c', 'saved native group metadata follows the move');
assert.equal(saved.get('1:workspacesNativeGroup').identity.endsWith(':workspace:workspace-c'), true);
console.log('group-visibility integration test passed (workspace switch, ungroup-before-hide)');
