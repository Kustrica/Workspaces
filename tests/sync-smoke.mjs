// Minimal smoke tests for sync.js helpers (Node, no browser).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const code = readFileSync(new URL('../sync.js', import.meta.url), 'utf8');
const sandbox = { console, TextEncoder, TextDecoder, btoa, atob, Response, Uint8Array, crypto: globalThis.crypto };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(code, sandbox);
const S = sandbox.WorkspacesSync;
if (!S) throw new Error('WorkspacesSync missing');

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assert failed');
    console.log('  ok ', msg);
}

console.log('sync.js smoke (1.17)');

const local = S.buildSyncDoc(
    [{ id: 'a', name: 'Music', icon: '🎵' }, { id: 'b', name: 'Work', icon: '💼' }],
    { a: [{ url: 'https://a.example/1' }], b: [{ url: 'https://b.example/1' }] },
    { theme: 'dark' },
    'dev-local'
);
const remote = S.buildSyncDoc(
    [{ id: 'c', name: 'Music', icon: '🎶' }, { id: 'd', name: 'Study', icon: '📚' }],
    { c: [{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }, { url: 'https://a.example/3' }], d: [{ url: 'https://d.example/1' }] },
    { theme: 'light' },
    'dev-remote'
);

const merged = S.mergeDocs(local, remote);
const music = merged.ws.find((w) => String(w.n).toLowerCase() === 'music');
assert(music, 'music workspace exists once');
assert(merged.ws.filter((w) => String(w.n).toLowerCase() === 'music').length === 1, 'same name not duplicated');
assert(music.c === '🎵', 'equal revisions retain the local icon');
assert((merged.t[music.i] || []).length === 3, 'music tabs union de-duped by url → 3');

const emptyish = S.buildSyncDoc(
    S.DEFAULT_WORKSPACE_IDS.map((id) => ({ id, name: id, icon: '📁' })),
    Object.fromEntries(S.DEFAULT_WORKSPACE_IDS.map((id) => [id, []])),
    {},
    'dev'
);
assert(S.isPristineDefaultDoc(emptyish), 'pristine defaults with zero tabs');

const packed = await S.pack(local);
assert(packed.chunks.length >= 1, 'pack produces chunks');
assert(packed.meta.fp === S.dataFingerprint(local), 'meta fingerprint matches');

console.log('all smoke checks passed');
