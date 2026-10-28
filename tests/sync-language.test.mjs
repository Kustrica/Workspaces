// The interface language syncs only as an explicit, timestamped choice.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const sandbox = { console, TextEncoder, TextDecoder, btoa, atob, Response, Uint8Array, crypto: globalThis.crypto };
sandbox.window = sandbox; sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('../sync.js', import.meta.url), 'utf8'), sandbox);
const S = sandbox.WorkspacesSync;
const ws = [{ id: 'a', name: 'Main', icon: 'x' }];
const build = (settings, dev) => S.buildSyncDoc(ws, { a: [{ url: 'https://a.test/' }] }, settings, dev);

// A value nobody chose (no timestamp, e.g. an older version) is never published.
assert.equal(build({ theme: 'dark', ui_language: 'en' }, 'A').s.ui_language, undefined);
assert.equal(build({ theme: 'dark' }, 'A').s.ui_language, undefined);
console.log('ok unchosen language is not published');

// An explicit choice is published with its time.
const chosen = build({ ui_language: 'ru', ui_language_set_at: 200 }, 'A');
assert.equal(chosen.s.ui_language, 'ru');
assert.equal(chosen.s.ui_language_set_at, 200);
console.log('ok explicit choice is published');

// Merge: newest explicit choice wins; a remote value without a time never wins.
const legacyRemote = build({}, 'B'); legacyRemote.s.ui_language = 'en';
assert.equal(S.mergeDocs(build({}, 'A'), legacyRemote).s.ui_language, undefined);
const autoLocal = build({ ui_language: 'auto', ui_language_set_at: 300 }, 'A');
const olderRemote = build({ ui_language: 'en', ui_language_set_at: 100 }, 'B');
assert.equal(S.mergeDocs(autoLocal, olderRemote).s.ui_language, 'auto');
assert.equal(S.mergeDocs(autoLocal, olderRemote, build({}, 'A')).s.ui_language, 'auto');
const newerRemote = build({ ui_language: 'de', ui_language_set_at: 400 }, 'B');
assert.equal(S.mergeDocs(autoLocal, newerRemote).s.ui_language, 'de');
console.log('ok newest explicit choice wins; legacy values never do');
console.log('4 language sync tests passed');
