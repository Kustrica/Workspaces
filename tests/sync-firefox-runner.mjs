// Real Firefox QA in a fresh temporary profile, with a test-only extension copy.
// Usage: node tests/sync-firefox-runner.mjs [firefox executable]
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'workspaces-sync-qa-'));
const extension = join(temp, 'extension');
const reports = [];
let complete;
const done = new Promise(r => { complete = r; });
const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/report') {
        let body = ''; req.on('data', d => { body += d; });
        req.on('end', () => {
            const report = JSON.parse(body); reports.push(report);
            console.log(JSON.stringify(report)); res.end('ok');
            if (reports.length === 3 || report.error) complete();
        });
    } else if (req.url.startsWith('/redirect')) {
        res.writeHead(302, { Location: '/product/?redirected=1' }); res.end();
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Sync QA</title><p>Test tab</p>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let child;
try {
    await cp(root, extension, { recursive: true, filter: source => {
        const rel = source.slice(root.length).replaceAll('\\', '/');
        return !/^\/(\.git|\.project|\.codebase-memory|handoff|answer|tests|tools|web-ext-artifacts)(\/|$)/.test(rel);
    } });
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    manifest.background.scripts.push('qa-background.js');
    manifest.host_permissions = [base + '/*'];
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    const report = `async function qaReport(data) { await fetch(${JSON.stringify(base + '/report')}, { method: 'POST', body: JSON.stringify(data) }); }`;
    await writeFile(join(extension, 'qa-background.js'), report + `
(async () => {
    try {
        await initReadyPromise; await initSyncController(); await syncOperationTail;
        await setSyncEnabled(false);
        workspaces = [{ id: 'qa', name: 'QA' }]; currentWorkspaceId = 'qa';
        tabWorkspaceMap = {}; syncWsShape = {}; syncBaseDoc = null;
        await browser.storage.local.set({ workspaces, currentWorkspaceId, areActionsVisible: 'counts', onboardingComplete: true, tourComplete: true, ui_language: 'ru' });
        const urls = [${JSON.stringify(base + '/search/?q=phone&sort=price#results')}, ${JSON.stringify(base + '/search/?q=phone&sort=price#results')}, ${JSON.stringify(base + '/search/?q=phone&sort=date#results')}, ${JSON.stringify(base + '/redirect/?q=keep#original')}];
        const doc = WorkspacesSync.buildSyncDoc(workspaces, { qa: urls.map(url => ({ url })) }, {}, 'peer');
        const applied = await applySyncedDoc(doc, 'MERGE', 'qa-join');
        if (!applied.success || applied.added !== 4) throw Error('Initial apply: ' + JSON.stringify(applied));
        for (let i = 0; i < 4; i++) {
            const result = await applySyncedDocIncremental(doc);
            if (result.action !== 'NO_CHANGES') throw Error('Repeated apply: ' + JSON.stringify(result));
        }
        await new Promise(r => setTimeout(r, 1500));
        const local = await collectLocalSyncDoc();
        if (WorkspacesSync.dataFingerprint(local) !== WorkspacesSync.dataFingerprint(doc)) throw Error('URL identity changed after loading: ' + JSON.stringify({ local, doc, intended: tabIntendedUrl, tabs: await browser.tabs.query({}) }));
        const fewer = structuredClone(doc); fewer.t.qa.splice(0, 1);
        const closed = await applySyncedDocIncremental(fewer);
        if (!closed.success || closed.removed !== 1) throw Error('Duplicate close failed');
        const reopened = await applySyncedDocIncremental(doc);
        if (!reopened.success || reopened.added !== 1) throw Error('Duplicate reopen failed');
        const rows = Array.from({ length: 520 }, (_, i) => ({ url: 'https://shop.test/?id=' + i + '&q=' + Array.from(crypto.getRandomValues(new Uint8Array(90)), b => b.toString(16).padStart(2, '0')).join('') }));
        const large = WorkspacesSync.buildSyncDoc(workspaces, { qa: rows }, {}, 'qa');
        const packed = await WorkspacesSync.pack(large);
        if (packed.meta.enc !== 'gzip' || packed.meta.len < 65000 || packed.meta.len > 100000) throw Error('Large gzip fixture size: ' + packed.meta.len);
        for (let i = 0; i < 3; i++) { large.ts++; await WorkspacesSync.writeSyncDoc(large); }
        await WorkspacesSync.writeSyncDoc(doc);
        const back = await WorkspacesSync.readSyncDoc();
        if (WorkspacesSync.dataFingerprint(back.doc) !== WorkspacesSync.dataFingerprint(doc)) throw Error('Native storage roundtrip failed');
        await qaReport({ surface: 'background', browser: await browser.runtime.getBrowserInfo(), version: browser.runtime.getManifest().version, added: applied.added, tabs: WorkspacesSync.summarize(local).tabs, duplicateClosed: closed.removed, duplicateReopened: reopened.added, largeSnapshotBytes: packed.meta.len, nativeQuotaReplacements: 3, encoding: back.meta.enc });
        await browser.storage.local.set({ qaReady: true });
        await browser.tabs.create({ url: browser.runtime.getURL('options.html'), active: false });
        if (!browser.extension.getViews().some(view => view.location.pathname.includes('sidebar.html'))) {
            await browser.tabs.create({ url: browser.runtime.getURL('sidebar.html'), active: false });
        }
    } catch (e) { await qaReport({ surface: 'background', error: e.message + '\\n' + e.stack }); }
})();
`);
    await writeFile(join(extension, 'qa-ui.js'), report + `
(async () => {
    const surface = location.pathname.includes('options') ? 'options' : 'sidebar';
    try {
        while (!(await browser.storage.local.get('qaReady')).qaReady) await new Promise(r => setTimeout(r, 100));
        await new Promise(r => setTimeout(r, surface === 'sidebar' ? 2600 : 1000));
        await browser.storage.local.set({ syncBreathEnabled: true });
        await new Promise(r => setTimeout(r, 100));
        const root = SyncBreath.ensureRoot();
        root.classList.remove('sb-playing-changed');
        const before = { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
        const nodes = [...document.querySelectorAll('.workspace-item')];
        const counts = [...document.querySelectorAll('.ws-tab-count')].map(el => el.textContent);
        SyncBreath.playFromSyncMessage({ action: 'SYNC_ACTIVITY', kind: 'changed', added: 0, removed: 0 });
        if (root.classList.contains('sb-playing-changed')) throw Error('Zero delta pulsed');
        SyncBreath.playFromSyncMessage({ action: 'SYNC_ACTIVITY', kind: 'changed', added: 1, removed: 0, showToast: false });
        if (!root.classList.contains('sb-playing-changed')) throw Error('Tab delta did not pulse');
        if (before.width !== document.documentElement.scrollWidth || before.height !== document.documentElement.scrollHeight) throw Error('Pulse changed layout');
        if (nodes.some(el => !el.isConnected)) throw Error('Pulse replaced workspace rows');
        if (JSON.stringify(counts) !== JSON.stringify([...document.querySelectorAll('.ws-tab-count')].map(el => el.textContent))) throw Error('Pulse reset counts');
        const checkbox = document.getElementById('sync-breath-enabled');
        if (surface === 'options') {
            if (!checkbox) throw Error('Toggle missing');
            checkbox.checked = false; checkbox.dispatchEvent(new Event('change'));
        } else await browser.storage.local.set({ syncBreathEnabled: false });
        await new Promise(r => setTimeout(r, 100));
        SyncBreath.playFromSyncMessage({ action: 'SYNC_ACTIVITY', kind: 'changed', added: 1, removed: 0 });
        if (root.classList.contains('sb-playing-changed')) throw Error('Disabled pulse played');
        await qaReport({ surface, checkbox: !!checkbox, counts, stableLayout: true, deltaOnly: true, toggleDisabled: true });
    } catch (e) { await qaReport({ surface, error: e.message + '\\n' + e.stack }); }
})();
`);
    for (const file of ['options.html', 'sidebar.html']) {
        const html = await readFile(join(extension, file), 'utf8');
        await writeFile(join(extension, file), html.replace('</body>', '<script src="qa-ui.js"></script></body>'));
    }
    const firefox = process.argv[2] || 'C:/Program Files/Mozilla Firefox/firefox.exe';
    const command = `npx --yes web-ext run --source-dir '${extension.replaceAll("'", "''")}' --firefox '${firefox.replaceAll("'", "''")}' --no-reload --no-input --no-config-discovery --args=-headless`;
    child = spawn('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    let timeout;
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Firefox QA timed out')), 55000); })]).finally(() => clearTimeout(timeout));
    assert.equal(reports.length, 3);
    assert.ok(reports.every(r => !r.error), JSON.stringify(reports));
    await writeFile(join(root, '.project', 'sync-firefox-qa.json'), JSON.stringify(reports, null, 2) + '\n');
} finally {
    if (child) await new Promise(r => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('exit', r); });
    await new Promise(r => server.close(r));
    // The target is the exact newly created temporary QA directory, never a user profile.
    assert.ok(temp.startsWith(join(tmpdir(), 'workspaces-sync-qa-')));
    await rm(temp, { recursive: true, force: true });
}
