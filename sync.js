// sync.js — cross-device sync for Workspaces via Mozilla account + browser.storage.sync
//
// Design notes (see NOTES.md):
//   * Only `browser.storage.sync` is used. No custom server, no OAuth, no new permissions.
//   * The synced document is compact (short keys), gzip-compressed when the browser exposes
//     CompressionStream, base64-encoded and then CHUNKED, because storage.sync enforces
//     8 KB PER ITEM even when the 100 KB total is not reached.
//   * Live tab integer ids, tabWorkspaceMap, autoBackups and action logs are never synced.
//   * This file is loaded both in the background script and in the options page. It only
//     exposes pure helpers plus raw read/write of the sync area — all state decisions are
//     made in background.js so there is a single source of truth.
(function (global) {
    'use strict';

    const SYNC_DOC_VERSION = 2;

    const META_KEY = 'sync_meta';
    const CHUNK_PREFIX = 'sync_payload_';

    // MDN: storage.sync → 102400 bytes total, 8192 bytes per item, 512 items max.
    const QUOTA_TOTAL_BYTES = 102400;
    const QUOTA_ITEM_BYTES = 8192;

    // Base64 chars per chunk. 6000 chars + key name + JSON quoting stays well under 8192 bytes.
    const CHUNK_CHARS = 6000;
    // 100 KB total quota is the real ceiling; this is only a runaway guard.
    const MAX_CHUNKS = 64;

    const ENC_GZIP = 'gzip';
    const ENC_PLAIN = 'plain';

    // Tombstones keep deletions authoritative for this long. Any device that is used at all
    // within the window learns about the deletion; after that the record is garbage-collected.
    const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    // Settings that should travel between devices. Deliberately excludes autoBackups
    // (huge), actionLogs, tabWorkspaceMap and anything keyed by ephemeral tab ids.
    const SYNCED_SETTING_KEYS = [
        'theme',
        'ui_language',
        // Time of the user's explicit language choice. Without it ui_language never syncs:
        // "Auto" or an old value nobody picked must not overwrite another device.
        'ui_language_set_at',
        'areActionsVisible',
        'autoBackupEnabled',
        'autoBackupFrequency',
        'autoBackupFreqIsMinutes',
        'autoBackupMax',
        'autoBackupStorageMax',
        'backupOnStartup'
    ];

    // ---------------------------------------------------------------- base64

    function bytesToBase64(bytes) {
        let out = '';
        const step = 0x8000; // avoid "too many arguments" on large payloads
        for (let i = 0; i < bytes.length; i += step) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        return btoa(out);
    }

    function base64ToBytes(b64) {
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes;
    }

    // ------------------------------------------------------------ compression

    function hasCompression() {
        return typeof global.CompressionStream === 'function' &&
               typeof global.DecompressionStream === 'function';
    }

    async function gzipString(str) {
        const input = new TextEncoder().encode(str);
        const stream = new global.CompressionStream('gzip');
        const writer = stream.writable.getWriter();
        writer.write(input);
        writer.close();
        const buf = await new Response(stream.readable).arrayBuffer();
        return new Uint8Array(buf);
    }

    async function gunzipToString(bytes) {
        const stream = new global.DecompressionStream('gzip');
        const writer = stream.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const buf = await new Response(stream.readable).arrayBuffer();
        return new TextDecoder().decode(buf);
    }

    // ------------------------------------------------------------ fingerprint

    // Stable FNV-1a over a canonical projection of workspaces + tab urls.
    // Settings are NOT part of it: a theme change must not look like a data conflict.
    function dataFingerprint(doc) {
        if (!doc) return '0';
        const parts = [];
        const list = Array.isArray(doc.ws) ? doc.ws : [];
        for (const ws of list) {
            parts.push('W', String(ws.i), String(ws.n || ''), String(ws.c || ''));
            const tabs = (doc.t && doc.t[ws.i]) || [];
            for (const entry of tabs) {
                // Same shape as export: one fingerprint slot per tab row (duplicates count).
                parts.push('U', typeof entry === 'string' ? entry : String(entry.u || ''));
            }
        }
        const str = parts.join('');
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16) + ':' + str.length;
    }

    // ------------------------------------------------------------- doc build

    // workspaces: [{ id, name, icon, ... }]
    // tabsByWorkspace: { wsId: [{ url, groupId }] } — same list shape as export/import.
    // extras: { revs: { wsId: { r, m } }, tombstones: { w: {}, u: {} } }
    //
    // `r` (revision) and `m` (mtime) per workspace are what makes automatic convergence
    // possible without asking the user anything: the higher revision wins, and tombstones
    // beat resurrections. They are bumped by background.js on real local edits only.
    function buildSyncDoc(workspaces, tabsByWorkspace, settings, deviceId, extras) {
        const revs = (extras && extras.revs) || {};
        const doc = {
            v: SYNC_DOC_VERSION,
            ts: Date.now(),
            dev: deviceId || null,
            ws: [],
            t: {},
            s: {},
            x: tombstonesToDoc(gcTombstones((extras && extras.tombstones) || emptyTombstones()))
        };

        (workspaces || []).forEach((ws, index) => {
            if (!ws || !ws.id) return;
            const rev = revs[ws.id] || {};
            const entry = {
                i: ws.id,
                n: ws.name || '',
                o: index,
                r: Number(rev.r) || 0,
                m: Number(rev.m) || 0
            };
            if (ws.icon) entry.c = ws.icon;
            doc.ws.push(entry);

            // Export/import style: every open tab is one row. Duplicate URLs stay duplicate.
            const tabs = (tabsByWorkspace && tabsByWorkspace[ws.id]) || [];
            const packed = [];
            for (const tab of tabs) {
                const url = typeof tab === 'string' ? tab : (tab && tab.url);
                if (!isSyncableUrl(url)) continue;
                const groupId = (tab && typeof tab === 'object' && tab.groupId !== undefined) ? tab.groupId : -1;
                const addedAt = (tab && typeof tab === 'object' && tab.a) ? Number(tab.a) : 0;
                if (groupId === -1 && !addedAt) {
                    packed.push(url);
                } else {
                    const row = { u: url };
                    if (groupId !== -1) row.g = groupId;
                    if (addedAt) row.a = addedAt;
                    packed.push(row);
                }
            }
            doc.t[ws.id] = packed;
        });

        if (settings) {
            for (const key of SYNCED_SETTING_KEYS) {
                if (settings[key] !== undefined) doc.s[key] = settings[key];
            }
            resolveLanguageSetting(doc.s, settings);
        }

        return doc;
    }

    // The interface language travels only as an explicit, timestamped choice; the newest
    // choice wins. Values without a choice time (defaults, older versions) are dropped.
    function resolveLanguageSetting(target, ...sources) {
        delete target.ui_language;
        delete target.ui_language_set_at;
        const choice = sources
            .filter(s => s && typeof s.ui_language === 'string' && Number(s.ui_language_set_at) > 0)
            .sort((a, b) => Number(b.ui_language_set_at) - Number(a.ui_language_set_at))[0];
        if (choice) {
            target.ui_language = choice.ui_language;
            target.ui_language_set_at = Number(choice.ui_language_set_at);
        }
        return target;
    }

    // about:* / moz-extension: pages cannot be recreated meaningfully on another device.
    function isSyncableUrl(url) {
        if (!url || typeof url !== 'string') return false;
        if (url === 'about:blank' || url === 'about:newtab' || url === 'about:home') return false;
        if (url.startsWith('moz-extension:') || url.startsWith('chrome:')) return false;
        if (url.startsWith('about:reader?url=')) return true;
        if (url.startsWith('about:')) return false;
        return true;
    }

    // Convert a sync document back into the shape RESTORE_DATA / import already understand.
    function docToRestoreData(doc) {
        const workspaces = [];
        const tabs = {};
        const list = Array.isArray(doc && doc.ws) ? doc.ws.slice() : [];
        list.sort((a, b) => (a.o || 0) - (b.o || 0));
        for (const ws of list) {
            workspaces.push({ id: ws.i, name: ws.n || '', icon: ws.c || 'img:icons/main-64.png' });
            const packed = (doc.t && doc.t[ws.i]) || [];
            tabs[ws.i] = packed.map((entry) =>
                typeof entry === 'string'
                    ? { url: entry, groupId: -1 }
                    : { url: entry.u, groupId: entry.g === undefined ? -1 : entry.g }
            );
        }
        return { workspaces, tabs, settings: (doc && doc.s) || {}, timestamp: (doc && doc.ts) || 0 };
    }

    function summarize(doc) {
        if (!doc || !Array.isArray(doc.ws)) return { workspaces: 0, tabs: 0 };
        let tabs = 0;
        for (const ws of doc.ws) {
            const list = (doc.t && doc.t[ws.i]) || [];
            tabs += list.length;
        }
        return { workspaces: doc.ws.length, tabs };
    }

    function isEmptyDoc(doc) {
        const s = summarize(doc);
        return s.workspaces === 0 && s.tabs === 0;
    }

    // Ids seeded by getLocalizedDefaults() on a fresh install. A device that only has those
    // workspaces and no mapped tabs has nothing of its own to lose, so it must NOT raise a
    // conflict dialog against a populated account — it just adopts the synced data.
    const DEFAULT_WORKSPACE_IDS = ['ws_default', 'ws_study', 'ws_work', 'ws_music', 'ws_cooking'];

    function isPristineDefaultDoc(doc) {
        if (!doc || !Array.isArray(doc.ws) || doc.ws.length === 0) return false;
        if (summarize(doc).tabs > 0) return false;
        return doc.ws.every((ws) => DEFAULT_WORKSPACE_IDS.includes(ws.i));
    }

    // --------------------------------------------------------- tombstone store
    //
    // Deletions must be facts, not absences: a plain union merge resurrects every tab the
    // user closes. The store lives in storage.local on each device and travels inside the
    // document as `x`.
    //   store = { w: { wsId: ts }, u: { "wsId\nurl": { t, n } | ts } }
    // `n` = how many closes of that URL (export-style lists allow duplicate URLs).

    function tombKey(wsId, url) {
        return String(wsId) + '\n' + String(url);
    }

    function emptyTombstones() {
        return { w: {}, u: {} };
    }

    function tombMeta(val) {
        if (!val) return { t: 0, n: 0 };
        if (typeof val === 'number') return { t: val, n: 1 };
        return { t: Number(val.t) || 0, n: Math.max(0, Number(val.n) || 0) };
    }

    function normalizeTombstones(store) {
        const out = emptyTombstones();
        if (!store) return out;
        for (const [key, ts] of Object.entries(store.w || {})) {
            const n = Number(ts) || 0;
            if (n > 0) out.w[key] = n;
        }
        for (const [key, val] of Object.entries(store.u || {})) {
            const meta = tombMeta(val);
            if (meta.n > 0 && meta.t > 0) out.u[key] = { t: meta.t, n: meta.n };
        }
        return out;
    }

    function mergeTombstoneStores(a, b) {
        const out = normalizeTombstones(a);
        const other = normalizeTombstones(b);
        for (const [key, ts] of Object.entries(other.w)) {
            if (!out.w[key] || ts > out.w[key]) out.w[key] = ts;
        }
        for (const [key, val] of Object.entries(other.u)) {
            const cur = tombMeta(out.u[key]);
            const incoming = tombMeta(val);
            out.u[key] = {
                t: Math.max(cur.t, incoming.t),
                n: Math.max(cur.n, incoming.n)
            };
        }
        return out;
    }

    function mergeTombstonesThreeWay(base, local, remote) {
        const b = normalizeTombstones(base);
        const l = normalizeTombstones(local);
        const r = normalizeTombstones(remote);
        const out = emptyTombstones();
        for (const key of new Set([...Object.keys(b.w), ...Object.keys(l.w), ...Object.keys(r.w)])) {
            const bv = b.w[key] || 0;
            const lv = l.w[key] || 0;
            const rv = r.w[key] || 0;
            const chosen = lv === bv ? rv : (rv === bv || lv === rv ? lv : Math.max(lv, rv));
            if (chosen) out.w[key] = chosen;
        }
        for (const key of new Set([...Object.keys(b.u), ...Object.keys(l.u), ...Object.keys(r.u)])) {
            const bv = tombMeta(b.u[key]);
            const lv = tombMeta(l.u[key]);
            const rv = tombMeta(r.u[key]);
            const equal = (a, c) => a.t === c.t && a.n === c.n;
            let chosen;
            if (equal(lv, bv)) chosen = rv;
            else if (equal(rv, bv) || equal(lv, rv)) chosen = lv;
            else chosen = { t: Math.max(lv.t, rv.t), n: Math.max(lv.n, rv.n) };
            if (chosen.t && chosen.n) out.u[key] = chosen;
        }
        return out;
    }

    function gcTombstones(store, now = Date.now(), ttl = TOMBSTONE_TTL_MS) {
        const out = emptyTombstones();
        for (const [key, ts] of Object.entries(normalizeTombstones(store).w)) {
            if (now - ts < ttl) out.w[key] = ts;
        }
        for (const [key, val] of Object.entries(normalizeTombstones(store).u)) {
            const meta = tombMeta(val);
            if (meta.t && now - meta.t < ttl) out.u[key] = { t: meta.t, n: meta.n };
        }
        return out;
    }

    // Compact array form for the synced document: [wsId, url, t, n]
    function tombstonesToDoc(store) {
        const clean = normalizeTombstones(store);
        return {
            w: Object.entries(clean.w).sort(([a], [b]) => a.localeCompare(b)).map(([id, ts]) => [id, ts]),
            u: Object.entries(clean.u).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => {
                const cut = key.indexOf('\n');
                const meta = tombMeta(val);
                return [key.slice(0, cut), key.slice(cut + 1), meta.t, meta.n];
            })
        };
    }

    function tombstonesFromDoc(doc) {
        const out = emptyTombstones();
        const x = doc && doc.x;
        if (!x) return out;
        for (const row of x.w || []) {
            if (!row || !row[0]) continue;
            out.w[row[0]] = Number(row[1]) || 0;
        }
        for (const row of x.u || []) {
            if (!row || !row[0] || !row[1]) continue;
            const t = Number(row[2]) || 0;
            const n = row.length > 3 ? Math.max(1, Number(row[3]) || 1) : 1;
            if (t) out.u[tombKey(row[0], row[1])] = { t, n };
        }
        return out;
    }

    function tabAddedAt(entry) {
        if (entry && typeof entry === 'object') return Number(entry.a) || 0;
        return 0;
    }

    function urlOf(entry) {
        return typeof entry === 'string' ? entry : (entry && entry.u);
    }

    function isDeleted(tombTs, contentTs) {
        return !!tombTs && tombTs >= (contentTs || 0);
    }

    function wsMtime(ws, doc) {
        return (ws && ws.m) || (doc && doc.ts) || 0;
    }

    function countUrls(list) {
        const m = new Map();
        for (const entry of list || []) {
            const url = urlOf(entry);
            if (!url) continue;
            const cur = m.get(url) || { n: 0, sample: entry };
            cur.n += 1;
            m.set(url, cur);
        }
        return m;
    }

    function countUrlBirths(list, url) {
        const counts = new Map();
        for (const entry of list || []) {
            if (urlOf(entry) !== url) continue;
            const born = tabAddedAt(entry);
            const key = born > 0 ? `born:${born}` : 'legacy';
            const bucket = counts.get(key) || { count: 0, born, sample: entry };
            bucket.count++;
            counts.set(key, bucket);
        }
        return counts;
    }

    /** Preserve URL multiplicities while merging additions, closes and shared birth cohorts. */
    function mergeTabLists(wsId, localList, remoteList, tombs, baseList, localTombs, remoteTombs, baseTombs) {
        const lc = countUrls(localList);
        const rc = countUrls(remoteList);
        const urls = new Set([...lc.keys(), ...rc.keys(), ...countUrls(baseList).keys()]);
        const out = [];
        const bc = baseList ? countUrls(baseList) : null;
        for (const url of urls) {
            const ln = (lc.get(url) && lc.get(url).n) || 0;
            const rn = (rc.get(url) && rc.get(url).n) || 0;
            const raw = Math.max(ln, rn);
            const key = tombKey(wsId, url);
            const tm = tombMeta(tombs.u[key]);
            if (bc) {
                const bn = (bc.get(url) && bc.get(url).n) || 0;
                if (bn > 0) {
                    // Existing URL counts retain the established three-way arithmetic;
                    // birth cohorts resolve the ambiguous first arrival from an empty base.
                    // Absence is not a close operation. Only an explicit close record
                    // can reduce the ancestor count, and it cannot close a newer birth.
                    const allowedCloses = store => {
                        const close = tombMeta(store && store.u[key]);
                        const previous = tombMeta(baseTombs && baseTombs.u[key]);
                        if (!close.n || close.t < previous.t ||
                            (close.t === previous.t && close.n <= previous.n)) return 0;
                        const eligible = (baseList || []).filter(entry =>
                            urlOf(entry) === url && tabAddedAt(entry) <= close.t).length;
                        const count = close.t > previous.t ? Math.max(1, close.n - previous.n)
                            : Math.max(0, close.n - previous.n);
                        return Math.min(eligible, count);
                    };
                    const l = Math.max(ln, bn - allowedCloses(localTombs));
                    const r = Math.max(rn, bn - allowedCloses(remoteTombs));
                    const n = l === bn ? r : r === bn ? l
                        : Math.max(0, bn + (l - bn) + (r - bn));
                    const source = ln >= rn ? localList : remoteList;
                    const rows = (source || []).filter((entry) => urlOf(entry) === url);
                    const fallback = (baseList || []).filter(entry => urlOf(entry) === url);
                    for (let i = 0; i < n; i++) out.push(rows[i % rows.length] || fallback[i % fallback.length] || url);
                    continue;
                }
                // Merge birth cohorts separately. A remote tab copied back to its source
                // keeps the same birth time, so it is one open; separate local opens have
                // different birth times and remain separate tabs even when their URLs match.
                const lb = countUrlBirths(localList, url);
                const rb = countUrlBirths(remoteList, url);
                const bb = countUrlBirths(baseList, url);
                const cohorts = new Set([...lb.keys(), ...rb.keys(), ...bb.keys()]);
                let remainingCloses = tm.n;
                for (const cohort of cohorts) {
                    const l = lb.get(cohort) || { count: 0, born: 0, sample: null };
                    const r = rb.get(cohort) || { count: 0, born: l.born, sample: null };
                    const b = bb.get(cohort) || { count: 0, born: l.born || r.born, sample: null };
                    let n;
                    if (cohort !== 'legacy' && l.count > b.count && r.count > b.count) {
                        // Both snapshots contain the same new birth cohort. Do not add an
                        // already-replicated tab twice when their saved base is behind.
                        n = Math.max(l.count, r.count);
                    } else {
                        n = l.count === b.count ? r.count : r.count === b.count ? l.count
                            : Math.max(0, b.count + (l.count - b.count) + (r.count - b.count));
                    }
                    if (remainingCloses > 0 && (l.born || r.born) <= tm.t) {
                        const closed = Math.min(n, remainingCloses);
                        n -= closed;
                        remainingCloses -= closed;
                    }
                    const rows = (l.count >= r.count ? localList : remoteList)
                        .filter((entry) => urlOf(entry) === url &&
                            (tabAddedAt(entry) > 0 ? `born:${tabAddedAt(entry)}` : 'legacy') === cohort);
                    for (let i = 0; i < n; i++) out.push(rows[i % rows.length] || l.sample || r.sample || url);
                }
                continue;
            }
            // Reopens (addedAt > tomb time) consume close-counts.
            let tombN = tm.n;
            if (tombN > 0 && tm.t > 0) {
                const fresh = [...(localList || []), ...(remoteList || [])]
                    .filter((e) => urlOf(e) === url && tabAddedAt(e) > tm.t).length;
                tombN = Math.max(0, tombN - fresh);
            }

            let resultN;
            if (ln === rn) {
                // Agreement between two copies does not acknowledge every offline peer.
                resultN = ln;
            } else {
                resultN = Math.max(0, raw - tombN);
            }

            const sample = (ln >= rn
                ? (lc.get(url) && lc.get(url).sample)
                : (rc.get(url) && rc.get(url).sample)) || url;
            for (let i = 0; i < resultN; i++) {
                if (typeof sample === 'string') out.push(sample);
                else out.push(Object.assign({}, sample));
            }
        }
        return out;
    }

    function tombstoneFingerprint(value) {
        const records = value || { w: [], u: [] };
        const ordered = rows => (rows || []).slice().sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
        const str = JSON.stringify({ w: ordered(records.w), u: ordered(records.u) });
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return `${hash.toString(16)}:${str.length}`;
    }

    function mergeDocTombstones(local, remote, base) {
        const lx = tombstonesFromDoc(local), rx = tombstonesFromDoc(remote);
        // Missing records can be an old snapshot, not a completed cleanup. The
        // compactor publishes a receipt only after every member acknowledged them.
        if (local.g && local.g.fp === tombstoneFingerprint(remote.x)) return lx;
        if (remote.g && remote.g.fp === tombstoneFingerprint(local.x)) return rx;
        const acknowledged = base && [local.g, remote.g].some(receipt =>
            receipt && receipt.fp === tombstoneFingerprint(base.x));
        return acknowledged ? mergeTombstonesThreeWay(tombstonesFromDoc(base), lx, rx)
            : mergeTombstoneStores(lx, rx);
    }

    // Tombstone-aware merge. Workspaces are matched by id, then by trimmed/lowercased name
    // (author's decision: same name = one workspace even when icons differ). Per workspace the
    // higher revision wins for name/icon/order; tab lists use export-style multiset merge.
    function mergeDocs(localDoc, remoteDoc, baseDoc = null) {
        const now = Date.now();
        const mergedTombstones = mergeDocTombstones(localDoc, remoteDoc, baseDoc);
        const tombs = gcTombstones(
            mergedTombstones,
            now
        );

        const merged = {
            v: SYNC_DOC_VERSION,
            ts: now,
            dev: localDoc && localDoc.dev,
            ws: [],
            t: {},
            s: Object.assign({}, (remoteDoc && remoteDoc.s) || {}, (localDoc && localDoc.s) || {}),
            x: null
        };
        const receipts = [localDoc.g, remoteDoc.g].filter(Boolean).sort((a, b) => b.ts - a.ts);
        if (receipts.length) merged.g = receipts[0];
        if (baseDoc) {
            // Retain peer settings unless this device changed them since the base.
            merged.s = Object.assign({}, (remoteDoc && remoteDoc.s) || {});
            for (const [key, value] of Object.entries((localDoc && localDoc.s) || {})) {
                if (JSON.stringify(value) !== JSON.stringify((baseDoc.s || {})[key])) merged.s[key] = value;
            }
        }
        resolveLanguageSetting(merged.s, localDoc && localDoc.s, remoteDoc && remoteDoc.s);

        const byId = new Map();
        const byName = new Map();
        const tabSources = new Map(); // targetWsId -> { local: [], remote: [] }

        const addWorkspace = (ws, sourceDoc) => {
            if (!ws || !ws.i) return null;
            if (isDeleted(tombs.w[ws.i], wsMtime(ws, sourceDoc))) return null;

            const nameKey = (ws.n || '').trim().toLowerCase();
            let target = byId.get(ws.i) || (!baseDoc && nameKey ? byName.get(nameKey) : null);
            if (target) {
                const mine = Number(target.r) || 0;
                const theirs = Number(ws.r) || 0;
                if (theirs > mine) {
                    target.n = ws.n || target.n;
                    target.c = ws.c || target.c;
                    target.r = theirs;
                    target.m = Number(ws.m) || target.m;
                }
                return target;
            }

            const entry = {
                i: ws.i,
                n: ws.n || '',
                o: merged.ws.length,
                r: Number(ws.r) || 0,
                m: Number(ws.m) || 0
            };
            if (ws.c) entry.c = ws.c;
            merged.ws.push(entry);
            merged.t[entry.i] = [];
            byId.set(entry.i, entry);
            if (nameKey) byName.set(nameKey, entry);
            return entry;
        };

        for (const [sourceIndex, source] of [localDoc, remoteDoc].entries()) {
            if (!source || !Array.isArray(source.ws)) continue;
            const isLocal = sourceIndex === 0;
            const ordered = source.ws.slice().sort((a, b) => (a.o || 0) - (b.o || 0));
            for (const ws of ordered) {
                const target = addWorkspace(ws, source);
                if (!target) continue;
                const slot = tabSources.get(target.i) || { local: [], remote: [] };
                const list = (source.t && source.t[ws.i]) || [];
                if (isLocal) slot.local = slot.local.concat(list);
                else slot.remote = slot.remote.concat(list);
                tabSources.set(target.i, slot);
            }
        }

        for (const ws of merged.ws) {
            const slot = tabSources.get(ws.i) || { local: [], remote: [] };
            merged.t[ws.i] = mergeTabLists(ws.i, slot.local, slot.remote, tombs,
                baseDoc ? ((baseDoc.t && baseDoc.t[ws.i]) || []) : null,
                tombstonesFromDoc(localDoc), tombstonesFromDoc(remoteDoc), tombstonesFromDoc(baseDoc));
        }

        merged.ws.forEach((ws, index) => { ws.o = index; });
        merged.x = tombstonesToDoc(tombs);
        return merged;
    }
    // Tombstone-aware merge. Workspaces are matched by id, then by trimmed/lowercased name

    // ----------------------------------------------------- tab identity / creation plan
    //
    // Field bug (1.18): a tab created by the apply reports about:blank while it loads, and a
    // different URL after a redirect. The diff then saw the requested URL as still missing and
    // created it AGAIN on the next cycle — 165 tabs grew past 300. The requested URL therefore
    // stays the tab's identity until it has finished loading.
    function tabSyncIdentity(tab, intendedUrl) {
        if (intendedUrl) return intendedUrl;
        return (tab && (tab.pendingUrl || tab.url)) || null;
    }

    function identityKey(workspaceId, url) {
        return String(workspaceId) + '\n' + String(url);
    }

    // Live guard against a stale diff. existingCounts: Map/Set/array of URL identity keys
    // with how many tabs already exist (export-style multiset).
    function planCreations(adds, existingCounts) {
        const counts = new Map();
        if (existingCounts instanceof Map) {
            for (const [k, n] of existingCounts) counts.set(k, Number(n) || 0);
        } else if (Array.isArray(existingCounts)) {
            for (const row of existingCounts) {
                if (Array.isArray(row)) counts.set(row[0], Number(row[1]) || 0);
                else counts.set(row, (counts.get(row) || 0) + 1);
            }
        } else if (existingCounts && typeof existingCounts[Symbol.iterator] === 'function') {
            for (const k of existingCounts) counts.set(k, (counts.get(k) || 0) + 1);
        }
        const plan = [];
        for (const add of adds || []) {
            if (!add || !add.url || !add.wsId) continue;
            const key = identityKey(add.wsId, add.url);
            const have = counts.get(key) || 0;
            if (have > 0) {
                counts.set(key, have - 1);
                continue;
            }
            plan.push(add);
        }
        return plan;
    }

    // ------------------------------------------------------------- decision core
    function decideSync(input) {
        const i = input || {};

        if (!i.hasRemote) return i.localEmpty ? 'NOOP' : 'SEED';
        if (i.localFp && i.remoteFp && i.localFp === i.remoteFp) return 'IN_SYNC';

        if (!i.joined) {
            if (i.remoteEmpty && !i.localEmpty) return 'SEED';
            if (!i.remoteEmpty) return (i.localEmpty || i.localPristine) ? 'ADOPT' : 'JOIN_PROMPT';
            return 'NOOP';
        }

        if (i.remoteEmpty && !i.localEmpty && !i.baseFp) return 'PUSH';

        const localChanged = !i.baseFp || i.localFp !== i.baseFp;
        const remoteChanged = !i.baseFp || i.remoteFp !== i.baseFp;

        if (!localChanged && remoteChanged) return 'FAST_FORWARD';
        if (localChanged && !remoteChanged) return 'PUSH';
        return 'MERGE';
    }

    // --------------------------------------------------------------- doc diff
    // Compares export-style lists by URL multiset counts.
    function docDiff(localDoc, targetDoc) {
        const result = {
            workspacesUpsert: [],
            workspaceIdsRemove: [],
            tabsAdd: [],
            tabsRemove: [],
            changed: false
        };
        if (!targetDoc) return result;

        const localWs = new Map((localDoc && localDoc.ws ? localDoc.ws : []).map((w) => [w.i, w]));
        const targetWs = new Map((targetDoc.ws || []).map((w) => [w.i, w]));

        (targetDoc.ws || []).forEach((ws, index) => {
            const mine = localWs.get(ws.i);
            if (!mine || mine.n !== ws.n || (mine.c || '') !== (ws.c || '') || (mine.o || 0) !== index) {
                result.workspacesUpsert.push({
                    id: ws.i,
                    name: ws.n || '',
                    icon: ws.c || '',
                    order: index
                });
            }
        });

        for (const id of localWs.keys()) {
            if (!targetWs.has(id)) result.workspaceIdsRemove.push(id);
        }

        for (const ws of targetDoc.ws || []) {
            const targetList = (targetDoc.t && targetDoc.t[ws.i]) || [];
            const localList = (localDoc && localDoc.t && localDoc.t[ws.i]) || [];
            const localCounts = countUrls(localList);
            const targetCounts = countUrls(targetList);
            const urls = new Set([...localCounts.keys(), ...targetCounts.keys()]);

            for (const url of urls) {
                const ln = (localCounts.get(url) && localCounts.get(url).n) || 0;
                const tn = (targetCounts.get(url) && targetCounts.get(url).n) || 0;
                const sample = (targetCounts.get(url) && targetCounts.get(url).sample) ||
                    (localCounts.get(url) && localCounts.get(url).sample) || url;
                const groupId = (sample && typeof sample === 'object' && sample.g !== undefined)
                    ? sample.g : -1;
                for (let i = 0; i < tn - ln; i++) {
                    result.tabsAdd.push({ wsId: ws.i, url, groupId });
                }
                for (let i = 0; i < ln - tn; i++) {
                    result.tabsRemove.push({ wsId: ws.i, url });
                }
            }
        }

        for (const id of result.workspaceIdsRemove) {
            const localList = (localDoc && localDoc.t && localDoc.t[id]) || [];
            for (const entry of localList) {
                const url = urlOf(entry);
                if (url) result.tabsRemove.push({ wsId: id, url });
            }
        }

        result.changed = result.workspacesUpsert.length > 0 ||
            result.workspaceIdsRemove.length > 0 ||
            result.tabsAdd.length > 0 ||
            result.tabsRemove.length > 0;
        return result;
    }

    // ----------------------------------------------------------- sync area IO

    function syncArea() {
        return (global.browser && global.browser.storage && global.browser.storage.sync) || null;
    }

    function isAvailable() {
        return !!syncArea();
    }

    function newGeneration() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    async function pack(doc, generation) {
        const gen = generation || newGeneration();
        const json = JSON.stringify(doc);
        let encoding = ENC_PLAIN;
        let body = json;

        if (hasCompression()) {
            try {
                body = bytesToBase64(await gzipString(json));
                encoding = ENC_GZIP;
            } catch (e) {
                encoding = ENC_PLAIN;
                body = json;
            }
        }

        const chunks = [];
        for (let i = 0; i < body.length;) {
            let end = Math.min(body.length, i + CHUNK_CHARS);
            // JSON quoting and UTF-8 characters also occupy the per-item quota.
            while (new TextEncoder().encode(JSON.stringify(body.slice(i, end))).length > 7900) {
                end = i + Math.floor((end - i) * 0.8);
            }
            chunks.push(body.slice(i, end));
            i = end;
        }

        return {
            meta: {
                v: SYNC_DOC_VERSION,
                enc: encoding,
                chunks: chunks.length,
                len: body.length,
                rawBytes: new TextEncoder().encode(json).length,
                packedBytes: new TextEncoder().encode(body).length,
                fp: dataFingerprint(doc),
                ts: doc.ts || Date.now(),
                dev: doc.dev || null,
                gen,
                digest: await payloadDigest(body)
            },
            gen,
            chunks
        };
    }

    async function unpack(meta, chunkValues) {
        if (!meta) return null;
        const body = chunkValues.join('');
        if (meta.len && body.length !== meta.len) {
            throw makeError('INCOMPLETE', 'Synced payload is incomplete');
        }
        if (meta.digest && await payloadDigest(body) !== meta.digest) {
            throw makeError('INCOMPLETE', 'Sync chunks belong to different writes');
        }
        const json = meta.enc === ENC_GZIP ? await gunzipToString(base64ToBytes(body)) : body;
        const doc = JSON.parse(json);
        if (meta.fp && dataFingerprint(doc) !== meta.fp) {
            throw makeError('INCOMPLETE', 'Sync fingerprint mismatch');
        }
        return doc;
    }

    async function payloadDigest(body) {
        const bytes = new TextEncoder().encode(body);
        const hash = await global.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    }

    // Chunk keys carry the generation: storage.sync is last-write-wins PER KEY with no
    // transaction across keys, so two devices writing at the same time could otherwise
    // interleave slices of two different documents into one plausible-looking payload.
    // Legacy 1.14–1.17 payloads have no generation and use sync_payload_<i>.
    function chunkKey(gen, index) {
        return gen ? CHUNK_PREFIX + gen + '_' + index : CHUNK_PREFIX + index;
    }

    function makeError(code, message) {
        const err = new Error(message || code);
        err.code = code;
        return err;
    }

    async function readSyncDoc() {
        const area = syncArea();
        if (!area) throw makeError('UNAVAILABLE', 'storage.sync is not available');

        let stored;
        try {
            stored = await area.get(null);
        } catch (e) {
            throw makeError('NOT_SIGNED_IN', e && e.message);
        }

        const meta = stored && stored[META_KEY];
        if (!meta || !meta.chunks) return { doc: null, meta: null };

        const chunkValues = [];
        for (let i = 0; i < meta.chunks; i++) {
            const value = stored[chunkKey(meta.gen, i)];
            if (typeof value !== 'string') {
                const error = makeError('INCOMPLETE', 'Missing sync chunk ' + i);
                error.meta = meta;
                throw error;
            }
            chunkValues.push(value);
        }

        try {
            return { doc: await unpack(meta, chunkValues), meta };
        } catch (error) {
            if (!error.code) error.code = 'INCOMPLETE';
            error.meta = meta;
            throw error;
        }
    }

    async function writeSyncDoc(doc) {
        const area = syncArea();
        if (!area) throw makeError('UNAVAILABLE', 'storage.sync is not available');

        const existing = await area.get(null);
        // Retire orphaned generations before quota preflight. Keep every currently
        // referenced chunk until the replacement has been successfully written.
        const oldMeta = existing[META_KEY];
        const liveKeys = new Set();
        if (oldMeta) for (let i = 0; i < oldMeta.chunks; i++) liveKeys.add(chunkKey(oldMeta.gen, i));
        const orphans = Object.keys(existing).filter(key => key.startsWith(CHUNK_PREFIX) && !liveKeys.has(key));
        if (orphans.length) {
            await area.remove(orphans);
            for (const key of orphans) delete existing[key];
        }
        // Reuse the current key namespace: replacing a 76 KB snapshot must not need
        // another 76 KB. The digest prevents partial/per-key delivery from being applied.
        const namespace = existing[META_KEY] && existing[META_KEY].gen;
        const packed = await pack(doc, namespace || 'slots');
        if (existing[META_KEY] && !namespace) {
            packed.gen = null;
            packed.meta.gen = null;
        }
        if (packed.chunks.length > MAX_CHUNKS) throw makeError('QUOTA', 'Payload needs too many chunks');

        const payload = { [META_KEY]: packed.meta };
        packed.chunks.forEach((chunk, index) => {
            payload[chunkKey(packed.gen, index)] = chunk;
        });

        // Pre-flight quota math so we fail with a clear error instead of a raw API rejection.
        // Count the resulting storage contents, including roster and unused tail chunks.
        const ourKeys = new Set(Object.keys(payload));
        let totalBytes = 0;
        for (const [key, value] of Object.entries(payload)) {
            const size = new TextEncoder().encode(key + JSON.stringify(value)).length;
            if (size > QUOTA_ITEM_BYTES) throw makeError('QUOTA', 'Single item over 8 KB: ' + key);
            totalBytes += size;
        }
        for (const [key, value] of Object.entries(existing || {})) {
            if (ourKeys.has(key)) continue;
            totalBytes += new TextEncoder().encode(key + JSON.stringify(value)).length;
        }
        if (totalBytes > QUOTA_TOTAL_BYTES) throw makeError('QUOTA', 'Payload over 100 KB total');

        // One local set replaces meta and chunks. Firefox delivers keys independently
        // across devices; readers wait for a matching digest before applying anything.
        try {
            await area.set(payload);
        } catch (e) {
            const message = String((e && e.message) || '');
            if (/quota|QUOTA/i.test(message)) throw makeError('QUOTA', message);
            throw makeError('WRITE_FAILED', message);
        }

        // Then retire every chunk that does not belong to the generation we just published,
        // including legacy un-generationed keys from 1.14–1.17.
        const stale = Object.keys(existing || {}).filter(
            (key) => key.startsWith(CHUNK_PREFIX) && !ourKeys.has(key)
        );
        if (stale.length) {
            try { await area.remove(stale); } catch (e) { /* non-fatal: quota already fits */ }
        }

        return packed.meta;
    }

    async function clearSyncDoc() {
        const area = syncArea();
        if (!area) return;
        const existing = await area.get(null);
        const keys = Object.keys(existing || {}).filter(
            (key) => key === META_KEY || key.startsWith(CHUNK_PREFIX)
        );
        if (keys.length) await area.remove(keys);
    }

    function isDefinitelyStaleChunk(key, activeKeys, meta, now = Date.now()) {
        if (!key.startsWith(CHUNK_PREFIX) || activeKeys.has(key)) return false;
        const match = key.match(/^sync_payload_([a-z0-9]+)_\d+$/i);
        if (!match || match[1].length < 12) return false;
        // Generations start with the eight base-36 digits of their creation time.
        const generationTime = parseInt(match[1].slice(0, 8), 36);
        if (!Number.isFinite(generationTime) || generationTime <= 0) return false;
        return (meta && Number(meta.ts) > generationTime) || now - generationTime > 24 * 60 * 60 * 1000;
    }

    async function getQuotaUsage() {
        const area = syncArea();
        if (!area) return { used: 0, total: QUOTA_TOTAL_BYTES };
        let used = 0;
        let stored = {};
        let reclaimedBytes = 0;
        try { stored = await area.get(null) || {}; } catch (_) { return { used: 0, total: QUOTA_TOTAL_BYTES }; }
        const meta = stored[META_KEY] || null;
        const active = new Set(meta ? Array.from({ length: Number(meta.chunks) || 0 }, (_, i) =>
            chunkKey(meta.gen, i)) : []);
        const stale = Object.keys(stored).filter((key) => isDefinitelyStaleChunk(key, active, meta));
        for (const key of stale) {
            reclaimedBytes += new TextEncoder().encode(key + JSON.stringify(stored[key])).length;
        }
        if (stale.length) {
            try {
                await area.remove(stale);
                for (const key of stale) delete stored[key];
            } catch (_) { reclaimedBytes = 0; }
        }
        try {
            used = typeof area.getBytesInUse === 'function'
                ? await area.getBytesInUse(null)
                : Object.entries(stored).reduce((sum, [key, value]) =>
                    sum + new TextEncoder().encode(key + JSON.stringify(value)).length, 0);
        } catch (_) {
            used = Object.entries(stored).reduce((sum, [key, value]) =>
                sum + new TextEncoder().encode(key + JSON.stringify(value)).length, 0);
        }

        const byteSize = (key) => new TextEncoder().encode(key + JSON.stringify(stored[key])).length;
        let activeBytes = meta ? byteSize(META_KEY) : 0;
        let orphanBytes = 0;
        let orphanChunks = 0;
        let deviceBytes = 0;
        let otherBytes = 0;
        for (const key of Object.keys(stored)) {
            if (key === META_KEY) continue;
            if (key.startsWith(CHUNK_PREFIX)) {
                if (active.has(key)) activeBytes += byteSize(key);
                else {
                    orphanChunks++;
                    orphanBytes += byteSize(key);
                }
            } else if (key.startsWith('sync_dev_') || key.startsWith('sync_leave_')) {
                deviceBytes += byteSize(key);
            } else otherBytes += byteSize(key);
        }

        let document = null;
        if (meta && meta.chunks > 0) {
            try {
                document = await unpack(meta, Array.from(active, (key) => stored[key]));
            } catch (_) { /* retain byte diagnostics even while Firefox delivers partial chunks */ }
        }
        const summary = document ? summarize(document) : { tabs: 0, workspaces: 0 };
        return {
            used,
            total: QUOTA_TOTAL_BYTES,
            activeBytes,
            orphanBytes,
            orphanChunks,
            deviceBytes,
            otherBytes,
            tabs: summary.tabs,
            workspaces: summary.workspaces,
            urlTombstones: (document && document.x && document.x.u || []).length,
            workspaceTombstones: (document && document.x && document.x.w || []).length,
            packedBytes: meta && (Number(meta.packedBytes) || Number(meta.len)) || 0,
            rawBytes: meta && (Number(meta.rawBytes) || (document &&
                new TextEncoder().encode(JSON.stringify(document)).length)) || 0,
            reclaimedBytes,
            documentValid: !!document
        };
    }

    global.WorkspacesSync = {
        SYNC_DOC_VERSION,
        META_KEY,
        CHUNK_PREFIX,
        QUOTA_TOTAL_BYTES,
        QUOTA_ITEM_BYTES,
        SYNCED_SETTING_KEYS,
        resolveLanguageSetting,
        isAvailable,
        hasCompression,
        buildSyncDoc,
        docToRestoreData,
        dataFingerprint,
        summarize,
        isEmptyDoc,
        isPristineDefaultDoc,
        DEFAULT_WORKSPACE_IDS,
        mergeDocs,
        docDiff,
        decideSync,
        tabSyncIdentity,
        identityKey,
        urlOf,
        planCreations,
        isSyncableUrl,
        TOMBSTONE_TTL_MS,
        tombKey,
        emptyTombstones,
        normalizeTombstones,
        mergeTombstoneStores,
        mergeTombstonesThreeWay,
        mergeDocTombstones,
        tombstoneFingerprint,
        gcTombstones,
        tombstonesToDoc,
        tombstonesFromDoc,
        isDefinitelyStaleChunk,
        pack,
        unpack,
        chunkKey,
        newGeneration,
        readSyncDoc,
        writeSyncDoc,
        clearSyncDoc,
        getQuotaUsage
    };
})(typeof window !== 'undefined' ? window : self);
