/**
 * SyncBreath — perimeter glow + compact sync toast (sidebar & options).
 * Intensities: "changed" (real tab/workspace delta) | "quiet" (Firefox sync pass, nothing new).
 */
(function (global) {
    'use strict';

    const THEMES = ['orange', 'amber', 'mint', 'sky', 'rose'];
    const STORAGE_KEY = 'syncBreathTheme';
    const TOAST_MS = 30000;

    let rootEl = null;
    let toastEl = null;
    let playTimer = null;
    let toastTimer = null;
    let preferredTheme = 'orange';
    let enabled = true;

    function t(key, substitutions) {
        try {
            if (typeof getMessage === 'function') {
                const msg = getMessage(key, substitutions);
                if (msg) return msg;
            }
        } catch (e) { /* fall through */ }
        try {
            if (global.browser && browser.i18n && browser.i18n.getMessage) {
                const msg = browser.i18n.getMessage(key, substitutions);
                if (msg) return msg;
            }
        } catch (e2) { /* fall through */ }
        return '';
    }

    function ensureRoot() {
        if (rootEl && rootEl.isConnected) return rootEl;
        rootEl = document.getElementById('sync-breath');
        if (!rootEl) {
            rootEl = document.createElement('div');
            rootEl.id = 'sync-breath';
            rootEl.setAttribute('aria-hidden', 'true');
            (document.body || document.documentElement).appendChild(rootEl);
        }
        rootEl.dataset.sbTheme = preferredTheme;
        return rootEl;
    }

    function ensureToast() {
        if (toastEl && toastEl.isConnected) return toastEl;
        toastEl = document.getElementById('sync-activity-toast');
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'sync-activity-toast';
            toastEl.setAttribute('role', 'status');
            (document.body || document.documentElement).appendChild(toastEl);
        }
        toastEl.addEventListener('click', hideToast);
        return toastEl;
    }

    function loadTheme() {
        try {
            if (!global.browser || !browser.storage || !browser.storage.local) return;
            browser.storage.local.get([STORAGE_KEY, 'syncBreathEnabled']).then((res) => {
                enabled = res.syncBreathEnabled !== false;
                const checkbox = document.getElementById('sync-breath-enabled');
                if (checkbox) checkbox.checked = enabled;
                if (res && THEMES.includes(res[STORAGE_KEY])) {
                    preferredTheme = res[STORAGE_KEY];
                    ensureRoot().dataset.sbTheme = preferredTheme;
                    syncSwatches();
                }
            }).catch(() => {});
            if (browser.storage.onChanged) {
                browser.storage.onChanged.addListener((changes, area) => {
                    if (area !== 'local') return;
                    if (changes.syncBreathEnabled) {
                        enabled = changes.syncBreathEnabled.newValue !== false;
                        const checkbox = document.getElementById('sync-breath-enabled');
                        if (checkbox) checkbox.checked = enabled;
                        if (!enabled) clearPlaying();
                    }
                    const next = changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue;
                    if (THEMES.includes(next)) {
                        preferredTheme = next;
                        ensureRoot().dataset.sbTheme = preferredTheme;
                        syncSwatches();
                    }
                });
            }
        } catch (e) { /* ignore */ }
    }

    function setTheme(theme, opts) {
        if (!THEMES.includes(theme)) return;
        preferredTheme = theme;
        ensureRoot().dataset.sbTheme = theme;
        syncSwatches();
        const skipStore = opts && opts.skipStore;
        if (!skipStore) {
            try {
                if (browser && browser.storage && browser.storage.local) {
                    browser.storage.local.set({ [STORAGE_KEY]: theme }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
        }
    }

    function clearPlaying() {
        const el = ensureRoot();
        el.classList.remove('sb-playing-changed', 'sb-playing-quiet', 'sb-playing-wave');
    }

    /** @param {'changed'|'quiet'} kind */
    function play(kind, opts) {
        if (!enabled || kind === 'quiet') return;
        if (opts && opts.theme) setTheme(opts.theme, { skipStore: true });
        const el = ensureRoot();
        el.dataset.sbTheme = preferredTheme;

        if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }

        clearPlaying();
        void el.offsetWidth;
        const useQuiet = kind === 'quiet';
        el.classList.add(useQuiet ? 'sb-playing-quiet' : 'sb-playing-changed');

        if (playTimer) clearTimeout(playTimer);
        playTimer = setTimeout(() => {
            clearPlaying();
            playTimer = null;
        }, useQuiet ? 1700 : 2200);
    }

    function hideToast() {
        const el = ensureToast();
        el.classList.remove('sb-toast-visible');
        el.textContent = '';
        if (toastTimer) {
            clearTimeout(toastTimer);
            toastTimer = null;
        }
    }

    /**
     * Toast only on Options (bottom-right), and only for real +/− counts.
     * Quiet / “already up to date” is breath-only — no toast.
     */
    function isOptionsPage() {
        try {
            return !!(document.documentElement && document.documentElement.classList.contains('options-page'));
        } catch (e) {
            return false;
        }
    }

    function showToast(info) {
        if (!isOptionsPage()) return;
        if (!info || info.kind === 'quiet' || info.working) return;
        const added = Math.max(0, Number(info.added) || 0);
        const removed = Math.max(0, Number(info.removed) || 0);
        if (!added && !removed) return;

        const el = ensureToast();
        while (el.firstChild) el.removeChild(el.firstChild);

        const title = document.createElement('div');
        title.className = 'sb-toast-title';
        title.textContent = t('syncToastTitle') || 'Synced';
        const body = document.createElement('div');
        body.className = 'sb-toast-body';
        body.textContent = t('syncToastCounts', [String(added), String(removed)]) ||
            ('+' + added + ' · −' + removed);
        const hint = document.createElement('div');
        hint.className = 'sb-toast-hint';
        hint.textContent = t('syncToastDismissHint') || 'Click to dismiss';

        el.appendChild(title);
        el.appendChild(body);
        el.appendChild(hint);
        el.classList.add('sb-toast-visible');

        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            hideToast();
            toastTimer = null;
        }, TOAST_MS);
    }

    function playFromSyncMessage(message) {
        if (!message) return;
        if (message.action === 'SYNC_BREATH' || message.action === 'SYNC_ACTIVITY') {
            if (message.theme && THEMES.includes(message.theme)) {
                preferredTheme = message.theme;
                ensureRoot().dataset.sbTheme = preferredTheme;
                syncSwatches();
            }
            if (message.working || message.kind === 'quiet') return;
            if (!message.preview && !(message.added > 0 || message.removed > 0)) return;
            const kind = message.kind === 'quiet' ? 'quiet' : 'changed';
            play(kind);
            if (message.showToast !== false && kind === 'changed') {
                showToast({ kind: 'changed', added: message.added, removed: message.removed });
            }
        }
    }

    function syncSwatches() {
        document.querySelectorAll('.sync-breath-swatch[data-theme]').forEach((btn) => {
            btn.classList.toggle('sb-swatch-active', btn.getAttribute('data-theme') === preferredTheme);
            btn.setAttribute('aria-pressed', btn.getAttribute('data-theme') === preferredTheme ? 'true' : 'false');
        });
    }

    function bindSwatches(container) {
        if (!container) return;
        const checkbox = document.getElementById('sync-breath-enabled');
        if (checkbox) checkbox.addEventListener('change', () => {
            enabled = checkbox.checked;
            if (!enabled) clearPlaying();
            browser.storage.local.set({ syncBreathEnabled: enabled }).catch(() => {});
        });
        container.querySelectorAll('.sync-breath-swatch[data-theme]').forEach((btn) => {
            const theme = btn.getAttribute('data-theme');
            const labelKey = ({
                orange: 'syncBreathOrange',
                amber: 'syncBreathAmber',
                mint: 'syncBreathMint',
                sky: 'syncBreathSky',
                rose: 'syncBreathRose'
            })[theme];
            const label = (labelKey && t(labelKey)) || theme;
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.addEventListener('click', () => {
                setTheme(theme);
                play('changed');
                try {
                    if (browser && browser.runtime && browser.runtime.sendMessage) {
                        browser.runtime.sendMessage({ action: 'SYNC_BREATH_PREVIEW', theme }).catch(() => {});
                    }
                } catch (e) { /* ignore */ }
            });
        });
        syncSwatches();
    }

    const api = {
        THEMES,
        play,
        setTheme,
        getTheme: () => preferredTheme,
        playFromSyncMessage,
        showToast,
        hideToast,
        ensureRoot,
        loadTheme,
        bindSwatches,
        syncSwatches
    };

    global.SyncBreath = api;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureRoot();
            ensureToast();
            loadTheme();
        });
    } else {
        ensureRoot();
        ensureToast();
        loadTheme();
    }
})(typeof window !== 'undefined' ? window : globalThis);
