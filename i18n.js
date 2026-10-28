window.i18nDict = null;

// Interface languages shipped in _locales. 'auto' means "follow the browser language".
window.I18N_LANGUAGES = ['ar', 'be', 'de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'nl', 'pl',
    'pt_BR', 'ru', 'tr', 'uk', 'vi', 'zh_CN', 'zh_TW'];

window.initI18n = async function() {
    const res = await browser.storage.local.get('ui_language');
    const lang = res.ui_language || 'auto';
    if (lang === 'auto' || !window.I18N_LANGUAGES.includes(lang)) {
        window.i18nDict = null;
        return;
    }
    try {
        const req = await fetch(browser.runtime.getURL(`_locales/${lang}/messages.json`));
        window.i18nDict = await req.json();
    } catch (e) {
        window.i18nDict = null;
    }
};

// Same rules as browser.i18n.getMessage: named placeholders ($COUNT$) resolve through the
// entry's "placeholders" table, $1..$9 take the substitutions, $$ is a literal dollar sign.
window.formatI18nMessage = function(entry, params) {
    if (!entry || typeof entry.message !== 'string') return '';
    const subs = params == null ? [] : (Array.isArray(params) ? params : [params]).map(String);
    const positional = text => text.replace(/\$(\d+)/g, (m, n) => {
        const value = subs[Number(n) - 1];
        return value === undefined ? '' : value;
    });
    const named = {};
    for (const [name, def] of Object.entries(entry.placeholders || {})) {
        named[name.toLowerCase()] = def && def.content != null ? String(def.content) : '';
    }
    return entry.message.replace(/\$\$|\$(\d+)|\$([A-Za-z0-9_@]+)\$/g, (match, num, name) => {
        if (match === '$$') return '$';
        if (num !== undefined) {
            const value = subs[Number(num) - 1];
            return value === undefined ? '' : value;
        }
        const content = named[name.toLowerCase()];
        return content === undefined ? match : positional(content);
    });
};

window.getMessage = function(key, params) {
    const entry = window.i18nDict && window.i18nDict[key];
    if (entry && typeof entry.message === 'string') return window.formatI18nMessage(entry, params);
    return browser.i18n.getMessage(key, params);
};

// Keep long-lived pages (background) in step when the language is changed or reset to Auto.
if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.ui_language) window.initI18n().catch(() => {});
    });
}
