/* Native Firefox tab group preservation around workspace tab hiding.
 * Load as a classic script. Exposes WorkspacesGroupVisibility.create(browser).
 */
(function (root) {
    'use strict';

    const SESSION_KEY = 'workspacesNativeGroup';
    const pendingMetadataOperations = new Map();
    const internalTabMutations = new Map();
    const internalGroupMutations = new Map();
    const expectedTabGroupChanges = new Map();
    const observedTabGroupChanges = new Map();
    const expectedGroupUpdates = new Map();
    const DEFAULT_EVENT_TTL_MS = 2000;
    const MAX_EXPECTED_EVENTS = 512;
    let eventTtlMs = DEFAULT_EVENT_TTL_MS;
    let cleanupTimer = null;
    let cleanupDeadline = 0;
    const markerFor = token => `⟦wv:${token}⟧`;
    const markedTitle = (title, token) => `${title || ''}\u2063${markerFor(token)}`;

    function create(browserApi, options = {}) {
        if (!browserApi?.tabs || !browserApi?.sessions) {
            throw new TypeError('tabs and sessions APIs are required');
        }
        if (Number.isFinite(options.eventTtlMs) && options.eventTtlMs > 0) {
            eventTtlMs = Math.min(options.eventTtlMs, DEFAULT_EVENT_TTL_MS);
        }

        async function prepareForHide(tabIds, workspaceForTab) {
            const ids = [...new Set((tabIds || []).filter(Number.isInteger))];
            const result = { ungrouped: [], skipped: [], errors: [] };
            if (!ids.length) return result;
            const tabs = await browserApi.tabs.query({});
            const selected = new Set(ids);
            const groups = new Map();
            for (const tab of tabs) {
                if (tab.groupId == null || tab.groupId < 0) continue;
                if (!groups.has(tab.groupId)) groups.set(tab.groupId, []);
                groups.get(tab.groupId).push(tab);
            }
            if (![...groups.values()].some(members => members.some(tab => selected.has(tab.id)))) return result;
            const nativeGroups = new Map((await browserApi.tabGroups.query({})).map(group => [group.id, group]));

            for (const [nativeGroupId, members] of groups) {
                const affected = members.filter(tab => selected.has(tab.id));
                if (!affected.length) continue;
                await waitForMetadataOperations(members.map(tab => tab.id));
                const group = nativeGroups.get(nativeGroupId);
                if (!group) {
                    result.skipped.push({ groupId: nativeGroupId, reason: 'metadata-unavailable' });
                    continue;
                }
                if (members.some(tab => tab.splitViewId != null && tab.splitViewId !== -1)) {
                    result.skipped.push({ groupId: nativeGroupId, tabIds: members.map(tab => tab.id), reason: 'split-view' });
                    continue;
                }
                // Reuse an earlier token when a group was hidden in workspace-sized pieces.
                const previousReads = await Promise.allSettled(members.map(tab => browserApi.sessions.getTabValue(tab.id, SESSION_KEY)));
                if (previousReads.some(item => item.status === 'rejected')) {
                    result.errors.push({ groupId: nativeGroupId, stage: 'read-session', error: 'Could not read existing group metadata' });
                    continue;
                }
                const previous = previousReads.map(item => item.value);
                let identity = previous.find(saved => saved?.originalIdentity)?.originalIdentity || null;
                let operationToken = previous.find(saved => saved?.operationToken)?.operationToken || null;
                if (!identity) {
                    const token = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    identity = `firefox-group:${token}`;
                }
                if (!operationToken) operationToken = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                // Store a workspace-specific fragment. This lets another workspace keep its own
                // group fragment and avoids joining tabs hidden by a different workspace.
                const snapshots = new Map(members.map((tab, index) => [tab.id, previous[index]]));
                const valuesByTab = new Map();
                let workspaceMissing = false;
                for (const tab of members) {
                    const workspaceId = workspaceForTab(tab.id);
                    if (workspaceId == null) { workspaceMissing = true; break; }
                    valuesByTab.set(tab.id, {
                        version: 1,
                        identity: `${identity}:workspace:${String(workspaceId)}`,
                        originalIdentity: identity,
                        operationToken,
                        workspaceId,
                        title: group.title || '',
                        color: group.color || 'grey',
                        collapsed: Boolean(group.collapsed),
                        windowId: tab.windowId,
                        savedAt: Date.now()
                    });
                }
                if (workspaceMissing) {
                    result.errors.push({ groupId: nativeGroupId, stage: 'save-session', error: 'Workspace missing for a group tab' });
                    continue;
                }
                const writes = await Promise.allSettled(members.map(tab => browserApi.sessions.setTabValue(tab.id, SESSION_KEY, valuesByTab.get(tab.id))));
                if (writes.some(entry => entry.status === 'rejected')) {
                    const error = writes.find(entry => entry.status === 'rejected').reason;
                    const rollback = await Promise.allSettled(members.map(async tab => {
                        const oldValue = snapshots.get(tab.id);
                        if (oldValue == null) await browserApi.sessions.removeTabValue(tab.id, SESSION_KEY);
                        else await browserApi.sessions.setTabValue(tab.id, SESSION_KEY, oldValue);
                    }));
                    const rollbackFailed = rollback.some(item => item.status === 'rejected');
                    result.errors.push({ groupId: nativeGroupId, stage: 'save-session', rollbackFailed, error: String(error) });
                    continue; // Never ungroup without durable metadata on every affected tab.
                }
                try {
                    // Ungroup every member of this native group after saving per-workspace
                    // metadata. Leaving untouched members grouped would leave stale session
                    // records that could later resurrect a group the user manually removed.
                    const memberIds = members.map(tab => tab.id);
                    registerExpectedTabGroupChange(memberIds, -1);
                    try {
                        await withInternalMutations(internalTabMutations, memberIds, () =>
                            browserApi.tabs.ungroup(memberIds));
                    } catch (error) {
                        unregisterExpectedTabGroupChange(memberIds, -1);
                        throw error;
                    }
                    result.ungrouped.push({ groupId: nativeGroupId, tabIds: memberIds });
                } catch (error) {
                    result.errors.push({ groupId: nativeGroupId, stage: 'ungroup', error: String(error) });
                }
            }
            return result;
        }

        async function restoreVisible(tabIds, workspaceId) {
            const result = { restored: [], skipped: [], errors: [] };
            const ids = [...new Set((tabIds || []).filter(Number.isInteger))];
            if (!ids.length) return result;
            await waitForMetadataOperations(ids);
            const wanted = new Set(ids);
            const savedReads = await Promise.allSettled(ids.map(tabId => browserApi.sessions.getTabValue(tabId, SESSION_KEY)));
            const savedByTab = new Map();
            for (let index = 0; index < savedReads.length; index++) {
                const read = savedReads[index];
                if (read.status === 'rejected') {
                    result.errors.push({ tabId: ids[index], stage: 'read-session', error: String(read.reason) });
                    continue;
                }
                const meta = read.value;
                if (meta?.version === 1 && String(meta.workspaceId) === String(workspaceId)) savedByTab.set(ids[index], meta);
            }
            if (!savedByTab.size) return result;
            const tabs = await browserApi.tabs.query({});
            const nativeGroups = await browserApi.tabGroups.query({});
            const groupById = new Map(nativeGroups.map(group => [group.id, group]));
            const groups = new Map();
            for (const tab of tabs) {
                if (!wanted.has(tab.id)) continue;
                try {
                    const meta = savedByTab.get(tab.id);
                    if (!meta) continue;
                    if (!groups.has(meta.identity)) groups.set(meta.identity, { meta, tabs: [], groupIds: new Set(), finalizedGroupIds: new Set() });
                    const item = groups.get(meta.identity);
                    if (tab.groupId != null && tab.groupId >= 0) {
                        const liveGroup = groupById.get(tab.groupId);
                        if (meta.operationToken && liveGroup?.title === markedTitle(meta.title, meta.operationToken)) {
                            item.groupIds.add(tab.groupId);
                            item.tabs.push(tab);
                        } else if (meta.restoreStage === 'finalizing' && liveGroup?.title === (meta.title || '')
                            && liveGroup.color === (meta.color || 'grey') && Boolean(liveGroup.collapsed) === Boolean(meta.collapsed)) {
                            item.finalizedGroupIds.add(tab.groupId);
                            item.tabs.push(tab);
                        } else {
                            result.skipped.push({ tabId: tab.id, reason: 'already-grouped' });
                        }
                    } else {
                        item.tabs.push(tab);
                    }
                } catch (error) { result.errors.push({ tabId: tab.id, stage: 'restore', error: String(error) }); }
            }

            for (const [identity, item] of groups) {
                const members = item.tabs;
                const meta = item.meta;
                const byWindow = new Map();
                for (const tab of members) {
                    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
                    byWindow.get(tab.windowId).push(tab);
                }
                for (const [windowId, windowTabs] of byWindow) {
                    try {
                        const existingGroupId = [...item.groupIds][0];
                        if (windowTabs.every(tab => item.finalizedGroupIds.has(tab.groupId))) {
                            const clears = await Promise.allSettled(windowTabs.map(tab => browserApi.sessions.removeTabValue(tab.id, SESSION_KEY)));
                            for (let index = 0; index < clears.length; index++) {
                                if (clears[index].status === 'rejected') result.errors.push({ tabId: windowTabs[index].id, stage: 'clear-session', error: String(clears[index].reason) });
                            }
                            if (clears.every(entry => entry.status === 'fulfilled')) result.restored.push({ identity, groupId: windowTabs[0].groupId, tabIds: windowTabs.map(tab => tab.id) });
                            continue;
                        }
                        const additions = windowTabs.filter(tab => tab.groupId !== existingGroupId);
                        const groupedTabs = existingGroupId == null ? windowTabs : additions;
                        const groupId = existingGroupId == null
                            ? await withInternalMutations(internalTabMutations, groupedTabs.map(tab => tab.id), () =>
                                browserApi.tabs.group({ tabIds: groupedTabs.map(tab => tab.id), createProperties: { windowId } }))
                            : groupedTabs.length
                                ? await withInternalMutations(internalTabMutations, groupedTabs.map(tab => tab.id), () =>
                                    browserApi.tabs.group({ tabIds: groupedTabs.map(tab => tab.id), groupId: existingGroupId }))
                                : existingGroupId;
                        if (groupedTabs.length) registerExpectedTabGroupChange(groupedTabs.map(tab => tab.id), groupId);
                        // The tokenized title is the ownership marker. Numeric group IDs can be
                        // reused, so never treat the ID journal alone as proof of ownership.
                        // A new group cannot already carry our recovery marker. For a
                        // retry, use the group snapshot already fetched above.
                        let liveGroup = existingGroupId == null ? null : groupById.get(groupId);
                        const marker = markedTitle(meta.title, meta.operationToken);
                        if (liveGroup?.title !== marker) {
                            try {
                                await withExpectedGroupUpdate(groupId, { title: marker });
                            } catch (error) {
                                // An API rejection may follow an applied update; confirm the marker.
                                liveGroup = (await browserApi.tabGroups.query({})).find(group => group.id === groupId);
                                if (liveGroup?.title !== marker) throw Object.assign(error, { stage: 'mark-owned' });
                            }
                        }
                        await withExpectedGroupUpdate(groupId, {
                            color: meta.color || 'grey',
                            collapsed: Boolean(meta.collapsed)
                        });
                        // Journal completion while the ownership marker remains visible, then
                        // publish the original title. A retry can safely finish either stage.
                        const stages = await Promise.allSettled(windowTabs.map(async tab => {
                            const current = await browserApi.sessions.getTabValue(tab.id, SESSION_KEY);
                            if (current) await browserApi.sessions.setTabValue(tab.id, SESSION_KEY, { ...current, restoreStage: 'finalizing' });
                        }));
                        if (stages.some(entry => entry.status === 'rejected')) {
                            result.errors.push({ identity, groupId, tabIds: windowTabs.map(tab => tab.id), stage: 'journal-finalizing' });
                            continue;
                        }
                        try {
                            await withExpectedGroupUpdate(groupId, { title: meta.title || '' });
                        } catch (error) {
                            const updated = (await browserApi.tabGroups.query({})).find(group => group.id === groupId);
                            if (updated?.title !== (meta.title || '')) throw error;
                        }
                        const clears = await Promise.allSettled(windowTabs.map(tab => browserApi.sessions.removeTabValue(tab.id, SESSION_KEY)));
                        for (let index = 0; index < clears.length; index++) {
                            if (clears[index].status === 'rejected') result.errors.push({ tabId: windowTabs[index].id, stage: 'clear-session', error: String(clears[index].reason) });
                        }
                        if (clears.every(entry => entry.status === 'fulfilled')) result.restored.push({ identity, groupId, tabIds: windowTabs.map(tab => tab.id) });
                    } catch (error) {
                        result.errors.push({ identity, tabIds: windowTabs.map(tab => tab.id), stage: error.stage || 'restore', error: String(error) });
                    }
                }
            }
            return result;
        }

        async function getSavedMetadata(tabId) {
            try {
                const meta = await browserApi.sessions.getTabValue(tabId, SESSION_KEY);
                return meta?.version === 1 ? meta : null;
            } catch (_) {
                return null;
            }
        }

        async function reassignSavedMetadata(tabId, workspaceId) {
            if (!Number.isInteger(tabId) || workspaceId == null) return { updated: false, reason: 'invalid-args' };
            const previous = pendingMetadataOperations.get(tabId);
            const operation = (async () => {
                if (previous) await previous.catch(() => {});
                let meta;
                try {
                    meta = await browserApi.sessions.getTabValue(tabId, SESSION_KEY);
                } catch (error) {
                    return { updated: false, reason: 'read-failed', error: String(error) };
                }
                if (!meta || meta.version !== 1 || String(meta.workspaceId) === String(workspaceId)) {
                    return { updated: false, reason: 'no-change' };
                }
                const originalIdentity = meta.originalIdentity || String(meta.identity || '').replace(/:workspace:[^:]*$/, '');
                if (!originalIdentity) return { updated: false, reason: 'identity-missing' };
                const updated = {
                    ...meta,
                    identity: `${originalIdentity}:workspace:${String(workspaceId)}`,
                    originalIdentity,
                    workspaceId
                };
                try {
                    await browserApi.sessions.setTabValue(tabId, SESSION_KEY, updated);
                    return { updated: true, metadata: updated };
                } catch (error) {
                    return { updated: false, reason: 'write-failed', error: String(error) };
                }
            })();
            pendingMetadataOperations.set(tabId, operation);
            try {
                return await operation;
            } finally {
                if (pendingMetadataOperations.get(tabId) === operation) pendingMetadataOperations.delete(tabId);
            }
        }

        async function waitForMetadataOperations(tabIds) {
            const pending = [...new Set(tabIds)].map(tabId => pendingMetadataOperations.get(tabId)).filter(Boolean);
            if (pending.length) await Promise.allSettled(pending);
        }

        async function withInternalMutations(registry, ids, operation) {
            const uniqueIds = [...new Set(ids)];
            for (const id of uniqueIds) registry.set(id, (registry.get(id) || 0) + 1);
            try {
                return await operation();
            } finally {
                for (const id of uniqueIds) {
                    const remaining = (registry.get(id) || 1) - 1;
                    if (remaining > 0) registry.set(id, remaining);
                    else registry.delete(id);
                }
            }
        }

        async function withExpectedGroupUpdate(groupId, props) {
            registerExpectedGroupUpdate(groupId, props);
            try {
                return await withInternalMutations(internalGroupMutations, [groupId], () =>
                    browserApi.tabGroups.update(groupId, props));
            } catch (error) {
                unregisterExpectedGroupUpdate(groupId, props);
                throw error;
            }
        }

        async function clearSavedMetadata(tabId) {
            try {
                await browserApi.sessions.removeTabValue(tabId, SESSION_KEY);
                return true;
            } catch (_) {
                return false;
            }
        }

        return Object.freeze({ prepareForHide, restoreVisible, getSavedMetadata, reassignSavedMetadata, clearSavedMetadata, sessionKey: SESSION_KEY });
    }

    const changeKey = (tabId, groupId) => `${tabId}\u0000${groupId}`;
    function pruneExpiredExpectedEvents(now = Date.now()) {
        for (const registry of [expectedTabGroupChanges, observedTabGroupChanges]) {
            for (const [key, entry] of registry) if (entry.expiresAt <= now) registry.delete(key);
        }
        for (const [groupId, updates] of expectedGroupUpdates) {
            const active = updates.filter(item => item.expiresAt > now);
            if (active.length) expectedGroupUpdates.set(groupId, active);
            else expectedGroupUpdates.delete(groupId);
        }
    }
    function pendingExpectedEventCount() {
        let count = 0;
        for (const registry of [expectedTabGroupChanges, observedTabGroupChanges]) {
            for (const entry of registry.values()) count += entry.count;
        }
        for (const updates of expectedGroupUpdates.values()) count += updates.length;
        return count;
    }
    function enforceExpectedEventLimit() {
        while (pendingExpectedEventCount() > MAX_EXPECTED_EVENTS) {
            let oldest = null;
            for (const registry of [expectedTabGroupChanges, observedTabGroupChanges]) {
                for (const [key, entry] of registry) {
                    if (!oldest || entry.expiresAt < oldest.expiresAt) oldest = { registry, key, expiresAt: entry.expiresAt };
                }
            }
            for (const [groupId, updates] of expectedGroupUpdates) {
                for (const item of updates) {
                    if (!oldest || item.expiresAt < oldest.expiresAt) oldest = { registry: expectedGroupUpdates, key: groupId, item, expiresAt: item.expiresAt };
                }
            }
            if (!oldest) break;
            if (oldest.registry === expectedGroupUpdates) {
                const updates = expectedGroupUpdates.get(oldest.key) || [];
                const index = updates.indexOf(oldest.item);
                if (index >= 0) updates.splice(index, 1);
                if (!updates.length) expectedGroupUpdates.delete(oldest.key);
            } else {
                oldest.registry.delete(oldest.key);
            }
        }
    }
    function scheduleExpectedEventCleanup() {
        pruneExpiredExpectedEvents();
        if (!pendingExpectedEventCount()) {
            if (cleanupTimer != null) clearTimeout(cleanupTimer);
            cleanupTimer = null;
            cleanupDeadline = 0;
            return;
        }
        let nearest = Infinity;
        for (const registry of [expectedTabGroupChanges, observedTabGroupChanges]) {
            for (const entry of registry.values()) nearest = Math.min(nearest, entry.expiresAt);
        }
        for (const updates of expectedGroupUpdates.values()) {
            for (const item of updates) nearest = Math.min(nearest, item.expiresAt);
        }
        if (cleanupTimer != null && cleanupDeadline <= nearest) return;
        if (cleanupTimer != null) clearTimeout(cleanupTimer);
        cleanupDeadline = nearest;
        cleanupTimer = setTimeout(() => {
            cleanupTimer = null;
            cleanupDeadline = 0;
            scheduleExpectedEventCleanup();
        }, Math.max(0, nearest - Date.now()));
    }
    function addCount(registry, key, count = 1) {
        const now = Date.now();
        const existing = registry.get(key);
        registry.set(key, { count: (existing?.count || 0) + count, expiresAt: now + eventTtlMs });
        enforceExpectedEventLimit();
        scheduleExpectedEventCleanup();
    }
    function removeCount(registry, key) {
        const entry = registry.get(key);
        if (!entry) return;
        if (entry.count <= 1) registry.delete(key);
        else entry.count--;
        scheduleExpectedEventCleanup();
    }
    function registerExpectedTabGroupChange(tabIds, groupId) {
        pruneExpiredExpectedEvents();
        for (const tabId of tabIds) {
            const key = changeKey(tabId, groupId);
            const observed = observedTabGroupChanges.get(key);
            if (observed?.count > 0) {
                removeCount(observedTabGroupChanges, key);
                continue;
            }
            addCount(expectedTabGroupChanges, key);
        }
    }
    function unregisterExpectedTabGroupChange(tabIds, groupId) {
        for (const tabId of tabIds) {
            removeCount(expectedTabGroupChanges, changeKey(tabId, groupId));
        }
    }
    function registerExpectedGroupUpdate(groupId, props) {
        pruneExpiredExpectedEvents();
        if (!expectedGroupUpdates.has(groupId)) expectedGroupUpdates.set(groupId, []);
        expectedGroupUpdates.get(groupId).push({ props: { ...props }, expiresAt: Date.now() + eventTtlMs });
        enforceExpectedEventLimit();
        scheduleExpectedEventCleanup();
    }
    function unregisterExpectedGroupUpdate(groupId, props) {
        const updates = expectedGroupUpdates.get(groupId) || [];
        const index = updates.findIndex(item => Object.keys(props).every(key => item.props[key] === props[key]));
        if (index >= 0) updates.splice(index, 1);
        if (!updates.length) expectedGroupUpdates.delete(groupId);
        scheduleExpectedEventCleanup();
    }
    function consumeInternalTabGroupChange(tabId, groupId) {
        pruneExpiredExpectedEvents();
        const key = changeKey(tabId, groupId);
        if ((expectedTabGroupChanges.get(key)?.count || 0) > 0) {
            removeCount(expectedTabGroupChanges, key);
            return true;
        }
        if ((internalTabMutations.get(tabId) || 0) > 0) {
            addCount(observedTabGroupChanges, key);
            return true;
        }
        return false;
    }
    function consumeInternalGroupUpdate(group) {
        pruneExpiredExpectedEvents();
        const updates = expectedGroupUpdates.get(group?.id) || [];
        const index = updates.findIndex(item => Object.keys(item.props).every(key => group[key] === item.props[key]));
        if (index >= 0) {
            updates.splice(index, 1);
            if (!updates.length) expectedGroupUpdates.delete(group.id);
            scheduleExpectedEventCleanup();
            return true;
        }
        return (internalGroupMutations.get(group?.id) || 0) > 0;
    }

    root.WorkspacesGroupVisibility = Object.freeze({
        create,
        consumeInternalTabGroupChange,
        consumeInternalGroupUpdate,
        sessionKey: SESSION_KEY
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
