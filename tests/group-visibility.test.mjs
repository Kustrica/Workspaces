import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../group-visibility.js', import.meta.url), 'utf8');

function fixture({ splitViewId = -1, failSession = false, failSessionTab = null, delaySessionTab = null, failStyleOnce = false, failMarkerOnce = false, failFinalTitleOnce = false, eventTtlMs } = {}) {
    const tabs = [
        { id: 1, windowId: 9, groupId: 40, ...(splitViewId !== -1 ? { splitViewId } : {}) },
        { id: 2, windowId: 9, groupId: 40 },
        { id: 3, windowId: 9, groupId: -1 }
    ];
    const values = new Map();
    const calls = [];
    let tabQueries = 0;
    let groupQueries = 0;
    let markerFailed = false;
    let styleFailed = false;
    let finalTitleFailed = false;
    const nativeGroups = new Map([[40, { id: 40, title: 'Research', color: 'blue', collapsed: true, splitViewId }]]);
    const browser = {
        tabs: {
            async query() { tabQueries++; return tabs.map(tab => ({ ...tab })); },
            async ungroup(ids) { calls.push(['ungroup', [...ids]]); for (const tab of tabs) if (ids.includes(tab.id)) tab.groupId = -1; },
            async group({ tabIds, groupId }) {
                calls.push(['group', [...tabIds], groupId]);
                const resolved = groupId ?? 77;
                if (tabIds.length) nativeGroups.set(resolved, { id: resolved, title: '', color: 'grey', collapsed: false });
                for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = resolved;
                return resolved;
            }
        },
        tabGroups: {
            async query() { groupQueries++; return [...nativeGroups.values()].map(group => ({ ...group })); },
            async update(id, props) {
                calls.push(['update', id, props]);
                if ('title' in props && props.title.includes('⟦wv:') && failMarkerOnce && !markerFailed) {
                    markerFailed = true;
                    throw new Error('marker update failed before apply');
                }
                if (props.title === 'Research' && failFinalTitleOnce && !finalTitleFailed && id === 77) {
                    finalTitleFailed = true;
                    throw new Error('final title update failed before apply');
                }
                if (!('title' in props) && failStyleOnce && !styleFailed) {
                    styleFailed = true;
                    throw new Error('style update failed');
                }
                Object.assign(nativeGroups.get(id), props);
            }
        },
        sessions: {
            async setTabValue(id, key, value) {
                calls.push(['save', id]);
                if (id === delaySessionTab) await new Promise(resolve => setTimeout(resolve, 15));
                if (failSession || id === failSessionTab) throw new Error('session unavailable');
                values.set(id, structuredClone(value));
            },
            async getTabValue(id, key) { return values.get(id); },
            async removeTabValue(id) { values.delete(id); }
        }
    };
    const context = vm.createContext({ Date, Math, Map, Set, Promise, TypeError, Object, String, Number, Boolean, console, setTimeout, clearTimeout, crypto: { randomUUID: () => 'stable-token' } });
    vm.runInContext(source, context);
    return { api: context.WorkspacesGroupVisibility.create(browser, { eventTtlMs }), registry: context.WorkspacesGroupVisibility, calls, values, tabs, nativeGroups, get tabQueries() { return tabQueries; }, get groupQueries() { return groupQueries; } };
}

{
    const f = fixture();
    const result = await f.api.prepareForHide([1], id => id === 1 ? 'work' : 'other');
    assert.equal(result.ungrouped.length, 1);
    assert.equal(result.ungrouped[0].groupId, 40);
    assert.deepEqual(Array.from(result.ungrouped[0].tabIds), [1, 2], 'all members become metadata-backed fragments');
    assert.equal(f.values.get(2).originalIdentity, 'firefox-group:stable-token');
    assert.ok(f.calls.findIndex(call => call[0] === 'save') < f.calls.findIndex(call => call[0] === 'ungroup'));
    assert.equal((await f.api.getSavedMetadata(1)).workspaceId, 'work');
    const restored = await f.api.restoreVisible([1], 'work');
    assert.equal(restored.restored.length, 1);
    assert.equal(f.groupQueries, 2, 'one group query per hide and restore, with no extra query for a newly created group');
    assert.equal(f.nativeGroups.get(77).title, 'Research');
    assert.equal(f.nativeGroups.get(77).color, 'blue');
    assert.equal(await f.api.getSavedMetadata(1), null);
}

{
    const f = fixture();
    await f.api.prepareForHide([3], () => 'work');
    assert.equal(f.groupQueries, 0, 'hiding an ungrouped tab does not query native groups');
    assert.equal(f.calls.some(call => call[0] === 'ungroup'), false);
}

{
    const f = fixture();
    await f.api.prepareForHide([1], () => 'source');
    assert.equal(f.tabs[0].groupId, -1, 'test tab represents a hidden, temporarily ungrouped group member');
    const moved = await f.api.reassignSavedMetadata(1, 'destination');
    assert.equal(moved.updated, true);
    assert.equal(moved.metadata.workspaceId, 'destination');
    assert.equal(moved.metadata.identity, `${moved.metadata.originalIdentity}:workspace:destination`);
    const restored = await f.api.restoreVisible([1], 'destination');
    assert.equal(restored.restored.length, 1, 'moved hidden tab restores under its destination workspace');
    assert.equal(f.nativeGroups.get(77).title, 'Research');
}

{
    const f = fixture({ delaySessionTab: 1 });
    await f.api.prepareForHide([1], () => 'source');
    const move = f.api.reassignSavedMetadata(1, 'destination');
    const restore = f.api.restoreVisible([1], 'destination');
    assert.equal((await move).updated, true);
    assert.equal((await restore).restored.length, 1, 'restore waits for an in-flight workspace metadata transfer');
}

{
    const f = fixture();
    const moved = await f.api.reassignSavedMetadata(3, 'destination');
    assert.equal(moved.updated, false);
    assert.equal(f.calls.some(call => call[0] === 'save'), false, 'un-grouped tab without saved metadata causes no group metadata write');
}

{
    const f = fixture();
    const result = await f.api.restoreVisible([3], 'work');
    assert.equal(result.restored.length, 0);
    assert.equal(f.tabQueries, 0, 'no tab query when no saved group metadata exists');
    assert.equal(f.groupQueries, 0, 'no native group query when no saved metadata exists');
}

{
    const f = fixture({ failSessionTab: 2 });
    const result = await f.api.prepareForHide([1], () => 'work');
    assert.equal(result.errors[0].stage, 'save-session');
    assert.equal(f.calls.some(call => call[0] === 'ungroup'), false);
    assert.equal(f.values.size, 0, 'partial session writes finish before rollback runs');
}

{
    const f = fixture({ failSessionTab: 2, delaySessionTab: 1 });
    const result = await f.api.prepareForHide([1], () => 'work');
    assert.equal(result.errors[0].stage, 'save-session');
    assert.equal(f.values.size, 0, 'late successful writes are also rolled back');
    assert.equal(f.calls.some(call => call[0] === 'ungroup'), false);
}

{
    const f = fixture();
    await f.api.prepareForHide([1, 2], () => 'work');
    f.tabs[0].groupId = 88;
    f.tabs[1].groupId = 88;
    f.nativeGroups.set(88, { id: 88, title: 'My manual group', color: 'red', collapsed: false });
    const result = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(result.restored.length, 0);
    assert.equal(result.skipped.length, 2);
    assert.equal(f.nativeGroups.get(88).title, 'My manual group');
    assert.ok(await f.api.getSavedMetadata(1));
}

{
    const f = fixture({ failFinalTitleOnce: true });
    await f.api.prepareForHide([1, 2], () => 'work');
    const first = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(first.errors[0].stage, 'restore');
    assert.equal(f.nativeGroups.get(77).title.includes('⟦wv:'), true, 'ownership marker remains after final-title failure');
    assert.ok(await f.api.getSavedMetadata(1), 'session metadata remains available for retry');
    const retry = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(retry.restored.length, 1);
    assert.equal(f.nativeGroups.get(77).title, 'Research');
    assert.equal(await f.api.getSavedMetadata(1), null);
}

{
    const f = fixture({ failStyleOnce: true });
    await f.api.prepareForHide([1, 2], () => 'work');
    const first = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(first.errors[0].stage, 'restore');
    assert.equal(f.tabs[0].groupId, 77, 'group creation succeeded before metadata update failed');
    const retry = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(retry.restored.length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'group').length, 1, 'retry updates existing group without creating a duplicate');
    assert.equal(f.calls.filter(call => call[0] === 'update' && !('title' in call[2])).length, 2);
    assert.equal(await f.api.getSavedMetadata(1), null);
}

{
    const f = fixture({ failMarkerOnce: true });
    await f.api.prepareForHide([1, 2], () => 'work');
    const first = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(first.errors[0].stage, 'mark-owned');
    const marker = await f.api.restoreVisible([1, 2], 'work');
    assert.equal(marker.restored.length, 0);
    assert.equal(marker.skipped.length, 2, 'ambiguous group without marker is left untouched');
    assert.equal(f.calls.filter(call => call[0] === 'update').length, 1, 'retry did not rename a group without proof of ownership');
    assert.ok(await f.api.getSavedMetadata(1));
}

{
    const f = fixture({ splitViewId: 5 });
    const result = await f.api.prepareForHide([1], () => 'work');
    assert.equal(result.skipped[0].groupId, 40);
    assert.equal(result.skipped[0].reason, 'split-view');
    assert.deepEqual(Array.from(result.skipped[0].tabIds), [1, 2]);
    assert.equal(f.calls.some(call => call[0] === 'ungroup'), false);
}

{
    const f = fixture({ eventTtlMs: 20 });
    await f.api.prepareForHide([1], () => 'work');
    await f.api.restoreVisible([1], 'work');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.registry.consumeInternalTabGroupChange(1, -1), false, 'an unobserved ungroup event expires');
    assert.equal(f.registry.consumeInternalTabGroupChange(1, 77), false, 'an unobserved regroup event expires');
    assert.equal(f.registry.consumeInternalGroupUpdate({ id: 77, title: 'Research', color: 'blue', collapsed: true }), false,
        'an unobserved group update expires and cannot suppress later user styling');
}

console.log('group-visibility tests passed (13 scenarios)');
