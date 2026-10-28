// Every localized string must render without leftover placeholders, both through Firefox's
// own rules and through the manual-language path in i18n.js (this caught "Move $COUNT$ Tabs").
import { readFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8').replace(/^\ufeff/, '');
const locales = readdirSync(new URL('_locales/', root)).filter(d => statSync(new URL(`_locales/${d}`, root)).isDirectory());
const dicts = Object.fromEntries(locales.map(l => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
const en = dicts.en;
assert.equal(locales.length, 19, 'expected 19 locales');

// 1. Locale parity and placeholder definitions.
const named = message => [...message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map(m => m[1].toLowerCase()).sort();
const positional = message => [...message.matchAll(/\$(\d)/g)].map(m => m[1]).sort();
for (const [loc, dict] of Object.entries(dicts)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), `${loc}: key set differs from en`);
    for (const [key, entry] of Object.entries(dict)) {
        assert.ok(typeof entry.message === 'string' && entry.message.trim(), `${loc}.${key}: empty message`);
        const defined = Object.keys(entry.placeholders || {}).map(n => n.toLowerCase());
        for (const name of named(entry.message)) assert.ok(defined.includes(name), `${loc}.${key}: $${name.toUpperCase()}$ has no placeholder definition`);
        assert.deepEqual(named(entry.message), named(en[key].message), `${loc}.${key}: named placeholders differ from en`);
        assert.deepEqual(positional(entry.message), positional(en[key].message), `${loc}.${key}: $1/$2 differ from en`);
    }
}
console.log('ok 19 locales share keys and placeholder definitions');

// 2. Render every message through i18n.js with a manually chosen language.
const storage = { ui_language: 'en' };
const context = vm.createContext({
    browser: {
        storage: { local: { async get() { return { ...storage }; } }, onChanged: { addListener() {} } },
        runtime: { getURL: p => p },
        i18n: { getMessage: () => 'FALLBACK' }
    },
    fetch: async url => ({ json: async () => JSON.parse(read(url)) })
});
context.window = context;
vm.runInContext(read('i18n.js'), context);
for (const loc of locales) {
    storage.ui_language = loc;
    await context.initI18n();
    assert.ok(context.i18nDict, `${loc}: dictionary did not load`);
    for (const key of Object.keys(en)) {
        const text = context.getMessage(key, ['7', 'Work', '3']);
        assert.ok(!/\$[A-Za-z0-9_@]+\$|\$\d/.test(text), `${loc}.${key}: unsubstituted placeholder in "${text}"`);
    }
    assert.ok(context.getMessage('moveTabs', ['7']).includes('7'), `${loc}: moveTabs lost its count`);
}
storage.ui_language = 'en';
await context.initI18n();
assert.equal(context.getMessage('moveTabs', ['7']), 'Move 7 Tabs to Workspace');
assert.equal(context.getMessage('movedTabs', ['2', 'Work']), 'Moved 2 tabs to Work');
assert.equal(context.getMessage('shortcutOpenWorkspace', ['4']), 'Open workspace 4:');
storage.ui_language = 'auto';
await context.initI18n();
assert.equal(context.i18nDict, null, 'Auto must fall back to the browser language');
assert.equal(context.getMessage('moveTabs', ['7']), 'FALLBACK');
console.log('ok every message renders without leftover placeholders in all locales');

// 3. Every key the code and manifest reference exists.
const sources = ['manifest.json', 'background.js', 'options.html', 'options.js', 'sidebar.html', 'sidebar.js', 'sync-breath.js', 'sync-progress.js'].map(read).join('\n');
const used = new Set();
for (const re of [/getMessage\(\s*['"]([A-Za-z0-9_]+)['"]/g, /data-i18n(?:-[a-z]+)?="([A-Za-z0-9_]+)"/g, /__MSG_([A-Za-z0-9_]+)__/g]) {
    for (const m of sources.matchAll(re)) used.add(m[1]);
}
for (const key of used) assert.ok(en[key], `referenced key missing from locales: ${key}`);
console.log(`ok ${used.size} referenced keys exist`);
