(function () {
    const root = document.getElementById('sync-apply-progress');
    if (!root) return;

    const label = document.getElementById('sync-apply-progress-label');
    const count = document.getElementById('sync-apply-progress-count');
    const track = document.getElementById('sync-apply-progress-track');
    const fill = document.getElementById('sync-apply-progress-fill');
    let hideTimer = null;

    const messages = {
        creating: ['syncProgressOpening', 'Opening tabs'],
        closing: ['syncProgressClosing', 'Closing tabs'],
        arranging: ['syncProgressFinishing', 'Finishing tab changes'],
        done: ['syncProgressComplete', 'Tab changes complete'],
        error: ['syncProgressFailed', 'Some tab changes could not be applied']
    };

    function localized(key, fallback, params) {
        try {
            const value = window.getMessage ? window.getMessage(key, params) : browser.i18n.getMessage(key, params);
            return value || fallback;
        } catch (_) {
            return fallback;
        }
    }

    function update(message) {
        if (!message || message.action !== 'SYNC_APPLY_PROGRESS' || !message.total) return;
        clearTimeout(hideTimer);

        const phase = messages[message.phase] ? message.phase : 'arranging';
        const [key, fallback] = messages[phase];
        const phaseDone = Math.max(0, Number(message.phaseDone ?? message.done) || 0);
        const phaseTotal = Math.max(0, Number(message.phaseTotal ?? message.total) || 0);
        const remaining = Math.max(0, phaseTotal - phaseDone);
        const percent = Math.max(0, Math.min(100, Number(message.progress) || 0));

        label.textContent = localized(key, fallback);
        count.textContent = localized(
            'syncProgressCounts',
            `${phaseDone} of ${phaseTotal} complete · ${remaining} remaining`,
            [phaseDone, phaseTotal, remaining]
        );
        root.dataset.phase = phase;
        fill.style.width = `${percent}%`;
        track.setAttribute('aria-valuenow', String(percent));
        track.setAttribute('aria-valuetext', `${percent}%`);
        root.setAttribute('aria-label', `${label.textContent}. ${count.textContent}`);
        root.classList.add('is-visible');

        if (phase === 'done' || phase === 'error') {
            hideTimer = setTimeout(() => root.classList.remove('is-visible'), phase === 'error' ? 5000 : 1400);
        }
    }

    browser.runtime.onMessage.addListener(update);
})();
