/* Portable snapshots for native tab-group metadata.
 * Exposes WorkspacesGroupSnapshot.create(browser) as a classic script.
 */
(function (root) {
    'use strict';

    const SESSION_KEY = 'workspacesNativeGroup';
    const stableCache = new Map();
    const COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

    function cleanColor(value) {
        return COLORS.has(value) ? value : 'grey';
    }

    function cleanText(value) {
        return typeof value === 'string' ? value : '';
    }

    async function mapBounded(items, fn, concurrency = 32) {
        const results = new Array(items.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await fn(items[index], index);
            }
        }));
        return results;
    }

    function create(browserApi) {
        if (!browserApi?.sessions?.getTabValue) throw new TypeError('sessions.getTabValue is required');

        async function capture(tabs, workspaceForTab, options = {}) {
            const sourceTabs = Array.isArray(tabs) ? tabs : [];
            const windowRefs = new Map();
            const groupRecords = new Map();
            const groupIdsByKey = new Map();
            const rows = {};
            const rowTabs = [];
            let nextGroup = 1;
            let nextWindow = 1;

            const getWorkspace = tab => typeof workspaceForTab === 'function'
                ? workspaceForTab(tab.id)
                : workspaceForTab?.[tab.id];
            const windowRef = id => {
                const key = String(id);
                if (!windowRefs.has(key)) windowRefs.set(key, `window-${nextWindow++}`);
                return windowRefs.get(key);
            };

            let nativeGroups = [];
            if (browserApi.tabGroups?.query) {
                try {
                    nativeGroups = await browserApi.tabGroups.query({});
                } catch (error) {
                    throw makeSnapshotError('Unable to read native tab groups', error);
                }
            }
            const nativeById = new Map(nativeGroups.map(group => [group.id, group]));
            const sessionValues = await mapBounded(sourceTabs, async (tab, index) => {
                const native = nativeById.get(tab.groupId);
                if (native && !(native.title || '').includes('\u2063⟦wv:')) return null;
                try {
                    const value = await browserApi.sessions.getTabValue(tab.id, SESSION_KEY);
                    return value?.version === 1 ? value : null;
                } catch (error) {
                    throw makeSnapshotError(`Unable to read saved group metadata for tab at index ${index}`, error);
                }
            });

            sourceTabs.forEach((tab, index) => {
                const workspaceId = getWorkspace(tab);
                if (workspaceId == null || !tab || !Number.isInteger(tab.id)) return;
                const ws = String(workspaceId);
                if (!rows[ws]) rows[ws] = [];
                const sourceWindow = windowRef(tab.windowId);
                const hasNativeGroup = tab.groupId != null && tab.groupId >= 0;
                const nativeGroup = hasNativeGroup ? nativeById.get(tab.groupId) : null;
                const saved = sessionValues[index];

                if (hasNativeGroup && !nativeGroup) {
                    throw makeSnapshotError(`Native group ${tab.groupId} is missing for tab ${tab.id}`);
                }

                let key = null;
                let metadata = null;
                if (nativeGroup) {
                    key = `native\u0000${sourceWindow}\u0000${ws}\u0000${tab.groupId}`;
                    const marker = saved?.operationToken && `${saved.title || ''}\u2063⟦wv:${saved.operationToken}⟧`;
                    metadata = marker && nativeGroup.title === marker ? saved : nativeGroup;
                } else if (saved && String(saved.workspaceId) === ws && saved.identity) {
                    key = `saved\u0000${sourceWindow}\u0000${ws}\u0000${saved.identity}`;
                    metadata = saved;
                }

                let groupRef = null;
                if (key) {
                    if (!groupIdsByKey.has(key)) {
                        const id = `group-${nextGroup++}`;
                        groupIdsByKey.set(key, id);
                        groupRecords.set(key, {
                            id,
                            workspaceId: ws,
                            sourceWindow,
                            title: cleanText(metadata.title),
                            color: cleanColor(metadata.color),
                            collapsed: Boolean(metadata.collapsed)
                        });
                    }
                    groupRef = groupIdsByKey.get(key);
                }

                const row = { url: typeof tab.url === 'string' ? tab.url : '' };
                if (groupRef) row.groupRef = groupRef;
                rows[ws].push(row);
                rowTabs.push({ row, tab, workspaceId: ws });
            });

            const groups = Array.from(groupRecords.values());
            if (options.stableIds) {
                const token = () => root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
                const present = new Set(sourceTabs.map(tab => tab.id));
                for (const id of stableCache.keys()) if (!present.has(id)) stableCache.delete(id);
                const saved = await mapBounded(rowTabs, async ({ tab }) => {
                    if (stableCache.has(tab.id)) return stableCache.get(tab.id);
                    const value = {
                        group: await browserApi.sessions.getTabValue(tab.id, 'workspacesGroupSyncRef'),
                        tab: await browserApi.sessions.getTabValue(tab.id, 'workspacesSyncTabId')
                    };
                    stableCache.set(tab.id, value);
                    return value;
                });
                const portableByRef = new Map();
                const candidates = new Map();
                for (let index = 0; index < rowTabs.length; index++) {
                    const ref = rowTabs[index].row.groupRef;
                    const value = saved[index].group;
                    if (ref && typeof value === 'string' && value && !candidates.has(ref)) candidates.set(ref, value);
                }
                const usedIds = new Set();
                for (const group of groups) {
                    let id = candidates.get(group.id);
                    if (!id || usedIds.has(id)) id = `group:${token()}`;
                    usedIds.add(id);
                    portableByRef.set(group.id, id);
                }
                const usedTabIds = new Set();
                await mapBounded(rowTabs, async (entry, index) => {
                    let tabId = typeof saved[index].tab === 'string' && saved[index].tab ? saved[index].tab : null;
                    if (!tabId || usedTabIds.has(tabId)) tabId = `tab:${token()}`;
                    usedTabIds.add(tabId);
                    entry.row.instanceId = tabId;
                    entry.row.liveTabId = entry.tab.id;
                    const writes = [];
                    if (saved[index].tab !== tabId) writes.push(browserApi.sessions.setTabValue(entry.tab.id, 'workspacesSyncTabId', tabId));
                    if (entry.row.groupRef) {
                        const groupId = portableByRef.get(entry.row.groupRef);
                        entry.row.groupRef = groupId;
                        if (saved[index].group !== groupId) writes.push(browserApi.sessions.setTabValue(entry.tab.id, 'workspacesGroupSyncRef', groupId));
                    } else if (saved[index].group && browserApi.sessions.removeTabValue) {
                        writes.push(browserApi.sessions.removeTabValue(entry.tab.id, 'workspacesGroupSyncRef'));
                    }
                    await Promise.all(writes);
                    stableCache.set(entry.tab.id, { tab: tabId, group: entry.row.groupRef || null });
                });
                for (const group of groups) group.id = portableByRef.get(group.id);
            }
            return { groups, tabs: rows };
        }

        return Object.freeze({ capture, sessionKey: SESSION_KEY });
    }

    function makeSnapshotError(message, cause) {
        const error = new Error(cause ? `${message}: ${String(cause.message || cause)}` : message);
        error.code = 'GROUP_SNAPSHOT_FAILED';
        if (cause) error.cause = cause;
        return error;
    }

    // Pure import normalizer. Legacy numeric group IDs are only meaningful inside the
    // source file, so they become temporary refs scoped by workspace and source window.
    function normalizeImport(data) {
        const input = data && typeof data === 'object' ? data : {};
        const sourceTabs = input.tabs && typeof input.tabs === 'object' ? input.tabs : {};
        const groups = [];
        const groupByRef = new Map();
        const tabs = {};

        if (Array.isArray(input.groups)) {
            for (const source of input.groups) {
                if (!source || typeof source.id !== 'string' || !source.id || source.workspaceId == null) continue;
                const id = source.id;
                const workspaceId = String(source.workspaceId);
                const key = `${workspaceId}\u0000${id}`;
                if (groupByRef.has(key)) continue;
                const group = {
                    id,
                    workspaceId,
                    sourceWindow: typeof source.sourceWindow === 'string' ? source.sourceWindow : 'window-1',
                    title: cleanText(source.title),
                    color: cleanColor(source.color),
                    collapsed: Boolean(source.collapsed)
                };
                groupByRef.set(key, group);
                groups.push(group);
            }
        }

        for (const [workspaceIdRaw, list] of Object.entries(sourceTabs)) {
            const workspaceId = String(workspaceIdRaw);
            if (!Array.isArray(list)) continue;
            tabs[workspaceId] = list.map(entry => {
                if (typeof entry === 'string') return { url: entry };
                if (!entry || typeof entry !== 'object') return { url: '' };
                const row = { url: typeof entry.url === 'string' ? entry.url : (typeof entry.u === 'string' ? entry.u : '') };
                if (typeof entry.groupRef === 'string') {
                    const group = groupByRef.get(`${workspaceId}\u0000${entry.groupRef}`);
                    if (group) row.groupRef = group.id;
                } else if (Number.isInteger(entry.groupId) && entry.groupId >= 0) {
                    const id = `legacy-${workspaceId}-${entry.groupId}`;
                    const key = `${workspaceId}\u0000${id}`;
                    if (!groupByRef.has(key)) {
                        const group = {
                            id,
                            workspaceId,
                            sourceWindow: 'legacy-window',
                            title: '',
                            color: 'grey',
                            collapsed: false,
                            legacy: true
                        };
                        groupByRef.set(key, group);
                        groups.push(group);
                    }
                    row.groupRef = id;
                }
                return row;
            });
        }

        return { groups, tabs };
    }

    root.WorkspacesGroupSnapshot = Object.freeze({ create, normalizeImport, sessionKey: SESSION_KEY,
        invalidate(tabId) { stableCache.delete(tabId); } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
