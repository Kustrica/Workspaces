// Real Firefox smoke QA in an isolated Marionette profile. Pass a built ZIP path.
import net from 'node:net';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const socket = net.createConnection({ port: 2839, host: '127.0.0.1' });
const pending = new Map();
let buffer = Buffer.alloc(0);
let sequence = 0;
let readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
        const separator = buffer.indexOf(':');
        if (separator < 0) break;
        const size = Number(buffer.subarray(0, separator).toString());
        if (buffer.length < separator + 1 + size) break;
        const packet = JSON.parse(buffer.subarray(separator + 1, separator + 1 + size).toString());
        buffer = buffer.subarray(separator + 1 + size);
        if (!Array.isArray(packet)) { readyResolve(); continue; }
        const item = pending.get(packet[1]);
        if (item) {
            clearTimeout(item.timer);
            pending.delete(packet[1]);
            packet[2] ? item.reject(new Error(JSON.stringify(packet[2]))) : item.resolve(packet[3]);
        }
    }
});
socket.on('error', error => { for (const item of pending.values()) item.reject(error); });
const command = (name, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error('Timeout: ' + name)), 20000);
    pending.set(id, { resolve, reject, timer });
    const body = JSON.stringify([0, id, name, args]);
    socket.write(Buffer.byteLength(body) + ':' + body);
});
const exec = async script => {
    const result = await command('WebDriver:ExecuteScript', { script, args: [], newSandbox: false, sandbox: 'default' });
    return result.value;
};
const asyncExec = async script => {
    const result = await command('WebDriver:ExecuteAsyncScript', { script, args: [], newSandbox: false, sandbox: 'default', scriptTimeout: 15000 });
    return result.value;
};
try {
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Firefox handshake timeout')), 10000))]);
    const session = await command('WebDriver:NewSession', { capabilities: {} });
    console.log('Firefox session', JSON.stringify(session));
    const addon = await command('Addon:Install', { path: process.argv[2], temporary: true });
    console.log('Installed', JSON.stringify(addon));
    await command('Marionette:SetContext', { value: 'chrome' });
    const url = await exec('return WebExtensionPolicy.getByID("workspaces@kustrica.addon").getURL("options.html");');
    await command('Marionette:SetContext', { value: 'content' });
    await command('WebDriver:Navigate', { url });
    const state = await asyncExec(`
        const done = arguments[arguments.length - 1];
        window.wrappedJSObject.browser.storage.local.set({ syncEnabled: false }).then(() => done(true));
    `);
    assert.equal(state, true);
    const ui = await exec(`
        const checkbox = document.getElementById('sync-breath-enabled');
        return { switchExists: !!checkbox, label: checkbox.parentElement.textContent.trim(), compression: typeof window.wrappedJSObject.CompressionStream, version: window.wrappedJSObject.browser.runtime.getManifest().version };
    `);
    assert.equal(ui.version, '1.19.8');
    assert.equal(ui.switchExists, true);
    assert.equal(ui.compression, 'function');
    await exec(`document.getElementById('sync-breath-enabled').click(); return true;`);
    const disabled = await asyncExec(`
        const done = arguments[arguments.length - 1];
        window.wrappedJSObject.browser.storage.local.get('syncBreathEnabled').then(value => done(value.syncBreathEnabled));
    `);
    assert.equal(disabled, false);
    const noPulse = await exec(`
        window.wrappedJSObject.SyncBreath.playFromSyncMessage({action:'SYNC_ACTIVITY',kind:'changed',added:1});
        return document.getElementById('sync-breath').classList.contains('sb-playing-changed');
    `);
    assert.equal(noPulse, false);
    await exec(`document.getElementById('sync-breath-enabled').click(); return true;`);
    const pulse = await exec(`
        window.wrappedJSObject.SyncBreath.playFromSyncMessage({action:'SYNC_ACTIVITY',kind:'changed',added:1});
        return document.getElementById('sync-breath').classList.contains('sb-playing-changed');
    `);
    assert.equal(pulse, true);
    if (process.argv[3]) {
        await exec(`document.getElementById('sync-breath-enabled').scrollIntoView({ block: 'center' }); return true;`);
        const shot = await command('WebDriver:TakeScreenshot', { full: false });
        writeFileSync(process.argv[3], Buffer.from(shot.value, 'base64'));
    }
    console.log('Real Firefox UI verified', JSON.stringify(ui), 'switch persistence, disabled pulse, enabled pulse');
} finally {
    try { await command('WebDriver:DeleteSession'); } catch {}
    socket.destroy();
}
