// Tests for sync.js v2 (1.18): revisions, tombstones, chunk generations, incremental diff.
// Fakes storage.sync with the real MDN quotas. Run: node tests/sync-v2.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ITEM_QUOTA = 8192;
const TOTAL_QUOTA = 102400;

function makeFakeSyncArea() {
    const store = new Map();
    const sizeOf = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
    return {
        store,
        async get(keys) {
            if (keys === null || keys === undefined) return Object.fromEntries(store);
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of list) if (store.has(k)) out[k] = store.get(k);
            return out;
        },
        async set(payload) {
            let total = 0;
            for (const [k, v] of store) total += sizeOf(k, v);
            for (const [k, v] of Object.entries(payload)) {
                const size = sizeOf(k, v);
                if (size > ITEM_QUOTA) throw new Error('QuotaExceededError: item ' + k);
                if (store.has(k)) total -= sizeOf(k, store.get(k));
                total += size;
            }
            if (total > TOTAL_QUOTA) throw new Error('QuotaExceededError: total');
            for (const [k, v] of Object.entries(payload)) store.set(k, v);
        },
        async remove(keys) {
            for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
        },
        async getBytesInUse() {
            let total = 0;
            for (const [k, v] of store) total += sizeOf(k, v);
            return total;
        }
    };
}

const area = makeFakeSyncArea();
globalThis.window = globalThis;
globalThis.browser = { storage: { sync: area } };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
new Function(readFileSync(new URL('../sync.js', import.meta.url), 'utf8'))();
const S = globalThis.WorkspacesSync;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

const HOUR = 3600_000;
const now = Date.now();

// helpers
const ws = (id, name, icon) => ({ id, name, icon });
const tabs = (...urls) => urls.map((u) => ({ url: u, groupId: -1 }));
const build = (wsList, tabMap, extras, dev = 'devA') =>
    S.buildSyncDoc(wsList, tabMap, { theme: 'dark' }, dev, extras);
const urls = (doc, wsId) => ((doc.t && doc.t[wsId]) || []).map((e) => (typeof e === 'string' ? e : e.u));

console.log('sync.js v2 tests');

await test('doc version is 2 and carries revisions + tombstone section', () => {
    const doc = build([ws('ws_1', 'Work', '📁')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 3, m: now } }, tombstones: { w: {}, u: { [S.tombKey('ws_1', 'https://gone.test/')]: now } } });
    assert.equal(doc.v, 2);
    assert.equal(doc.ws[0].r, 3);
    assert.equal(doc.ws[0].m, now);
    assert.deepEqual(doc.x.u, [['ws_1', 'https://gone.test/', now, 1]]);
});

await test('closed tab does not come back from the other device', () => {
    // A closed https://b.test/ ten minutes ago and bumped the workspace revision.
    const local = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 5, m: now } }, tombstones: { w: {}, u: { [S.tombKey('ws_1', 'https://b.test/')]: now - 600_000 } } });
    // B still lists it and has not touched the workspace since.
    const remote = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/', 'https://b.test/') },
        { revs: { ws_1: { r: 4, m: now - HOUR } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.deepEqual(urls(merged, 'ws_1'), ['https://a.test/']);
});

await test('merge is stable: the deletion stays dead over repeated rounds', () => {
    const local = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 5, m: now } }, tombstones: { w: {}, u: { [S.tombKey('ws_1', 'https://b.test/')]: now - 600_000 } } });
    const remote = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/', 'https://b.test/') },
        { revs: { ws_1: { r: 4, m: now - HOUR } } }, 'devB');

    let merged = S.mergeDocs(local, remote);
    for (let i = 0; i < 3; i++) merged = S.mergeDocs(merged, remote);
    assert.deepEqual(urls(merged, 'ws_1'), ['https://a.test/']);
    assert.equal(S.dataFingerprint(merged), S.dataFingerprint(S.mergeDocs(merged, remote)));
});

await test('reopening a closed tab later beats the tombstone', () => {
    const remote = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 4, m: now - HOUR } }, tombstones: { w: {}, u: { [S.tombKey('ws_1', 'https://b.test/')]: now - HOUR } } }, 'devB');
    // Re-added AFTER the tombstone: per-URL birth `a` must be newer than the close.
    const local = build([ws('ws_1', 'Work')], {
        ws_1: [
            { url: 'https://a.test/' },
            { url: 'https://b.test/', a: now }
        ]
    }, { revs: { ws_1: { r: 6, m: now } } });

    const merged = S.mergeDocs(local, remote);
    assert.ok(urls(merged, 'ws_1').includes('https://b.test/'));
});

await test('peer workspace edit does not resurrect a tombstoned URL', () => {
    // Closed b.test on device A. Device B never closed it and later renamed the workspace
    // (newer m). Old isDeleted(tomb, workspaceMtime) wrongly brought b.test back.
    const local = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 5, m: now - HOUR } }, tombstones: { w: {}, u: { [S.tombKey('ws_1', 'https://b.test/')]: now - 600_000 } } });
    const remote = build([ws('ws_1', 'Renamed')], { ws_1: tabs('https://a.test/', 'https://b.test/') },
        { revs: { ws_1: { r: 8, m: now } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.deepEqual(urls(merged, 'ws_1'), ['https://a.test/']);
});

await test('deleted workspace is not recreated by the peer', () => {
    const local = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') },
        { revs: { ws_1: { r: 2, m: now } }, tombstones: { w: { ws_2: now - 300_000 }, u: {} } });
    const remote = build([ws('ws_1', 'Work'), ws('ws_2', 'Music')],
        { ws_1: tabs('https://a.test/'), ws_2: tabs('https://m.test/') },
        { revs: { ws_1: { r: 2, m: now - HOUR }, ws_2: { r: 1, m: now - HOUR } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.deepEqual(merged.ws.map((w) => w.i), ['ws_1']);
    assert.equal(merged.t.ws_2, undefined);
});

await test('higher revision wins for rename and icon', () => {
    const local = build([ws('ws_1', 'Old name', '📁')], { ws_1: [] }, { revs: { ws_1: { r: 1, m: now - HOUR } } });
    const remote = build([ws('ws_1', 'New name', '🎵')], { ws_1: [] }, { revs: { ws_1: { r: 7, m: now } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.equal(merged.ws[0].n, 'New name');
    assert.equal(merged.ws[0].c, '🎵');
    assert.equal(merged.ws[0].r, 7);
});

await test('same name different icon folds into one workspace', () => {
    const local = build([ws('ws_a', 'Музыка', '📁')], { ws_a: tabs('https://a.test/') }, { revs: { ws_a: { r: 1, m: now } } });
    const remote = build([ws('ws_b', 'музыка ', '🎵')], { ws_b: tabs('https://b.test/') }, { revs: { ws_b: { r: 1, m: now } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.equal(merged.ws.length, 1, 'trimmed, case-insensitive name match');
    assert.deepEqual(urls(merged, merged.ws[0].i).sort(), ['https://a.test/', 'https://b.test/']);
});

await test('simultaneous additions on both devices both survive', () => {
    const local = build([ws('ws_1', 'Work'), ws('ws_2', 'Study')],
        { ws_1: tabs('https://base.test/', 'https://from-a.test/'), ws_2: tabs('https://s.test/') },
        { revs: { ws_1: { r: 3, m: now }, ws_2: { r: 1, m: now - HOUR } } });
    const remote = build([ws('ws_1', 'Work'), ws('ws_2', 'Учёба')],
        { ws_1: tabs('https://base.test/', 'https://from-b.test/'), ws_2: tabs('https://s.test/') },
        { revs: { ws_1: { r: 3, m: now - 1000 }, ws_2: { r: 4, m: now } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    const workUrls = urls(merged, 'ws_1');
    assert.ok(workUrls.includes('https://from-a.test/') && workUrls.includes('https://from-b.test/'));
    assert.equal(merged.ws.find((w) => w.i === 'ws_2').n, 'Учёба', 'rename with the higher revision wins');
});

await test('tombstones expire after the TTL and are garbage-collected', () => {
    const stale = now - S.TOMBSTONE_TTL_MS - 1000;
    const kept = S.gcTombstones({ w: { ws_old: stale, ws_new: now }, u: { [S.tombKey('ws_1', 'https://x/')]: stale } }, now);
    assert.deepEqual(Object.keys(kept.w), ['ws_new']);
    assert.deepEqual(Object.keys(kept.u), []);
});

await test('docDiff produces a minimal change set, not a full rebuild', () => {
    const local = build([ws('ws_1', 'Work', '📁'), ws('ws_2', 'Study')],
        { ws_1: tabs('https://keep.test/', 'https://close-me.test/'), ws_2: tabs('https://s.test/') },
        { revs: {} });
    const target = build([ws('ws_1', 'Work renamed', '📁')],
        { ws_1: tabs('https://keep.test/', 'https://new.test/') }, { revs: {} }, 'devB');

    const diff = S.docDiff(local, target);
    assert.equal(diff.changed, true);
    assert.deepEqual(diff.workspacesUpsert.map((w) => w.name), ['Work renamed']);
    assert.deepEqual(diff.workspaceIdsRemove, ['ws_2']);
    assert.deepEqual(diff.tabsAdd.map((t) => t.url), ['https://new.test/']);
    assert.deepEqual(diff.tabsRemove.map((t) => t.url).sort(), ['https://close-me.test/', 'https://s.test/']);
    // The untouched tab is in neither list — that is the whole point.
    assert.ok(!diff.tabsAdd.concat(diff.tabsRemove).some((t) => t.url === 'https://keep.test/'));
});

await test('docDiff on identical documents is a no-op', () => {
    const a = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') }, { revs: {} });
    const b = build([ws('ws_1', 'Work')], { ws_1: tabs('https://a.test/') }, { revs: {} }, 'devB');
    assert.equal(S.docDiff(a, b).changed, false);
});

await test('chunk keys carry a generation; write → read round-trip works', async () => {
    const big = Array.from({ length: 20 }, (_, i) => ws('ws_' + i, 'Space ' + i, '📁'));
    const map = {};
    for (const w of big) map[w.id] = tabs(...Array.from({ length: 8 }, (_, j) => `https://example.com/${w.id}/${j}?ref=sync`));
    const doc = build(big, map, { revs: {} });

    const meta = await S.writeSyncDoc(doc);
    assert.ok(meta.gen, 'meta carries the generation');
    const keys = [...area.store.keys()].filter((k) => k.startsWith(S.CHUNK_PREFIX));
    assert.ok(keys.every((k) => k.includes(meta.gen)), 'every chunk key belongs to that generation');

    const { doc: back } = await S.readSyncDoc();
    assert.equal(S.dataFingerprint(back), S.dataFingerprint(doc));
});

await test('a second write retires the previous generation completely', async () => {
    const first = await S.readSyncDoc();
    const small = build([ws('ws_1', 'Work')], { ws_1: tabs('https://only.test/') }, { revs: {} });
    const meta = await S.writeSyncDoc(small);

    const keys = [...area.store.keys()].filter((k) => k.startsWith(S.CHUNK_PREFIX));
    assert.ok(keys.length > 0 && keys.every((k) => k.includes(meta.gen)), 'no leftovers from the old generation');
    assert.equal(meta.gen, first.meta.gen, 'namespace reused without double storage');
    assert.notEqual(meta.digest, first.meta.digest);

    const { doc: back } = await S.readSyncDoc();
    assert.deepEqual(back.ws.map((w) => w.i), ['ws_1']);
});

await test('legacy 1.14–1.17 payload without a generation is still readable', async () => {
    area.store.clear();
    const legacyDoc = { v: 1, ts: now, dev: 'old', ws: [{ i: 'ws_1', n: 'Work', o: 0 }], t: { ws_1: ['https://legacy.test/'] }, s: {} };
    const body = JSON.stringify(legacyDoc);
    area.store.set('sync_meta', { v: 1, enc: 'plain', chunks: 1, len: body.length, fp: S.dataFingerprint(legacyDoc), ts: now, dev: 'old' });
    area.store.set('sync_payload_0', body);

    const { doc } = await S.readSyncDoc();
    assert.deepEqual(doc.ws.map((w) => w.i), ['ws_1']);

    // Reuse legacy slots too, avoiding a duplicate snapshot during migration.
    await S.writeSyncDoc(build([ws('ws_1', 'Work')], { ws_1: tabs('https://new.test/') }, { revs: {} }));
    assert.equal(area.store.has('sync_payload_0'), true, 'legacy slot reused');
});

await test('interleaved generations can never be assembled into one document', async () => {
    area.store.clear();
    const docA = build(Array.from({ length: 12 }, (_, i) => ws('a_' + i, 'A' + i)),
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['a_' + i, tabs(...Array.from({ length: 10 }, (_, j) => `https://a${i}.test/${j}/${'x'.repeat(40)}`))])),
        { revs: {} });
    const metaA = await S.writeSyncDoc(docA);

    // Simulate a foreign device's half-arrived generation sitting in the same area.
    area.store.set(S.chunkKey('ffff99', 0), 'garbage-from-another-generation');

    const { doc: back, meta } = await S.readSyncDoc();
    assert.equal(meta.gen, metaA.gen);
    assert.equal(S.dataFingerprint(back), S.dataFingerprint(docA), 'foreign chunk ignored');
});

await test('quota accounting includes the generation being replaced', async () => {
    area.store.clear();
    const { randomBytes } = await import('node:crypto');
    const many = Array.from({ length: 30 }, (_, i) => ws('w_' + i, 'W' + i));
    const map = {};
    for (const w of many) {
        map[w.id] = tabs(...Array.from({ length: 100 }, () => 'https://example.com/' + randomBytes(90).toString('hex')));
    }
    const huge = build(many, map, { revs: {} });
    await assert.rejects(() => S.writeSyncDoc(huge), (e) => e.code === 'QUOTA');
});

await test('76 KB compressed snapshot can be replaced repeatedly under the real quota', async () => {
    area.store.clear();
    const { randomBytes } = await import('node:crypto');
    const list = Array.from({ length: 520 }, (_, i) => ({ url: `https://shop.test/product/${i}?q=${randomBytes(90).toString('hex')}` }));
    const doc = build([ws('large', 'Shop')], { large: list });
    const packed = await S.pack(doc);
    assert.ok(packed.meta.enc === 'gzip');
    assert.ok(packed.meta.len > 65000 && packed.meta.len < 100000, `payload ${packed.meta.len}`);
    for (let i = 0; i < 3; i++) {
        doc.ts++;
        await S.writeSyncDoc(doc);
        assert.ok((await S.getQuotaUsage()).used < TOTAL_QUOTA);
        assert.deepEqual(urls((await S.readSyncDoc()).doc, 'large'), list.map(t => t.url));
    }
});

await test('same-length mixed chunks are rejected, including settings-only changes', async () => {
    area.store.clear();
    const doc = build([ws('a', 'Work')], { a: tabs('https://a.test/?id=1#part') });
    await S.writeSyncDoc(doc);
    const before = await S.readSyncDoc();
    doc.s.theme = 'lite'; // same length as dark
    const next = await S.pack(doc, before.meta.gen);
    area.store.set(S.chunkKey(before.meta.gen, 0), next.chunks[0]);
    await assert.rejects(() => S.readSyncDoc(), e => e.code === 'INCOMPLETE');
    area.store.set(S.META_KEY, next.meta);
    assert.equal((await S.readSyncDoc()).doc.s.theme, 'lite');
});

await test('full query strings, fragments and repeated product URLs survive transport', async () => {
    area.store.clear();
    const list = ['https://ozon.ru/product/123/?size=1#reviews', 'https://ozon.ru/product/123/?size=2#reviews', 'https://ozon.ru/product/123/?size=1#reviews'];
    const doc = build([ws('shop', 'Shop')], { shop: tabs(...list) });
    await S.writeSyncDoc(doc);
    assert.deepEqual(urls((await S.readSyncDoc()).doc, 'shop'), list);
});

await test('orphaned generations do not cause a false quota rejection', async () => {
    area.store.clear();
    const { randomBytes } = await import('node:crypto');
    const rows = Array.from({ length: 420 }, (_, i) => ({ url: `https://ozon.by/search/?q=${randomBytes(100).toString('hex')}&page=${i}#results` }));
    const doc = build([ws('shop', 'Shop')], { shop: rows });
    await S.writeSyncDoc(build([ws('shop', 'Shop')], { shop: rows.slice(0, 20) }));
    for (let i = 0; i < 8; i++) area.store.set(S.chunkKey('orphan', i), 'x'.repeat(6000));
    const used = (await S.getQuotaUsage()).used;
    assert.ok(used < TOTAL_QUOTA);
    assert.ok(used + (await S.pack(doc)).meta.len > TOTAL_QUOTA);
    await S.writeSyncDoc(doc);
    assert.ok((await S.getQuotaUsage()).used < TOTAL_QUOTA);
    assert.deepEqual(urls((await S.readSyncDoc()).doc, 'shop'), rows.map(t => t.url));
});

await test('quota diagnostics identify active data, deletion history, and remove old orphan chunks', async () => {
    area.store.clear();
    const doc = build([ws('shop', 'Shop')], { shop: tabs('https://anime.example/?episode=1') }, {
        revs: {},
        tombstones: { w: {}, u: { [S.tombKey('shop', 'https://old.example/')]: now - 1000 } }
    });
    await S.writeSyncDoc(doc);
    area.store.set('sync_dev_old', { id: 'old-device', label: 'Old device' });
    const staleGeneration = (now - 2 * 24 * HOUR).toString(36) + 'abcd';
    const recentGeneration = (now + 60_000).toString(36) + 'efgh';
    area.store.set(S.chunkKey(staleGeneration, 0), 'obsolete chunk data');
    area.store.set(S.chunkKey(recentGeneration, 0), 'possibly in-flight chunk data');

    const stats = await S.getQuotaUsage();
    assert.equal(stats.documentValid, true);
    assert.equal(stats.tabs, 1);
    assert.equal(stats.workspaces, 1);
    assert.equal(stats.urlTombstones, 1);
    assert.ok(stats.activeBytes > 0 && stats.deviceBytes > 0);
    assert.equal(stats.orphanChunks, 1, 'recent unreferenced data is retained during delivery');
    assert.ok(stats.reclaimedBytes > 0);
    assert.equal(area.store.has(S.chunkKey(staleGeneration, 0)), false);
    assert.equal(area.store.has(S.chunkKey(recentGeneration, 0)), true);
});

await test('three-way merge preserves independent duplicate opens and closes', () => {
    const u = 'https://ozon.by/search/?q=phone&sort=price#items';
    const doc = (n, baseN = n) => {
        const d = build([ws('shop', 'Shop')], { shop: tabs(...Array(n).fill(u)) });
        if (n < baseN) d.x.u.push(['shop', u, now, baseN - n]);
        return d;
    };
    assert.equal(urls(S.mergeDocs(doc(2), doc(2), doc(1)), 'shop').length, 3);
    assert.equal(urls(S.mergeDocs(doc(1, 2), doc(3), doc(2)), 'shop').length, 2);
    assert.equal(urls(S.mergeDocs(doc(1, 2), doc(2), doc(2)), 'shop').length, 1);
    assert.equal(urls(S.mergeDocs(doc(2), doc(1, 2), doc(2)), 'shop').length, 1);
    assert.equal(urls(S.mergeDocs(doc(0, 1), doc(0, 1), doc(1)), 'shop').length, 0);
    assert.equal(urls(S.mergeDocs(doc(0), doc(1), doc(1)), 'shop').length, 1,
        'absence without an explicit close must preserve the tab');
    assert.equal(urls(S.mergeDocs(doc(0), doc(0), doc(1)), 'shop').length, 1,
        'two missing snapshots still cannot invent a user close');
    assert.equal(urls(S.mergeDocs(doc(0, 1), doc(2), doc(2)), 'shop').length, 1,
        'one close fact cannot remove two ancestor copies');
    const alreadyApplied = doc(2); alreadyApplied.x.u.push(['shop', u, now - 1000, 1]);
    const incomplete = doc(0); incomplete.x = structuredClone(alreadyApplied.x);
    assert.equal(urls(S.mergeDocs(incomplete, alreadyApplied, alreadyApplied), 'shop').length, 2,
        'a close already represented in the ancestor cannot be applied again');
});

await test('acknowledged tombstone removal converges through the common ancestor', () => {
    const key = S.tombKey('work', 'https://example.test/closed');
    const base = { w: {}, u: { [key]: { t: now - 1000, n: 1 } } };
    const empty = S.emptyTombstones();
    assert.deepEqual(S.mergeTombstonesThreeWay(base, base, empty), empty,
        'a peer that has not changed the tombstone accepts its acknowledged removal');
    assert.deepEqual(S.mergeTombstonesThreeWay(base, empty, base), empty,
        'the removal remains stable when the other peer has not published it yet');

    const concurrent = { w: {}, u: { [key]: { t: now, n: 2 } } };
    assert.deepEqual(S.mergeTombstonesThreeWay(base, concurrent, base), concurrent,
        'a concurrent newer close is retained while the old record is compacted');
});

await test('a replicated URL birth is not counted twice when the saved base is behind', () => {
    const u = 'https://anime.example/watch?id=42';
    const doc = (rows, dev) => build([ws('watch', 'Watch')], { watch: rows }, {}, dev);
    const base = doc([], 'base');
    const copy = { url: u, groupId: -1, a: now - 1000 };
    const local = doc([copy], 'laptop');
    const remote = doc([copy], 'computer');

    const merged = S.mergeDocs(local, remote, base);
    assert.equal(urls(merged, 'watch').filter(url => url === u).length, 1,
        'the same replicated opening remains one tab');
    assert.equal(urls(S.mergeDocs(merged, remote, base), 'watch').filter(url => url === u).length, 1,
        'repeating the stale-base merge is idempotent');
});

await test('separate birth cohorts and intentional same-device copies remain separate', () => {
    const u = 'https://anime.example/watch?id=42';
    const doc = (rows, dev) => build([ws('watch', 'Watch')], { watch: rows }, {}, dev);
    const base = doc([], 'base');
    const first = { url: u, groupId: -1, a: now - 2000 };
    const second = { url: u, groupId: -1, a: now - 1000 };

    assert.equal(urls(S.mergeDocs(doc([first], 'laptop'), doc([second], 'computer'), base), 'watch').length, 2,
        'independently opened copies have separate birth times');
    assert.equal(urls(S.mergeDocs(doc([first, first], 'laptop'), doc([first, first], 'computer'), base), 'watch').length, 2,
        'intentional identical tabs from one device keep their count');

    const existing = doc([first], 'base');
    assert.equal(urls(S.mergeDocs(doc([first, second], 'laptop'), doc([first, { ...second, a: now }], 'computer'), existing), 'watch').length, 3,
        'independent copies opened beside an existing same-URL tab are preserved');
});

await test('three-way merge never folds established same-name workspaces', () => {
    const base = build([ws('a', 'Shop'), ws('b', 'Shop')], { a: tabs('https://a/'), b: tabs('https://b/') });
    const merged = S.mergeDocs(base, base, base);
    assert.equal(merged.ws.length, 2);
    assert.deepEqual(urls(merged, 'a'), ['https://a/']);
    assert.deepEqual(urls(merged, 'b'), ['https://b/']);
});

await test('three-way settings merge retains a remote edit when local settings did not change', () => {
    const base = build([ws('a', 'Work')], { a: tabs('https://a/') });
    const local = structuredClone(base); local.t.a.push('https://local/');
    const remote = structuredClone(base); remote.s.theme = 'light'; remote.t.a.push('https://remote/');
    assert.equal(S.mergeDocs(local, remote, base).s.theme, 'light');
    local.s.theme = 'custom';
    assert.equal(S.mergeDocs(local, remote, base).s.theme, 'custom');
});

console.log(`\n${passed} tests passed`);

// ---------------------------------------------------------------- decision core

await test('decideSync: the 1.17 ping-pong is impossible now', () => {
    // Both devices "member", identical base, only A changed → A pushes, B fast-forwards.
    const base = 'base-fp';
    assert.equal(S.decideSync({ hasRemote: true, joined: true, localFp: 'a2', remoteFp: base, baseFp: base }), 'PUSH');
    assert.equal(S.decideSync({ hasRemote: true, joined: true, localFp: base, remoteFp: 'a2', baseFp: base }), 'FAST_FORWARD');
    // Both changed → merge, never "local wins".
    assert.equal(S.decideSync({ hasRemote: true, joined: true, localFp: 'a2', remoteFp: 'b2', baseFp: base }), 'MERGE');
    // Identical data short-circuits.
    assert.equal(S.decideSync({ hasRemote: true, joined: true, localFp: 'x', remoteFp: 'x', baseFp: base }), 'IN_SYNC');
});

await test('decideSync: joining and seeding rules', () => {
    assert.equal(S.decideSync({ hasRemote: false, localEmpty: false }), 'SEED');
    assert.equal(S.decideSync({ hasRemote: false, localEmpty: true }), 'NOOP');
    // Fresh install against a populated account: adopt quietly, no dialog.
    assert.equal(S.decideSync({ hasRemote: true, joined: false, localPristine: true, localFp: 'p', remoteFp: 'r' }), 'ADOPT');
    // Real local data + populated account: ask once.
    assert.equal(S.decideSync({ hasRemote: true, joined: false, localFp: 'l', remoteFp: 'r' }), 'JOIN_PROMPT');
    // Non-member with data, empty account → seed it.
    assert.equal(S.decideSync({ hasRemote: true, joined: false, remoteEmpty: true, localEmpty: false, localFp: 'l', remoteFp: 'e' }), 'SEED');
    // A valid empty document is a peer deletion, unlike a missing account copy.
    assert.equal(S.decideSync({ hasRemote: true, joined: true, remoteEmpty: true, localEmpty: false, localFp: 'l', remoteFp: 'e', baseFp: 'l' }), 'FAST_FORWARD');
    // No common ancestor yet (upgrade from 1.17) → merge, never clobber.
    assert.equal(S.decideSync({ hasRemote: true, joined: true, localFp: 'l', remoteFp: 'r', baseFp: null }), 'MERGE');
});

await test('two devices converge over repeated rounds (full simulation)', () => {
    // Simulates the real loop: each device holds a doc + baseFp, the "account" holds one doc.
    const mkDevice = (id, doc) => ({ id, doc, base: null });
    const fp = (d) => S.dataFingerprint(d);

    const exchange = (dev, account) => {
        const decision = S.decideSync({
            hasRemote: !!account.doc,
            joined: true,
            localEmpty: S.isEmptyDoc(dev.doc),
            remoteEmpty: account.doc ? S.isEmptyDoc(account.doc) : true,
            localFp: fp(dev.doc),
            remoteFp: account.doc ? fp(account.doc) : null,
            baseFp: dev.base
        });

        if (decision === 'IN_SYNC') { dev.base = fp(dev.doc); return decision; }
        if (decision === 'PUSH' || decision === 'SEED') {
            account.doc = dev.doc;
            dev.base = fp(dev.doc);
            return decision;
        }
        if (decision === 'FAST_FORWARD') {
            // The incremental apply makes the local doc equal to the target.
            const diff = S.docDiff(dev.doc, account.doc);
            assert.ok(diff.changed, 'fast-forward with nothing to change would be a bug');
            dev.doc = account.doc;
            dev.base = fp(dev.doc);
            return decision;
        }
        if (decision === 'MERGE') {
            const merged = S.mergeDocs(dev.doc, account.doc);
            dev.doc = merged;
            account.doc = merged;
            dev.base = fp(merged);
            return decision;
        }
        return decision;
    };

    const ws = (id, name) => ({ id, name, icon: '📁' });
    const tabsOf = (...u) => u.map((url) => ({ url, groupId: -1 }));

    const A = mkDevice('A', S.buildSyncDoc(
        [ws('ws_1', 'Work'), ws('ws_2', 'Study')],
        { ws_1: tabsOf('https://a1/', 'https://shared/'), ws_2: tabsOf('https://s1/') },
        { theme: 'dark' }, 'A', { revs: { ws_1: { r: 1, m: 1000 }, ws_2: { r: 1, m: 1000 } } }
    ));
    const B = mkDevice('B', S.buildSyncDoc(
        [ws('ws_1', 'Work')],
        { ws_1: tabsOf('https://b1/', 'https://shared/') },
        { theme: 'dark' }, 'B', { revs: { ws_1: { r: 1, m: 1000 } } }
    ));
    const account = { doc: null };

    // Round 1: A seeds, B merges (no common ancestor), A picks the merge up.
    exchange(A, account);
    exchange(B, account);
    exchange(A, account);
    exchange(B, account);

    assert.equal(fp(A.doc), fp(B.doc), 'both devices hold the same document');
    assert.equal(fp(A.doc), fp(account.doc), 'account agrees too');
    const workUrls = (A.doc.t.ws_1 || []).map((e) => (typeof e === 'string' ? e : e.u));
    assert.ok(workUrls.includes('https://a1/') && workUrls.includes('https://b1/'), 'nothing was clobbered');
    assert.equal(workUrls.filter((u) => u === 'https://shared/').length, 1, 'shared tab not duplicated');

    // Round 2: A closes a tab (tombstone + revision bump), B must lose it and not bring it back.
    const closedUrl = 'https://b1/';
    const remaining = workUrls.filter((u) => u !== closedUrl);
    A.doc = S.buildSyncDoc(
        A.doc.ws.map((w) => ({ id: w.i, name: w.n, icon: w.c })),
        Object.fromEntries(A.doc.ws.map((w) => [
            w.i,
            w.i === 'ws_1' ? tabsOf(...remaining)
                           : (A.doc.t[w.i] || []).map((e) => ({ url: typeof e === 'string' ? e : e.u, groupId: -1 }))
        ])),
        { theme: 'dark' }, 'A',
        {
            revs: Object.fromEntries(A.doc.ws.map((w) => [w.i, { r: (w.r || 0) + (w.i === 'ws_1' ? 1 : 0), m: Date.now() }])),
            tombstones: { w: {}, u: { [S.tombKey('ws_1', closedUrl)]: Date.now() } }
        }
    );

    for (let round = 0; round < 3; round++) { exchange(A, account); exchange(B, account); }

    const aUrls = (A.doc.t.ws_1 || []).map((e) => (typeof e === 'string' ? e : e.u));
    const bUrls = (B.doc.t.ws_1 || []).map((e) => (typeof e === 'string' ? e : e.u));
    assert.ok(!aUrls.includes(closedUrl), 'closed on A stays closed on A');
    assert.ok(!bUrls.includes(closedUrl), 'and it is gone on B too — no resurrection');
    assert.equal(fp(A.doc), fp(B.doc), 'still converged');

    // Round 3: quiet loop — repeated exchanges must be no-ops, not endless pushes.
    const decisions = [];
    for (let round = 0; round < 4; round++) {
        decisions.push(exchange(A, account));
        decisions.push(exchange(B, account));
    }
    assert.ok(decisions.every((d) => d === 'IN_SYNC'), `steady state must be IN_SYNC, got ${decisions.join(',')}`);
});

console.log(`\n${passed} tests passed (incl. decision core + convergence simulation)`);

// ------------------------------------------------- 1.19 regression: runaway tab creation

await test('a loading tab keeps its requested URL as identity', () => {
    // Right after tabs.create the tab reports about:blank (or a redirect target).
    assert.equal(S.tabSyncIdentity({ url: 'about:blank' }, 'https://wanted/'), 'https://wanted/');
    assert.equal(S.tabSyncIdentity({ url: 'https://redirected/' }, 'https://wanted/'), 'https://wanted/');
    // Once the intended URL is released, the real URL takes over.
    assert.equal(S.tabSyncIdentity({ url: 'https://redirected/' }, null), 'https://redirected/');
});

await test('planCreations never duplicates what already exists', () => {
    const existing = new Map([
        [S.identityKey('ws_1', 'https://a/'), 1],
        [S.identityKey('ws_2', 'https://b/'), 1]
    ]);
    const adds = [
        { wsId: 'ws_1', url: 'https://a/' },
        { wsId: 'ws_1', url: 'https://new/' },
        { wsId: 'ws_1', url: 'https://new/' },
        { wsId: 'ws_2', url: 'https://a/' }
    ];
    const plan = S.planCreations(adds, existing);
    assert.deepEqual(plan.map((p) => p.wsId + ' ' + p.url),
        ['ws_1 https://new/', 'ws_1 https://new/', 'ws_2 https://a/']);
});

await test('planCreations keeps same URL when more copies are needed', () => {
    const existing = new Map([[S.identityKey('ws_1', 'https://a/'), 1]]);
    const adds = [
        { wsId: 'ws_1', url: 'https://a/' },
        { wsId: 'ws_1', url: 'https://a/' },
        { wsId: 'ws_1', url: 'https://a/' }
    ];
    const plan = S.planCreations(adds, existing);
    assert.equal(plan.length, 2);
    assert.ok(plan.every((p) => p.url === 'https://a/'));
});

await test('three identical URLs stay three across build, merge, and diff', () => {
    const local = build([ws('ws_1', 'Work')], {
        ws_1: [
            { url: 'https://same.test/' },
            { url: 'https://same.test/' },
            { url: 'https://same.test/' }
        ]
    }, { revs: { ws_1: { r: 2, m: now } } });
    assert.equal(urls(local, 'ws_1').length, 3);

    const remote = build([ws('ws_1', 'Work')], {
        ws_1: [{ url: 'https://same.test/' }]
    }, { revs: { ws_1: { r: 1, m: now - HOUR } } }, 'devB');

    const merged = S.mergeDocs(local, remote);
    assert.equal(urls(merged, 'ws_1').filter((u) => u === 'https://same.test/').length, 3);

    const emptyLocal = build([ws('ws_1', 'Work')], { ws_1: [] }, { revs: { ws_1: { r: 0, m: 0 } } });
    const diff = S.docDiff(emptyLocal, local);
    assert.equal(diff.tabsAdd.length, 3);
    assert.ok(diff.tabsAdd.every((row) => row.url === 'https://same.test/'));
});

await test('REGRESSION: 165 tabs stay 165 across repeated cycles (the 300-tab bug)', () => {
    // Reproduces the field report: the apply creates tabs, they are still loading when the
    // next 5-second cycle runs, and the workspace resolver would have put them in Main.
    const TARGET_TABS = 165;
    const targetUrls = Array.from({ length: TARGET_TABS }, (_, i) => `https://site${i}.test/page`);
    const targetDoc = S.buildSyncDoc(
        [{ id: 'ws_work', name: 'Work', icon: '📁' }],
        { ws_work: targetUrls.map((url) => ({ url, groupId: -1 })) },
        {}, 'peer', { revs: { ws_work: { r: 2, m: Date.now() } } }
    );

    // Local browser model: tabs with an id, a reported url and an intended url.
    let nextId = 1;
    const openTabs = [];                 // { id, url, wsId, intended, loadTicks }
    const createdCounter = { total: 0 };

    const buildLocalDoc = () => {
        const byWs = {};
        for (const tab of openTabs) {
            if (!tab.wsId) continue;
            if (!byWs[tab.wsId]) byWs[tab.wsId] = [];
            const identity = S.tabSyncIdentity(tab, tab.intended);
            byWs[tab.wsId].push({ url: identity, groupId: -1 });
        }
        return S.buildSyncDoc(
            [{ id: 'ws_work', name: 'Work', icon: '📁' }],
            { ws_work: byWs.ws_work || [] },
            {}, 'local', { revs: { ws_work: { r: 1, m: Date.now() - 1000 } } }
        );
    };

    const applyOnce = () => {
        const localDoc = buildLocalDoc();
        const diff = S.docDiff(localDoc, targetDoc);
        const existing = new Map();
        for (const t of openTabs) {
            if (!t.wsId) continue;
            const key = S.identityKey(t.wsId, S.tabSyncIdentity(t, t.intended));
            existing.set(key, (existing.get(key) || 0) + 1);
        }
        const plan = S.planCreations(diff.tabsAdd, existing);

        for (const add of plan) {
            openTabs.push({
                id: nextId++,
                url: 'about:blank',
                wsId: add.wsId,
                intended: add.url,
                loadTicks: 2
            });
            createdCounter.total++;
        }
        return plan.length;
    };

    const tick = () => {
        // Loading progresses; when complete the intended URL is released (as onUpdated does).
        for (const tab of openTabs) {
            if (tab.loadTicks > 0) {
                tab.loadTicks--;
                if (tab.loadTicks === 0) {
                    tab.url = tab.intended;
                    tab.intended = null;
                }
            }
        }
    };

    const firstPass = applyOnce();
    assert.equal(firstPass, TARGET_TABS, 'the first apply opens exactly the missing tabs');

    // Now run several more cycles while the tabs are still loading — this is where 1.18
    // created everything again, every five seconds.
    for (let cycle = 0; cycle < 6; cycle++) {
        const createdNow = applyOnce();
        assert.equal(createdNow, 0, `cycle ${cycle} must create nothing, created ${createdNow}`);
        tick();
    }

    assert.equal(createdCounter.total, TARGET_TABS, `total created must stay ${TARGET_TABS}`);
    assert.equal(openTabs.length, TARGET_TABS, 'no duplicate tabs exist');
    assert.equal(S.dataFingerprint(buildLocalDoc()), S.dataFingerprint(targetDoc), 'converged');
});

await test('REGRESSION: tabs land in their own workspace, not all in Main', () => {
    // The 1.18 apply did not set isRestoringData, so tabs.onCreated re-resolved every created
    // tab into the current workspace. Modelled here: a hijacker that only fires when the
    // restore flag is NOT set.
    const targetDoc = S.buildSyncDoc(
        [{ id: 'ws_default', name: 'Main' }, { id: 'ws_music', name: 'Music' }],
        {
            ws_default: [{ url: 'https://main1/', groupId: -1 }],
            ws_music: [{ url: 'https://song1/', groupId: -1 }, { url: 'https://song2/', groupId: -1 }]
        },
        {}, 'peer', { revs: {} }
    );

    const runApply = (isRestoringData) => {
        const openTabs = [];
        const localDoc = S.buildSyncDoc(
            [{ id: 'ws_default', name: 'Main' }, { id: 'ws_music', name: 'Music' }],
            { ws_default: [], ws_music: [] }, {}, 'local', { revs: {} }
        );
        for (const add of S.planCreations(S.docDiff(localDoc, targetDoc).tabsAdd, [])) {
            const tab = { id: openTabs.length + 1, wsId: add.wsId, intended: add.url, url: 'about:blank' };
            // The real onCreated resolver assigns the new tab to the CURRENT workspace.
            if (!isRestoringData) tab.wsId = 'ws_default';
            openTabs.push(tab);
        }
        return openTabs;
    };

    const broken = runApply(false);
    assert.equal(broken.filter((t) => t.wsId === 'ws_music').length, 0,
        'this is the 1.18 behaviour being fixed: everything ended up in Main');

    const fixed = runApply(true);
    assert.equal(fixed.filter((t) => t.wsId === 'ws_music').length, 2, 'music tabs stay in Music');
    assert.equal(fixed.filter((t) => t.wsId === 'ws_default').length, 1);
});

console.log(`\n${passed} tests passed (incl. the 1.19 runaway-creation regressions)`);
