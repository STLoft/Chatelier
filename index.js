import { DEFAULT_PRESETS, normalizePresets, uniquePresetName, parsePresetBundle, createPresetBundle, buildVisualPrompt } from './presets.js';

const EXT_KEY = 'codexImage';
const API_BASE = '/api/plugins/codex-image';
const HISTORY_MAX = 20;
const CLIENT_VERSION = '1.0.0';

let connectionManagerService = null;
let connectionManagerLoadError = null;
let initialized = false;
let settingsMountObserver = null;

const REFINE_SCENE = [
    'You convert a Korean roleplay scene into concise image-generation tags.',
    'Read the scene and pick the single most visually striking moment.',
    'Output EXACTLY these four lines and nothing else:',
    'bg: <background and setting tags>',
    'char: <character count and appearance tags, e.g. 1man 1woman>',
    'outfit: <clothing tags>',
    'comp: <composition, pose, camera angle, expression tags>',
    '',
    'Rules:',
    '- English image-generation tags, comma-separated within each line.',
    '- Keep the four labels bg:, char:, outfit:, comp: exactly.',
    '- Ignore dialogue text, inner thoughts, and time passing.',
    '- Do not add art style, quality tags, no-text tags, or watermarks.',
    '',
    'Scene:',
    '{scene}',
].join('\n');

const REFINE_SOLO = [
    'You convert a Korean roleplay scene into concise image-generation tags for a SOLO portrait.',
    'Focus on ONE single character, the most prominent one in the moment.',
    'Output EXACTLY these four lines and nothing else:',
    'bg: <simple or softly blurred background tags>',
    'char: <single character appearance tags; include solo and 1girl/1boy/1woman/1man as appropriate>',
    'outfit: <clothing tags for that character>',
    'comp: <portrait composition, camera angle, expression and pose>',
    '',
    'Rules:',
    '- English image-generation tags, comma-separated within each line.',
    '- Keep the four labels bg:, char:, outfit:, comp: exactly.',
    '- Ignore other characters in the scene.',
    '- Do not add art style, quality tags, no-text tags, or watermarks.',
    '',
    'Scene:',
    '{scene}',
].join('\n');

const VERTEX_DEFAULT_MODEL = 'gemini-3.1-flash-image';
const VERTEX_PREVIEW_MODEL = 'gemini-3.1-flash-image-preview';
const VERTEX_MODELS = [VERTEX_DEFAULT_MODEL, VERTEX_PREVIEW_MODEL];

const VERTEX_REF_LABELS = {
    char: 'Reference image: main character. Preserve this character identity, face, hairstyle, body design, and distinctive visual features when the character appears.',
    persona: 'Reference image: user/persona. Preserve this person identity, face, hairstyle, body design, and distinctive visual features when the persona appears.',
    style: [
        'STYLE REFERENCE — GLOBAL RENDERING ONLY.',
        'Treat this image strictly as a reference for the global visual language, not as a character or content reference.',
        'Ignore the depicted person as content. Do not copy or derive their identity, face, facial proportions, hairstyle, hair color, body, clothing, pose, expression, accessories, or composition.',
        'Extract only the line weight, inking, contour treatment, shape simplification, coloring, cel shading, gradients, textures, lighting, contrast, highlights, shadow design, background rendering, effects, atmosphere, and overall webtoon/comic finish.',
        'Apply that visual language consistently to the ENTIRE generated image: every character, face, hair, garment, prop, structure, background, light, effect, and visible region of the canvas.',
        'The scene prompt determines what appears, and CHARACTER/PERSONA references determine identity only. This STYLE reference must never determine a person\'s identity or appearance.',
        'Create a completely new scene rendered in the same overall visual language; do not recreate the subject or composition shown here.',
    ].join(' '),
};

const DEFAULTS = {
    mode: 'scene',
    sourceMode: 'last',
    engine: 'codex',
    codexModel: '',
    refSource: 'chat',
    vertexApiKey: '',
    vertexModel: VERTEX_DEFAULT_MODEL,
    useChatAvatars: true,
    insertWidthPercent: 70,
    rangeStart: null,
    rangeEnd: null,
    refineMode: 'codex', // codex = raw scene goes directly to Codex CLI; profile = ST Connection Profile pre-refine
    connectionProfileId: '',
    profileMaxTokens: 700,
    sizeHint: '1024x1024',
    qualityHint: 'auto',
    activePreset: 0,
    presets: DEFAULT_PRESETS,
    refinePrompts: { scene: REFINE_SCENE, solo: REFINE_SOLO },
    refImages: { char: '', persona: '', style: '' }, // char is legacy (global); uploads now live in charRefs
    charRefs: {}, // { [characterKey]: dataUrl } uploaded character reference, kept per character
    history: [],
};

let settings;
let currentJob = null;
let runningController = null;
let panelOpen = false;
let activeView = 'result';
let elapsedTimer = null;
let codexStatus = null;
let codexModels = [];
let codexModelsLoaded = false;
let codexModelsLoading = null;
let codexModelsError = '';
let customCodexModel = false;
let profileList = [];
let inlineMode = true;
let pendingRangeStart = null;
let pendingInsert = null;
let messageObserver = null;

let delegatedBound = false;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getContext() {
    return SillyTavern.getContext();
}

function normalizeSettings(raw) {
    const out = { ...clone(DEFAULTS), ...(raw || {}) };
    out.presets = normalizePresets(out.presets);
    out.activePreset = Math.max(0, Math.min(Number(out.activePreset) || 0, out.presets.length - 1));
    out.refinePrompts = { ...DEFAULTS.refinePrompts, ...(out.refinePrompts || {}) };
    out.refImages = { ...DEFAULTS.refImages, ...(out.refImages || {}) };
    out.charRefs = Object.fromEntries(Object.entries(out.charRefs && typeof out.charRefs === 'object' ? out.charRefs : {})
        .filter(([, value]) => typeof value === 'string' && value.startsWith('data:image/')));
    delete out.showFloatingButton;
    out.history = Array.isArray(out.history) ? out.history.slice(0, HISTORY_MAX) : [];
    if (!['scene', 'solo'].includes(out.mode)) out.mode = 'scene';
    if (!['codex', 'profile'].includes(out.refineMode)) out.refineMode = 'codex';
    if (!['last', 'range'].includes(out.sourceMode)) out.sourceMode = 'last';
    if (!['codex', 'vertex'].includes(out.engine)) out.engine = 'codex';
    out.codexModel = typeof out.codexModel === 'string' ? out.codexModel.trim() : '';
    if (!['chat', 'upload', 'none'].includes(out.refSource)) out.refSource = out.useChatAvatars === false ? 'upload' : 'chat';
    delete out.vertexProjectId;
    out.vertexApiKey = String(out.vertexApiKey || '');
    out.vertexModel = VERTEX_MODELS.includes(out.vertexModel) ? out.vertexModel : VERTEX_DEFAULT_MODEL;
    out.useChatAvatars = out.useChatAvatars !== false;
    out.insertWidthPercent = Math.max(10, Math.min(100, Number(out.insertWidthPercent) || 70));
    out.rangeStart = Number.isInteger(out.rangeStart) ? out.rangeStart : null;
    out.rangeEnd = Number.isInteger(out.rangeEnd) ? out.rangeEnd : null;
    return out;
}

function loadSettings() {
    const ctx = getContext();
    ctx.extensionSettings[EXT_KEY] = normalizeSettings(ctx.extensionSettings[EXT_KEY]);
    settings = ctx.extensionSettings[EXT_KEY];
}

function saveSettings() {
    const ctx = getContext();
    ctx.extensionSettings[EXT_KEY] = settings;
    return ctx.saveSettingsDebounced?.();
}

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function toast(type, message, title = 'Chatelier') {
    try { inlineNotice(type, message); } catch (_) { /* ignore */ }
    if (window.toastr?.[type]) window.toastr[type](message, title);
    console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
}

function headers() {
    return getContext().getRequestHeaders();
}

async function apiFetch(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { ...headers(), ...(options.headers || {}) },
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { error: text }; }
    if (response.status === 404) throw new Error('Chatelier-Bridge가 설치·활성화되어 있는지 확인하고 SillyTavern 서버를 재시작하세요. 설치 안내: https://github.com/STLoft/Chatelier-Bridge');
    if (!response.ok || json.ok === false) throw new Error(json.error || `${response.status} ${response.statusText}`);
    return json;
}

function createUi() {
    if (!document.getElementById('cxi-root')) {
        const root = document.createElement('div');
        root.id = 'cxi-root';
        root.innerHTML = `
            <div id="cxi-overlay" class="cxi-overlay cxi-hidden">
                <div class="cxi-backdrop"></div>
                <section id="cxi-panel" class="cxi-panel" role="dialog" aria-label="Chatelier">
                    <header id="cxi-drag" class="cxi-header">
                        <div><strong>Chatelier</strong><span id="cxi-header-meta" class="cxi-version">v${CLIENT_VERSION} · ${settings?.engine === 'vertex' ? 'Vertex' : 'Codex CLI'}</span></div>
                        <button id="cxi-close" class="cxi-iconbtn" title="닫기" aria-label="닫기">✕</button>
                    </header>
                    <nav class="cxi-tabs">
                        <button data-view="result" class="cxi-tab">만들기</button>
                        <button data-view="history" class="cxi-tab">기록</button>
                        <button data-view="settings" class="cxi-tab">설정</button>
                    </nav>
                    <main id="cxi-content" class="cxi-content"></main>
                </section>
            </div>`;
        document.body.appendChild(root);

        setupDrag();
    }

    bindDelegatedClicks();
    mountEntries();
    ensureSettingsEntryMountObserver();
}

function getSettingsHost() {
    return document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.querySelector('[id^="extensions_settings"]');
}

function mountSettingsEntry() {
    if (document.getElementById('cxi-extension-entry')) return true;
    const host = getSettingsHost();
    if (!host) return false;

    const entry = document.createElement('div');
    entry.id = 'cxi-extension-entry';
    entry.className = 'inline-drawer';
    entry.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Chatelier</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cxi-entry-actions">
                <button id="cxi-menu-open" class="menu_button cxi-block">▼ 열기 / 닫기 (v${CLIENT_VERSION})</button>
                <button id="cxi-menu-popup" class="menu_button cxi-block">팝업 창으로 열기</button>
            </div>
            <div id="cxi-inline-wrap" class="cxi-hidden cxi-inline-wrap">
                <nav class="cxi-tabs">
                    <button data-view="result" class="cxi-tab">만들기</button>
                    <button data-view="history" class="cxi-tab">기록</button>
                    <button data-view="settings" class="cxi-tab">설정</button>
                </nav>
                <div id="cxi-inline-content" class="cxi-content"></div>
            </div>
        </div>`;
    host.appendChild(entry);
    bindDelegatedClicks();
    return true;
}

function mountWandMenuEntry() {
    if (document.getElementById('cxi-wand-entry')) return false;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    const item = document.createElement('div');
    item.id = 'cxi-wand-entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<span>\u{1F3A8}</span><span>Chatelier</span>';
    item.addEventListener('click', () => openPanel('result'));
    menu.appendChild(item);
    return true;
}

function mountEntries() {
    const a = mountSettingsEntry();
    const b = mountWandMenuEntry();
    return a && (b || !!document.getElementById('cxi-wand-entry'));
}

function ensureSettingsEntryMountObserver() {
    if ((document.getElementById('cxi-extension-entry') && document.getElementById('cxi-wand-entry')) || settingsMountObserver) return;
    settingsMountObserver = new MutationObserver(() => {
        if (mountEntries()) {
            settingsMountObserver?.disconnect();
            settingsMountObserver = null;
        }
    });
    settingsMountObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
        settingsMountObserver?.disconnect();
        settingsMountObserver = null;
    }, 30000);
}

function setupDrag() {
    const handle = document.getElementById('cxi-drag');
    const panel = document.getElementById('cxi-panel');
    if (!handle || !panel) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    handle.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        if (window.innerWidth < 560) return;
        const rect = panel.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        baseLeft = rect.left;
        baseTop = rect.top;
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
        if (!dragging) return;
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        panel.style.left = `${Math.max(0, Math.min(maxLeft, baseLeft + event.clientX - startX))}px`;
        panel.style.top = `${Math.max(0, Math.min(maxTop, baseTop + event.clientY - startY))}px`;
    });
    const stop = event => {
        dragging = false;
        try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function contentEl() {
    if (inlineMode) {
        const inline = document.getElementById('cxi-inline-content');
        if (inline) return inline;
    }
    return document.getElementById('cxi-content');
}

function bindDelegatedClicks() {
    if (delegatedBound) return;
    delegatedBound = true;
    const reposition = () => { if (panelOpen && !inlineMode) positionPopup(); };
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    window.addEventListener('resize', reposition);
    document.addEventListener('click', event => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        try {
            if (target.closest('#cxi-menu-open')) { event.preventDefault(); toggleInline('result'); return; }
            if (target.closest('#cxi-menu-popup')) { event.preventDefault(); openPanel('result'); return; }
            if (target.closest('#cxi-close') || target.closest('.cxi-backdrop')) { event.preventDefault(); closePanel(); return; }
            const updateCli = target.closest('#cxi-update-cli');
            if (updateCli) { event.preventDefault(); updateCodexCli(updateCli); return; }
            const tab = target.closest('.cxi-tab');
            if (tab && tab.dataset.view) { event.preventDefault(); activeView = tab.dataset.view; render(); }
        } catch (error) {
            showBootBanner('error', `\ud074\ub9ad \ucc98\ub9ac \uc624\ub958: ${error?.message || error}`);
        }
    }, true);
}

function toggleInline(view = 'settings') {
    try {
        const wrap = document.getElementById('cxi-inline-wrap');
        if (!wrap) { showBootBanner('error', '#cxi-inline-wrap \uc774 \uc5c6\uc2b5\ub2c8\ub2e4.'); return; }
        if (!settings) settings = normalizeSettings(null);
        const opening = wrap.classList.contains('cxi-hidden');
        wrap.classList.toggle('cxi-hidden', !opening);
        inlineMode = true;
        panelOpen = opening;
        activeView = view;
        if (!opening) { stopElapsedTimer(); return; }
        try {
            render();
        } catch (error) {
            const box = document.getElementById('cxi-inline-content');
            if (box) box.innerHTML = `<div class="cxi-errorbox"><h3>\ud654\uba74 \uadf8\ub9ac\uae30 \uc2e4\ud328</h3><pre>${esc(error?.stack || error?.message || error)}</pre></div>`;
            showBootBanner('error', `render() \uc608\uc678\n${error?.message || error}`);
            return;
        }
        startElapsedTimer();
        refreshCodexStatus(false).catch(() => {});
        refreshProfiles().catch(() => {});
    } catch (error) {
        showBootBanner('error', `\uc778\ub77c\uc778 \uc5f4\uae30 \uc2e4\ud328: ${error?.message || error}`);
    }
}

function describeNode(node) {
    if (!node) return 'null';
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
    return `${node.tagName || '?'}${id}${cls}`.slice(0, 120);
}

function positionPopup() {
    const panel = document.getElementById('cxi-panel');
    if (!panel) return;
    const vv = window.visualViewport;
    const width = Math.round(vv?.width || window.innerWidth || 360);
    const height = Math.round(vv?.height || window.innerHeight || 640);
    const left = Math.round(vv?.offsetLeft || 0) + 8;
    const top = Math.round(vv?.offsetTop || 0) + 8;
    // Inline !important is required: the mobile media query pins bottom/top with !important.
    panel.style.setProperty('position', 'fixed', 'important');
    panel.style.setProperty('top', `${top}px`, 'important');
    panel.style.setProperty('left', `${left}px`, 'important');
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('width', `${Math.min(390, width - 16)}px`, 'important');
    panel.style.setProperty('height', `${height - 16}px`, 'important');
    panel.style.setProperty('max-height', 'none', 'important');
}

function reportPanelGeometry() {
    requestAnimationFrame(() => {
        try {
            const overlay = document.getElementById('cxi-overlay');
            const panel = document.getElementById('cxi-panel');
            if (!overlay || !panel) {
                showBootBanner('error', `DOM \ub204\ub77d - overlay:${!!overlay} panel:${!!panel}`);
                return;
            }
            const rect = panel.getBoundingClientRect();
            const style = getComputedStyle(overlay);
            if (rect.width < 5 || rect.height < 5) {
                showBootBanner('error', `\ud328\ub110 \ud06c\uae30 0 - w:${Math.round(rect.width)} h:${Math.round(rect.height)}\noverlay display:${style.display} visibility:${style.visibility} opacity:${style.opacity}`);
                return;
            }
            const cx = Math.round(rect.left + rect.width / 2);
            const cy = Math.round(rect.top + 30);
            const top = document.elementFromPoint(cx, cy);
            const covered = !(top && (top === panel || panel.contains(top) || top.closest?.('#cxi-root')));
            if (covered) {
                showBootBanner('error', `\ud328\ub110\uc740 \uc5f4\ub838\uc9c0\ub9cc \uac00\ub824\uc84c\uc2b5\ub2c8\ub2e4.\n\uc704\uc5d0 \uc788\ub294 \uc694\uc18c: ${describeNode(top)}\n\uc704\uce58 x:${cx} y:${cy} / z-index:${style.zIndex}`);
            } else {
                // Success is visible in the extension menu; only failures need a banner.
            }
        } catch (error) {
            showBootBanner('error', `\uc9c4\ub2e8 \uc2e4\ud328: ${error?.message || error}`);
        }
    });
}

function showView(view = activeView) {
    activeView = view;
    panelOpen = true;
    try {
        if (inlineMode) {
            const wrap = document.getElementById('cxi-inline-wrap');
            if (wrap) wrap.classList.remove('cxi-hidden');
        } else {
            document.getElementById('cxi-overlay')?.classList.remove('cxi-hidden');
        }
        render();
        startElapsedTimer();
    } catch (error) {
        inlineNotice('error', `\ud654\uba74 \uac31\uc2e0 \uc2e4\ud328: ${error?.message || error}`);
    }
}

function inlineNotice(kind, message) {
    const host = contentEl();
    if (!host) { showBootBanner(kind, message); return; }
    let bar = document.getElementById('cxi-notice');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'cxi-notice';
        bar.className = 'cxi-notice';
        bar.addEventListener('click', () => bar.remove());
        host.prepend(bar);
    } else if (bar.parentElement !== host) {
        host.prepend(bar);
    }
    bar.dataset.kind = kind === 'success' || kind === 'ok' ? 'ok' : 'err';
    bar.textContent = message;
    if (bar.dataset.kind === 'ok') setTimeout(() => bar.remove(), 5000);
}

function openPanel(view = activeView) {
    let step = 'start';
    inlineMode = false;
    try {
        step = 'ensure-ui';
        if (!document.getElementById('cxi-root')) createUi();

        step = 'settings-guard';
        if (!settings) settings = normalizeSettings(null);

        step = 'overlay';
        const overlay = document.getElementById('cxi-overlay');
        if (!overlay) throw new Error('#cxi-overlay \uac00 DOM\uc5d0 \uc5c6\uc2b5\ub2c8\ub2e4.');
        activeView = view;
        panelOpen = true;
        overlay.classList.remove('cxi-hidden');

        step = 'render';
        try {
            render();
        } catch (renderError) {
            const content = contentEl();
            if (content) {
                content.innerHTML = `<div class="cxi-errorbox"><h3>\ud654\uba74 \uadf8\ub9ac\uae30 \uc2e4\ud328</h3><pre>${esc(renderError?.stack || renderError?.message || renderError)}</pre></div>`;
            }
            showBootBanner('error', `render() \uc608\uc678 (view: ${view})\n${renderError?.message || renderError}`);
        }

        step = 'timer';
        startElapsedTimer();
        if (view === 'settings') refreshCodexStatus(false).catch(() => {});
        if (view === 'settings') refreshProfiles().catch(() => {});

        step = 'position';
        positionPopup();

        step = 'geometry';
        reportPanelGeometry();
    } catch (error) {
        showBootBanner('error', `\ucc3d \uc5f4\uae30 \uc2e4\ud328 (step: ${step})\n${error?.message || error}`);
    }
}

function closePanel() {
    inlineMode = true;
    panelOpen = false;
    document.getElementById('cxi-overlay')?.classList.add('cxi-hidden');
    stopElapsedTimer();
}

function clearInactiveContainer() {
    // The inline drawer and the popup use the same element ids. If both hold a
    // rendered form, document.getElementById() resolves to the hidden one and
    // every change handler silently binds to the wrong node.
    const inline = document.getElementById('cxi-inline-content');
    const popup = document.getElementById('cxi-content');
    const stale = inlineMode ? popup : inline;
    if (stale && stale.innerHTML !== '') stale.innerHTML = '';
}

function render() {
    if (!panelOpen) return;
    clearInactiveContainer();
    const scope = contentEl()?.closest('#cxi-inline-wrap, #cxi-panel') || document;
    scope.querySelectorAll('.cxi-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.view === activeView));
    const headerMeta = document.getElementById('cxi-header-meta');
    if (headerMeta) headerMeta.textContent = `v${CLIENT_VERSION} · ${engineName()}`;
    if (activeView === 'settings') renderSettings();
    else if (activeView === 'history') renderHistory();
    else renderResult();
}

function sourcePickerMarkup() {
    const isRange = (settings.sourceMode || 'last') === 'range';
    const chat = getChat();
    const maxIndex = chat.length ? chat.length - 1 : 0;
    const startValue = settings.rangeStart === null ? '' : settings.rangeStart;
    const endValue = settings.rangeEnd === null ? '' : settings.rangeEnd;

    return `
        <details class="cxi-section cxi-source" ${isRange ? 'open' : ''}>
            <summary><b>\uc7a5\uba74 \uc18c\uc2a4</b> \u00b7 <span id="cxi-source-summary">${esc(sourceSummary())}</span></summary>
            <label>\uc5b4\ub514\uc11c \uac00\uc838\uc62c\uc9c0
                <select id="cxi-source-mode">
                    <option value="last" ${isRange ? '' : 'selected'}>\ucd5c\uadfc AI \uc751\ub2f5 (\uae30\ubcf8)</option>
                    <option value="range" ${isRange ? 'selected' : ''}>\uba54\uc2dc\uc9c0 \ubc88\ud638 \uad6c\uac04</option>
                </select>
            </label>
            <div id="cxi-source-range" class="${isRange ? '' : 'cxi-hidden'}">
                <div class="cxi-grid2">
                    <label>\uc2dc\uc791 #<input id="cxi-range-start" type="number" inputmode="numeric" min="0" max="${maxIndex}" step="1" value="${startValue}" placeholder="0"></label>
                    <label>\ub05d #<input id="cxi-range-end" type="number" inputmode="numeric" min="0" max="${maxIndex}" step="1" value="${endValue}" placeholder="${maxIndex}"></label>
                </div>
                <p class="cxi-small cxi-muted">\ud604\uc7ac \ucc44\ud305 \ubc94\uc704: #0 ~ #${maxIndex} \u00b7 \ud55c \uce78\ub9cc \ucc44\uc6b0\uba74 \uadf8 \uba54\uc2dc\uc9c0 \ud558\ub098\ub9cc \uc0ac\uc6a9\ud569\ub2c8\ub2e4.</p>
            </div>
            <pre id="cxi-source-preview" class="cxi-source-preview">${esc(sourcePreviewText())}</pre>
        </details>`;
}

function sourcePreviewText() {
    try {
        return cleanScene(resolveSceneRaw()).slice(0, 220) || '(\ube48 \ud14d\uc2a4\ud2b8)';
    } catch (error) {
        return `\u26a0 ${error?.message || error}`;
    }
}

function refreshSourcePreview() {
    const preview = document.getElementById('cxi-source-preview');
    if (preview) preview.textContent = sourcePreviewText();
    const summary = document.getElementById('cxi-source-summary');
    if (summary) summary.textContent = sourceSummary();
}

function bindSourcePicker() {
    const modeSelect = document.getElementById('cxi-source-mode');
    if (!modeSelect) return;
    modeSelect.addEventListener('change', async event => {
        settings.sourceMode = event.target.value;
        await saveSettings();
        renderResult();
    });

    const readInput = element => {
        const raw = String(element.value ?? '').trim();
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };

    const startInput = document.getElementById('cxi-range-start');
    const endInput = document.getElementById('cxi-range-end');

    startInput?.addEventListener('input', () => {
        settings.rangeStart = readInput(startInput);
        refreshSourcePreview();
        saveSettings();
    });
    endInput?.addEventListener('input', () => {
        settings.rangeEnd = readInput(endInput);
        refreshSourcePreview();
        saveSettings();
    });
}


function presetEditorMarkup() {
    const preset = settings.presets[settings.activePreset];
    return `<section class="cxi-section cxi-prompt-editor">
        <div class="cxi-section-heading"><b>내 프롬프트</b><span class="cxi-small cxi-muted">사용자 프리셋</span></div>
        <label class="cxi-sr-only" for="cxi-preset-select">프리셋 선택</label>
        <select id="cxi-preset-select">${settings.presets.map((p, i) => `<option value="${i}" ${i === settings.activePreset ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <label class="cxi-sr-only" for="cxi-preset-body">이미지 프롬프트</label>
        <textarea id="cxi-preset-body" rows="6" maxlength="30000" placeholder="원하는 화풍과 지시문을 적으세요. 대화 장면은 자동으로 붙습니다.">${esc(preset.body)}</textarea>
        <p class="cxi-small cxi-muted">화풍과 지시문만 적어도 됩니다. {scene}으로 장면이 들어갈 위치를 지정할 수도 있습니다.</p>
        <div class="cxi-preset-tools">
            <button id="cxi-preset-save" class="menu_button">저장</button>
            <button id="cxi-preset-add" class="menu_button">새 프리셋</button>
            <button id="cxi-preset-copy" class="menu_button">복제</button>
            <button id="cxi-preset-rename" class="menu_button">이름 변경</button>
            <button id="cxi-preset-delete" class="menu_button cxi-danger-soft" ${settings.presets.length <= 1 ? 'disabled' : ''}>삭제</button>
        </div>
        <details class="cxi-preset-sharing"><summary>프리셋 공유 · 고급 변수</summary>
            <div class="cxi-preset-tools">
                <button id="cxi-preset-export" class="menu_button">전체 내보내기</button>
                <label class="menu_button cxi-file-btn">가져오기<input id="cxi-preset-import" type="file" accept=".json,application/json"></label>
            </div>
            <p class="cxi-small cxi-muted">공유 파일에는 이름과 프롬프트만 포함됩니다. 직접 적은 개인정보는 내보내기 전에 확인하세요.</p>
            <p class="cxi-small cxi-muted">API 프로필 장면 정리를 사용할 때: {bg} 배경 · {char} 인물 · {outfit} 의상 · {comp} 구도</p>
        </details>
    </section>`;
}

function capturePresetDraft() {
    const body = document.getElementById('cxi-preset-body');
    if (body) settings.presets[settings.activePreset].body = body.value;
}

function bindPresetEditor() {
    const on = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler);
    const rerender = async () => { captureSettingsDraft(); await saveSettings(); render(); };
    on('cxi-preset-body', 'input', () => { capturePresetDraft(); saveSettings(); });
    on('cxi-preset-save', 'click', async () => { capturePresetDraft(); await saveSettings(); toast('success', '프리셋을 저장했습니다.'); });
    on('cxi-preset-select', 'change', async event => {
        capturePresetDraft(); settings.activePreset = Number(event.target.value); await rerender();
    });
    on('cxi-preset-add', 'click', async () => {
        capturePresetDraft();
        const name = prompt('새 프리셋 이름 (최대 80자)');
        if (!name?.trim()) return;
        settings.presets.push({ name: uniquePresetName(name, settings.presets), body: '{scene}' });
        settings.activePreset = settings.presets.length - 1; await rerender();
    });
    on('cxi-preset-copy', 'click', async () => {
        capturePresetDraft(); const preset = settings.presets[settings.activePreset];
        settings.presets.push({ name: uniquePresetName(`${preset.name} 복사`, settings.presets), body: preset.body });
        settings.activePreset = settings.presets.length - 1; await rerender();
    });
    on('cxi-preset-rename', 'click', async () => {
        capturePresetDraft(); const preset = settings.presets[settings.activePreset];
        const name = prompt('프리셋 이름 (최대 80자)', preset.name);
        if (!name?.trim()) return;
        preset.name = uniquePresetName(name, settings.presets.filter((_, i) => i !== settings.activePreset)); await rerender();
    });
    on('cxi-preset-delete', 'click', async () => {
        if (settings.presets.length <= 1 || !confirm(`'${settings.presets[settings.activePreset].name}' 프리셋을 삭제할까요?`)) return;
        settings.presets.splice(settings.activePreset, 1);
        settings.activePreset = Math.min(settings.activePreset, settings.presets.length - 1); await rerender();
    });
    on('cxi-preset-export', 'click', () => {
        capturePresetDraft();
        const blob = new Blob([JSON.stringify(createPresetBundle(settings.presets), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = 'chatelier-presets.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    on('cxi-preset-import', 'change', async event => {
        const file = event.target.files?.[0]; if (!file) return;
        try {
            if (file.size > 1024 * 1024) throw new Error('프리셋 파일은 1MB 이하여야 합니다.');
            const incoming = parsePresetBundle(await file.text());
            capturePresetDraft(); const first = settings.presets.length;
            for (const p of incoming) settings.presets.push({ name: uniquePresetName(p.name, settings.presets), body: p.body });
            settings.activePreset = first; await rerender(); toast('success', `${incoming.length}개 프리셋을 추가했습니다.`);
        } catch (error) { toast('error', error.message); }
        finally { event.target.value = ''; }
    });
}

function renderResult() {
    const content = contentEl();
    if (!content) return;
    const presetName = settings.presets[settings.activePreset]?.name || '-';
    const modeName = settings.mode === 'solo' ? '1인샷' : '장면샷';

    if (!currentJob) {
        content.innerHTML = `
            <div class="cxi-empty">
                <div class="cxi-bigicon">🎨</div>
                <h3>이미지 생성</h3>
                <div class="cxi-result-meta"><span>${esc(modeName)}</span><span>${esc(presetName)}</span><span>${engineName()}</span></div>
                <p class="cxi-muted">장면 정리: ${settings.refineMode === 'profile' ? 'SillyTavern API 프로필' : `${engineName()} 내부 처리`}</p>
                ${presetEditorMarkup()}
                ${sourcePickerMarkup()}
                <button id="cxi-generate" class="menu_button cxi-primary cxi-block">이미지 생성</button>
            </div>`;
        bindPresetEditor();
        bindSourcePicker();
        document.getElementById('cxi-generate')?.addEventListener('click', handleGenerate);
        return;
    }

    if (currentJob.status === 'running') {
        const phase = {
            extract: '최근 AI 응답 추출',
            refine: 'SillyTavern API 프로필로 장면 정리',
            generate: `${engineName()} 이미지 생성`,
        }[currentJob.phase] || '처리 중';
        content.innerHTML = `
            <div class="cxi-running">
                <div class="cxi-spinner"></div>
                <h3>${esc(phase)}</h3>
                <p id="cxi-elapsed" class="cxi-muted">${elapsedText(currentJob.startedAt)}</p>
                <p class="cxi-small">창을 닫아도 생성은 계속됩니다.</p>
                <button id="cxi-cancel" class="menu_button cxi-danger">취소</button>
            </div>`;
        document.getElementById('cxi-cancel').addEventListener('click', cancelGenerate);
        return;
    }

    if (currentJob.status === 'error') {
        content.innerHTML = `
            <div class="cxi-errorbox">
                <h3>생성 실패</h3>
                <pre>${esc(currentJob.error)}</pre>
                ${presetEditorMarkup()}
                <div class="cxi-actions">
                    <button id="cxi-retry" class="menu_button cxi-primary">다시 생성</button>
                    <button id="cxi-reset" class="menu_button">초기화</button>
                </div>
            </div>`;
        bindPresetEditor();
        document.getElementById('cxi-retry').addEventListener('click', handleGenerate);
        document.getElementById('cxi-reset').addEventListener('click', () => { currentJob = null; render(); });
        return;
    }

    content.innerHTML = `
        <div class="cxi-result">
            <img class="cxi-result-image" src="${esc(currentJob.imageUrl)}" data-cxi-src="${esc(currentJob.imageUrl)}" data-zoom="${esc(currentJob.imageUrl)}" alt="generated image" title="탭하면 크게 보기">
            <div class="cxi-result-meta">
                <span>${esc(modeName)}</span><span>${esc(presetName)}</span><span>${Math.round((currentJob.elapsedMs || 0) / 1000)}초</span>
            </div>
            ${currentJob.warning ? `<div class="cxi-warning">${esc(currentJob.warning)}</div>` : ''}
            <div class="cxi-actions">
                <button id="cxi-insert" class="menu_button cxi-primary">대화에 삽입</button>
                <button id="cxi-download" class="menu_button">PNG 저장</button>
                <button id="cxi-regenerate" class="menu_button">다시 생성</button>
            </div>
            ${presetEditorMarkup()}
            <details class="cxi-details"><summary>사용 프롬프트</summary><pre>${esc(currentJob.prompt || '')}</pre></details>
            ${currentJob.revisedPrompt ? `<details class="cxi-details"><summary>${engineName()} 응답 텍스트</summary><pre>${esc(currentJob.revisedPrompt)}</pre></details>` : ''}
        </div>`;
    bindPresetEditor();
    attachImageFallbacks(content);
    content.querySelectorAll('[data-zoom]').forEach(img => {
        img.addEventListener('click', () => openLightbox(img.getAttribute('data-zoom')));
    });
    document.getElementById('cxi-insert')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const { index } = await insertIntoChat(currentJob);
            toast('success', `#${index} \uba54\uc2dc\uc9c0\uc5d0 \uc0bd\uc785\ud588\uc2b5\ub2c8\ub2e4.`);
        } catch (error) {
            toast('error', error?.message || String(error));
        } finally {
            button.disabled = false;
        }
    });
    document.getElementById('cxi-download')?.addEventListener('click', () => downloadImage(currentJob.imageUrl));
    document.getElementById('cxi-regenerate').addEventListener('click', handleGenerate);
}

function elapsedText(startedAt) {
    return `${Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000))}초 경과`;
}

function startElapsedTimer() {
    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
        if (!panelOpen || activeView !== 'result' || currentJob?.status !== 'running') return;
        const el = document.getElementById('cxi-elapsed');
        if (el) el.textContent = elapsedText(currentJob.startedAt);
    }, 1000);
}

function stopElapsedTimer() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
}

function attachImageFallbacks(root) {
    root.querySelectorAll('img[data-cxi-src]').forEach(img => {
        img.addEventListener('error', () => {
            const note = document.createElement('div');
            note.className = 'cxi-img-missing';
            const src = img.getAttribute('data-cxi-src') || '';
            note.textContent = src.startsWith('data:')
                ? '\uc774\ubbf8\uc9c0\uac00 \uc11c\ubc84\uc5d0 \uc800\uc7a5\ub418\uc9c0 \uc54a\uc544 \uae30\ub85d\uc5d0\uc11c \uc0ac\ub77c\uc84c\uc2b5\ub2c8\ub2e4. (data URL)'
                : `\ubd88\ub7ec\uc62c \uc218 \uc5c6\uc74c: ${src.slice(0, 140) || '(src \uc5c6\uc74c)'}`;
            img.replaceWith(note);
        }, { once: true });
    });
}

function renderHistory() {
    const content = contentEl();
    const items = settings.history || [];
    content.innerHTML = `
        <div class="cxi-history-head">
            <b>최근 생성 ${items.length}/${HISTORY_MAX}</b>
            <div class="cxi-mini-actions">
                <button id="cxi-clear-history" class="menu_button">기록 삭제</button>
                <button id="cxi-purge-output" class="menu_button cxi-danger-soft">파일 비우기</button>
            </div>
        </div>
        <div class="cxi-history-list">
            ${items.length ? items.map((item, i) => {
                const alive = item.imageUrl && !item.unavailable;
                return `
                <article class="cxi-history-item">
                    <div class="cxi-history-thumb">
                        ${alive
                            ? `<img src="${esc(item.imageUrl)}" data-cxi-src="${esc(item.imageUrl)}" data-zoom="${esc(item.imageUrl)}" alt="생성 이미지">`
                            : '<div class="cxi-img-missing">이미지 없음</div>'}
                    </div>
                    <div class="cxi-history-body">
                        <div class="cxi-history-title">
                            <b>${esc(item.preset || '-')} · ${item.mode === 'solo' ? '1인샷' : '장면샷'}</b>
                            <button class="cxi-icon-btn cxi-hist-del" data-i="${i}" title="이 기록 삭제" aria-label="삭제">×</button>
                        </div>
                        <span class="cxi-history-meta">${new Date(item.t).toLocaleString()} · ${Number(item.sec || 0)}초</span>
                        ${alive ? `
                        <div class="cxi-history-actions">
                            <input class="cxi-hist-index" type="number" inputmode="numeric" min="0" step="1"
                                value="${Number.isInteger(item.targetIndex) ? item.targetIndex : ''}" placeholder="#" data-i="${i}">
                            <button class="menu_button cxi-hist-insert" data-i="${i}">삽입</button>
                            <button class="menu_button cxi-hist-pick" data-i="${i}">위치 선택</button>
                        </div>` : ''}
                        <details class="cxi-history-prompt"><summary>프롬프트</summary><pre>${esc(item.prompt || '')}</pre></details>
                    </div>
                </article>`;
            }).join('') : '<div class="cxi-empty-small">아직 생성 기록이 없습니다.</div>'}
        </div>`;

    content.querySelectorAll('[data-zoom]').forEach(img => {
        img.addEventListener('click', () => openLightbox(img.getAttribute('data-zoom')));
    });
    content.querySelectorAll('.cxi-hist-insert').forEach(button => {
        button.addEventListener('click', async () => {
            const i = Number(button.dataset.i);
            const item = (settings.history || [])[i];
            const input = content.querySelector(`.cxi-hist-index[data-i="${i}"]`);
            const raw = String(input?.value ?? '').trim();
            if (!item) return;
            if (!raw) { toast('error', '삽입할 메시지 번호를 입력하세요.'); return; }
            button.disabled = true;
            try {
                await insertHistoryItem(item, Math.trunc(Number(raw)));
            } catch (error) {
                toast('error', error?.message || String(error));
            } finally {
                button.disabled = false;
            }
        });
    });
    content.querySelectorAll('.cxi-hist-pick').forEach(button => {
        button.addEventListener('click', () => {
            const item = (settings.history || [])[Number(button.dataset.i)];
            if (item?.imageUrl) armInsert(item);
        });
    });
    content.querySelectorAll('.cxi-hist-del').forEach(button => {
        button.addEventListener('click', async () => {
            const i = Number(button.dataset.i);
            const item = (settings.history || [])[i];
            if (!item) return;
            button.disabled = true;
            try {
                const match = String(item.imageUrl || '').match(/\/image\/([^/?#]+)$/);
                if (match) {
                    await apiFetch('/delete-image', {
                        method: 'POST',
                        body: JSON.stringify({ name: decodeURIComponent(match[1]) }),
                    }).catch(() => {});
                }
                settings.history.splice(i, 1);
                await saveSettings();
                renderHistory();
            } catch (error) {
                toast('error', error?.message || String(error));
                button.disabled = false;
            }
        });
    });
    bindPresetEditor();
    attachImageFallbacks(content);

    document.getElementById('cxi-clear-history').addEventListener('click', async () => {
        settings.history = [];
        await saveSettings();
        renderHistory();
    });
    document.getElementById('cxi-purge-output').addEventListener('click', async () => {
        if (!confirm('서버에 저장된 생성 이미지를 모두 삭제할까요?')) return;
        try {
            const result = await apiFetch('/purge-output', { method: 'POST', body: '{}' });
            toast('success', `${result.deleted || 0}개 파일을 삭제했습니다.`);
        } catch (error) {
            toast('error', error.message);
        }
    });
}

function openLightbox(url) {
    if (!url) return;
    let box = document.getElementById('cxi-lightbox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'cxi-lightbox';
        box.className = 'cxi-lightbox';
        box.innerHTML = '<img alt="확대 보기"><button class="cxi-lightbox-close" aria-label="닫기">×</button>';
        box.addEventListener('click', () => box.classList.add('cxi-hidden'));
        document.body.appendChild(box);
        const fit = () => {
            if (box.classList.contains('cxi-hidden')) return;
            const vv = window.visualViewport;
            box.style.setProperty('position', 'fixed', 'important');
            box.style.setProperty('top', `${Math.round(vv?.offsetTop || 0)}px`, 'important');
            box.style.setProperty('left', `${Math.round(vv?.offsetLeft || 0)}px`, 'important');
            box.style.setProperty('width', `${Math.round(vv?.width || window.innerWidth)}px`, 'important');
            box.style.setProperty('height', `${Math.round(vv?.height || window.innerHeight)}px`, 'important');
        };
        box.dataset.hasFit = '1';
        window.visualViewport?.addEventListener('resize', fit);
        window.visualViewport?.addEventListener('scroll', fit);
        window.addEventListener('resize', fit);
        box._fit = fit;
    }
    box.querySelector('img').src = url;
    box.classList.remove('cxi-hidden');
    box._fit?.();
}

function statusMarkup() {
    if (!codexStatus) return '<span class="cxi-badge pending">확인 전</span>';
    if (codexStatus.engine === 'vertex') {
        return codexStatus.available
            ? `<span class="cxi-badge good">Vertex 연결됨</span><small>${esc(codexStatus.version || '')}</small>`
            : `<span class="cxi-badge bad">Vertex 연결 안 됨</span><small>${esc(codexStatus.error || '')}</small>`;
    }
    if (!codexStatus.available) return `<span class="cxi-badge bad">Codex CLI 없음</span><small>${esc(codexStatus.error || '')}</small>`;
    const loginOk = codexStatus.loggedInWithChatGPT === true;
    return `<span class="cxi-badge ${loginOk ? 'good' : 'warn'}">${loginOk ? 'ChatGPT OAuth 로그인됨' : 'ChatGPT OAuth 로그인 필요'}</span>
        <small>${esc(codexStatus.version || '')}${codexStatus.loginStatus ? ` · ${esc(codexStatus.loginStatus)}` : ''}</small>
        ${codexStatus.imageGenerationFeature ? `<small>${esc(codexStatus.imageGenerationFeature)}</small>` : ''}
        ${codexStatus.updateAvailable ? `<span class="cxi-badge warn">CLI 업데이트 있음 · 최신 ${esc(codexStatus.latestVersion)}</span>
        <small>서버 터미널에서 Codex CLI를 업데이트한 뒤 다시 확인하세요.</small>
        ${codexStatus.cliUpdateEnabled ? `<button id="cxi-update-cli" class="menu_button" type="button" title="npm install -g @openai/codex@latest">CLI 업데이트</button>` : ''}` : ''}`;
}

async function updateCodexCli(button) {
    if (!confirm(`Codex CLI를 최신 버전(${codexStatus?.latestVersion || '?'})으로 업데이트할까요?\n서버에서 npm install -g @openai/codex@latest 를 실행합니다. 1~2분 걸릴 수 있습니다.`)) return;
    button.disabled = true;
    button.textContent = '업데이트 중…';
    try {
        const result = await apiFetch('/update-cli', { method: 'POST', body: '{}' });
        codexStatus = result.status;
        toast('success', `${result.before} → ${result.after}`, 'Codex CLI 업데이트');
        await refreshCodexModels();
    } catch (error) {
        toast('error', error?.message || String(error), 'Codex CLI 업데이트 실패');
    }
    const el = document.getElementById('cxi-status-text');
    if (el) el.innerHTML = statusMarkup();
}

function updateCodexModelUi() {
    const select = document.getElementById('cxi-codex-model');
    const message = document.getElementById('cxi-codex-model-message');
    const refresh = document.getElementById('cxi-refresh-models');
    if (!select) return;
    const missing = settings.codexModel && !codexModels.some(item => item.model === settings.codexModel);
    select.innerHTML = '<option value="">모델을 선택하세요</option>'
        + (missing ? '<option value="' + esc(settings.codexModel) + '">' + esc(settings.codexModel) + ' (목록 확인 필요)</option>' : '')
        + codexModels.map(item => '<option value="' + esc(item.model) + '">' + esc(item.displayName || item.model) + ' · ' + esc(item.model) + (item.isDefault ? ' (기본)' : '') + '</option>').join('');
    select.value = settings.codexModel || '';
    select.disabled = Boolean(codexModelsLoading);
    select.classList.toggle('cxi-hidden', customCodexModel);
    const custom = document.getElementById('cxi-codex-model-custom');
    if (custom) { custom.classList.toggle('cxi-hidden', !customCodexModel); custom.value = settings.codexModel; }
    if (refresh) refresh.disabled = Boolean(codexModelsLoading);
    if (message) message.textContent = customCodexModel ? '터먹스 exec 모드: 비워 두면 Codex CLI 기본 모델을 사용합니다. 필요하면 모델 ID를 직접 입력하세요.' : codexModelsLoading ? '모델 목록을 조회하고 있습니다.' : codexModelsError || (missing && codexModelsLoaded ? '저장된 모델이 목록에 없습니다. 다른 모델을 선택하세요.' : '목록에 표시되어도 계정 사용 권한과 이미지 생성 지원 여부는 실제 요청에서 확인됩니다.');
}

async function refreshCodexModels() {
    if (codexModelsLoading) return await codexModelsLoading;
    codexModelsError = '';
    codexModelsLoading = (async () => {
        try {
            const result = await apiFetch('/models');
            if (!Array.isArray(result.models) || (!result.models.length && result.allowCustom !== true)) throw new Error('선택 가능한 Codex CLI 모델이 없습니다.');
            codexModels = result.models;
            customCodexModel = result.allowCustom === true;
            codexModelsLoaded = true;
        } catch (error) {
            codexModels = [];
            codexModelsLoaded = false;
            codexModelsError = error.message || String(error);
        }
    })();
    updateCodexModelUi();
    try { await codexModelsLoading; } finally {
        codexModelsLoading = null;
        updateCodexModelUi();
    }
}

function renderSettings() {
    const content = contentEl();
    if (!content) throw new Error('#cxi-content \uac00 \uc5c6\uc2b5\ub2c8\ub2e4.');
    const profiles = profileList;
    const refs = settings.refImages || {};
    content.innerHTML = `
        <section class="cxi-section cxi-status-row">
            <div><b>${settings.engine === 'vertex' ? 'Vertex 상태' : 'Codex CLI 상태'}</b><div id="cxi-status-text" class="cxi-status-text">${statusMarkup()}</div></div>
            <button id="cxi-refresh-status" class="menu_button">새로고침</button>
        </section>

        <section class="cxi-section">
            <h4 class="cxi-section-title">생성 설정</h4>
            <label>이미지 엔진
                <select id="cxi-engine">
                    <option value="codex" ${settings.engine !== 'vertex' ? 'selected' : ''}>Codex CLI (ChatGPT OAuth)</option>
                    <option value="vertex" ${settings.engine === 'vertex' ? 'selected' : ''}>Vertex AI (Express Key)</option>
                </select>
            </label>
            <div class="${settings.engine === 'vertex' ? 'cxi-hidden' : ''}">
                <label class="cxi-field-label" for="cxi-codex-model">Codex CLI 모델</label>
                <div class="cxi-preset-row">
                    <select id="cxi-codex-model"></select><input id="cxi-codex-model-custom" class="cxi-hidden" type="text" placeholder="Codex CLI 기본 모델 (선택 입력)" aria-label="Codex CLI 모델 ID">
                    <button id="cxi-refresh-models" class="menu_button" type="button" title="모델 목록 새로고침">새로고침</button>
                </div>
                <p id="cxi-codex-model-message" class="cxi-small cxi-muted"></p>
            </div>
            <div id="cxi-vertex-box" class="${settings.engine === 'vertex' ? '' : 'cxi-hidden'}">
                <label>Express API Key
                    <input id="cxi-vertex-key" type="password" value="${esc(settings.vertexApiKey || '')}" placeholder="AIza...">
                </label>
                <p class="cxi-small cxi-muted">Vertex Express 엔드포인트를 사용하므로 프로젝트 ID가 필요하지 않습니다.</p>
                <p class="cxi-small cxi-muted">모델: ${esc(settings.vertexModel || VERTEX_DEFAULT_MODEL)}${settings.vertexModel === VERTEX_PREVIEW_MODEL ? ' (preview로 자동 전환됨)' : ''}</p>
            </div>
            <label>샷 모드
                <select id="cxi-mode">
                    <option value="scene" ${settings.mode === 'scene' ? 'selected' : ''}>장면샷</option>
                    <option value="solo" ${settings.mode === 'solo' ? 'selected' : ''}>1인샷</option>
                </select>
            </label>
            <label>장면 정리
                <select id="cxi-refine-mode">
                    <option value="codex" ${settings.refineMode === 'codex' ? 'selected' : ''}>${engineName()} 내부 처리 (기본)</option>
                    <option value="profile" ${settings.refineMode === 'profile' ? 'selected' : ''}>SillyTavern API 프로필로 선처리</option>
                </select>
            </label>
            <div id="cxi-profile-wrap" class="${settings.refineMode === 'profile' ? '' : 'cxi-hidden'}">
                <label>Connection Profile
                    <select id="cxi-profile">
                        <option value="">프로필 선택</option>
                        ${profiles.map(p => `<option value="${esc(p.id)}" ${settings.connectionProfileId === p.id ? 'selected' : ''}>${esc(p.name || p.id)}${p.model ? ` · ${esc(p.model)}` : ''}</option>`).join('')}
                    </select>
                </label>
                <p class="cxi-small cxi-muted">현재 메인 채팅 프로필을 바꾸지 않고 이 요청만 선택한 Connection Profile로 보냅니다.</p>
            </div>
            <div class="cxi-grid2">
                <label>크기 선호
                    <select id="cxi-size">
                        ${['auto','1024x1024','1536x1024','1024x1536','2048x2048'].map(x => `<option value="${x}" ${settings.sizeHint === x ? 'selected' : ''}>${x}</option>`).join('')}
                    </select>
                </label>
                <label>품질 선호
                    <select id="cxi-quality">
                        ${['auto','low','medium','high'].map(x => `<option value="${x}" ${settings.qualityHint === x ? 'selected' : ''}>${x}</option>`).join('')}
                    </select>
                </label>
            </div>
            <label>대화 삽입 이미지 폭 (%)
                <input id="cxi-insert-width" type="number" min="10" max="100" step="5" value="${Math.max(10, Math.min(100, Number(settings.insertWidthPercent) || 70))}">
            </label>
            <p class="cxi-small cxi-muted">Codex CLI built-in 이미지 경로에서는 크기/품질이 auto로 처리될 수 있어 위 값은 우선 선호값으로 전달합니다.</p>
        </section>

        <details class="cxi-section" open>
            <summary><b>참조 이미지</b></summary>
            <label>캐릭터 / 페르소나 참고
                <select id="cxi-ref-source">
                    <option value="chat" ${settings.refSource === 'chat' ? 'selected' : ''}>대화방 프사 자동 사용</option>
                    <option value="upload" ${settings.refSource === 'upload' ? 'selected' : ''}>이미지 직접 첨부</option>
                    <option value="none" ${settings.refSource === 'none' ? 'selected' : ''}>사용 안 함</option>
                </select>
            </label>
            <div class="cxi-ref-grid">
                ${settings.refSource === 'upload' ? `${refCard('char', currentCharLabel() ? `캐릭터 · ${currentCharLabel()}` : '캐릭터', currentCharUpload())}${refCard('persona', '페르소나', refs.persona)}` : ''}
                ${refCard('style', '화풍', refs.style)}
            </div>
            <p class="cxi-small cxi-muted">${settings.refSource === 'chat'
                ? '대화방에 표시된 캐릭터·페르소나 프사를 자동으로 참고합니다.'
                : settings.refSource === 'upload'
                    ? '직접 첨부한 이미지만 참고합니다. 캐릭터 이미지는 캐릭터(그룹)별로 따로 저장되고, 페르소나·화풍 이미지는 공통입니다.'
                    : '캐릭터·페르소나 참고 없이 화풍만 사용합니다.'}
                캐릭터/페르소나는 얼굴·머리·정체성만, 화풍은 렌더링·팔레트만 참고하도록 ${engineName()}에 전달합니다.</p>
        </details>

        ${presetEditorMarkup()}

        <details class="cxi-section">
            <summary><b>API 프로필 장면 정리 지시문</b></summary>
            <textarea id="cxi-refine-prompt" rows="12">${esc(settings.refinePrompts[settings.mode] || '')}</textarea>
            <label>최대 출력 토큰 <input id="cxi-profile-tokens" type="number" min="128" max="2000" step="1" value="${Number(settings.profileMaxTokens || 700)}"></label>
        </details>

        <div class="cxi-settings-actions">
            <button id="cxi-save-settings" class="menu_button cxi-primary">설정 저장</button>
        </div>`;

    updateCodexModelUi();
    document.getElementById('cxi-codex-model-custom')?.addEventListener('change', async event => { settings.codexModel = event.target.value.trim(); await saveSettings(); });
    document.getElementById('cxi-codex-model')?.addEventListener('change', async event => {
        settings.codexModel = event.target.value;
        await saveSettings();
        updateCodexModelUi();
    });
    document.getElementById('cxi-refresh-models')?.addEventListener('click', () => refreshCodexModels());
    if (settings.engine !== 'vertex' && !codexModelsLoaded && !codexModelsError) refreshCodexModels();

    document.getElementById('cxi-ref-source')?.addEventListener('change', async event => {
        captureSettingsDraft();
        settings.refSource = event.target.value;
        await saveSettings();
        renderSettings();
    });
    document.getElementById('cxi-engine')?.addEventListener('change', async event => {
        captureSettingsDraft();
        settings.engine = event.target.value === 'vertex' ? 'vertex' : 'codex';
        codexStatus = null;
        await saveSettings();
        renderSettings();
    });
    document.getElementById('cxi-refresh-status').addEventListener('click', () => {
        saveSettingsFromUi().then(() => (settings.engine === 'vertex' ? refreshVertexStatus() : refreshCodexStatus(true)));
    });
    document.getElementById('cxi-mode').addEventListener('change', async event => {
        captureSettingsDraft();
        settings.mode = event.target.value;
        await saveSettings();
        renderSettings();
    });
    document.getElementById('cxi-refine-mode').addEventListener('change', event => {
        document.getElementById('cxi-profile-wrap').classList.toggle('cxi-hidden', event.target.value !== 'profile');
    });
    bindPresetEditor();
    document.querySelectorAll('[data-cxi-ref-upload]').forEach(input => input.addEventListener('change', handleRefUpload));
    document.querySelectorAll('[data-cxi-ref-clear]').forEach(btn => btn.addEventListener('click', async () => {
        const slot = btn.dataset.cxiRefClear;
        if (slot === 'char') delete settings.charRefs[currentCharKey()];
        else settings.refImages[slot] = '';
        await saveSettings();
        renderSettings();
    }));
    document.getElementById('cxi-save-settings').addEventListener('click', saveSettingsFromUi);
}

function refCard(slot, label, src) {
    return `<div class="cxi-ref-card">
        <div class="cxi-ref-preview">${src ? `<img src="${esc(src)}" alt="${esc(label)} reference">` : '<span>＋</span>'}</div>
        <b>${esc(label)}</b>
        <label class="menu_button cxi-file-btn">선택<input type="file" accept="image/png,image/jpeg,image/webp" data-cxi-ref-upload="${slot}"></label>
        ${src ? `<button class="menu_button cxi-danger-soft" data-cxi-ref-clear="${slot}">제거</button>` : ''}
    </div>`;
}

async function saveSettingsFromUi() {
    captureSettingsDraft();
    await saveSettings();
    toast('success', '설정을 저장했습니다.');
    renderSettings();
}

function captureSettingsDraft() {
    if (!document.getElementById('cxi-mode')) return;
    const mode = document.getElementById('cxi-mode').value;
    settings.refinePrompts[settings.mode] = document.getElementById('cxi-refine-prompt').value;
    settings.mode = mode;
    settings.refineMode = document.getElementById('cxi-refine-mode').value;
    settings.connectionProfileId = document.getElementById('cxi-profile')?.value || '';
    settings.sizeHint = document.getElementById('cxi-size').value;
    settings.qualityHint = document.getElementById('cxi-quality').value;
    settings.engine = document.getElementById('cxi-engine')?.value === 'vertex' ? 'vertex' : 'codex';
    settings.codexModel = document.getElementById(customCodexModel ? 'cxi-codex-model-custom' : 'cxi-codex-model')?.value.trim() || '';
    settings.refSource = document.getElementById('cxi-ref-source')?.value || 'chat';
    settings.vertexApiKey = String(document.getElementById('cxi-vertex-key')?.value || '').trim();

    settings.insertWidthPercent = Math.max(10, Math.min(100, Number(document.getElementById('cxi-insert-width')?.value) || 70));
    settings.profileMaxTokens = Math.max(128, Math.min(2000, Number(document.getElementById('cxi-profile-tokens').value) || 700));
}

async function refreshVertexStatus() {
    const model = settings.vertexModel || VERTEX_DEFAULT_MODEL;
    if (!String(settings.vertexApiKey || '').trim()) {
        codexStatus = { engine: 'vertex', available: false, error: 'Express API Key\ub97c \uc785\ub825\ud558\uc138\uc694.' };
        renderSettings();
        return codexStatus;
    }

    const probe = async name => {
        const response = await fetch(vertexEndpoint(name, 'countTokens'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'connection test' }] }] }),
        });
        return { response, data: await response.json().catch(() => ({})), model: name };
    };

    try {
        let result = await probe(model);
        if (!result.response.ok && result.response.status === 404 && model === 'gemini-3.1-flash-image') {
            result = await probe('gemini-3.1-flash-image-preview');
            if (result.response.ok) {
                settings.vertexModel = VERTEX_PREVIEW_MODEL;
                await saveSettings();
            }
        }
        codexStatus = result.response.ok
            ? { engine: 'vertex', available: true, version: `${result.model} \u00b7 Express` }
            : { engine: 'vertex', available: false, error: result.data?.error?.message || `HTTP ${result.response.status}` };
    } catch (error) {
        codexStatus = { engine: 'vertex', available: false, error: error?.message || String(error) };
    }
    renderSettings();
    return codexStatus;
}

async function refreshCodexStatus(force = false) {
    if ((settings.engine || 'codex') === 'vertex') return await refreshVertexStatus();
    try {
        codexStatus = await apiFetch(`/status${force ? '?refresh=1' : ''}`);
    } catch (error) {
        codexStatus = { available: false, error: error.message };
    }
    if (panelOpen && activeView === 'settings') {
        const el = document.getElementById('cxi-status-text');
        if (el) el.innerHTML = statusMarkup();
    }
    return codexStatus;
}

async function getConnectionManagerService() {
    if (connectionManagerService) return connectionManagerService;
    if (connectionManagerLoadError) return null;
    try {
        const mod = await import('../../shared.js');
        if (typeof mod.ConnectionManagerRequestService !== 'function') {
            throw new Error('ConnectionManagerRequestService export is not available in this SillyTavern build.');
        }
        connectionManagerService = mod.ConnectionManagerRequestService;
        return connectionManagerService;
    } catch (error) {
        connectionManagerLoadError = error;
        console.info('[Chatelier] SillyTavern Connection Profile integration unavailable:', error?.message || error);
        return null;
    }
}

async function refreshProfiles() {
    const service = await getConnectionManagerService();
    if (!service) {
        profileList = [];
        return;
    }
    try {
        profileList = service.getSupportedProfiles() || [];
    } catch (error) {
        profileList = [];
        console.info('[Chatelier] Connection Manager profiles unavailable:', error.message);
    }
}

function getLastAiMessage() {
    const ctx = getContext();
    const chat = ctx.chat || SillyTavern.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message) continue;
        const isUser = message.is_user === true || message.role === 'user';
        if (isUser) continue;
        const text = String(message.mes ?? message.content ?? message.data ?? '').trim();
        if (text) return text;
    }
    throw new Error('최근 AI 응답을 찾지 못했습니다.');
}

const MES_PROXY_CLASS = 'cxi-mes-proxy';

function allMessageElements() {
    const root = document.querySelector('#chat') || document;
    return [...root.querySelectorAll('.mes')].filter(el => el instanceof HTMLElement);
}

function messageIndexFromElement(el) {
    if (!el) return -1;
    for (const attr of ['mesid', 'data-mesid', 'data-message-id']) {
        const raw = el.getAttribute(attr);
        if (raw !== null && /^\d+$/.test(raw)) return Number(raw);
    }
    return allMessageElements().indexOf(el);
}

function clearMessageHighlights() {
    document.querySelectorAll('.mes.cxi-range-start').forEach(el => el.classList.remove('cxi-range-start'));
}

function panelIsInlineVisible() {
    const wrap = document.getElementById('cxi-inline-wrap');
    return !!wrap && !wrap.classList.contains('cxi-hidden');
}

async function generateFromRange(lo, hi) {
    settings.sourceMode = 'range';
    settings.rangeStart = lo;
    settings.rangeEnd = hi;
    await saveSettings();
    if (panelIsInlineVisible()) {
        inlineMode = true;
    } else {
        inlineMode = false;
        openPanel('result');
    }
    await handleGenerate();
}

function makeProxyButton(messageEl, kind, title, iconText) {
    let button = messageEl.querySelector(`.${MES_PROXY_CLASS}[data-cxi-action="${kind}"]`);
    if (button instanceof HTMLElement) return button;

    const container = messageEl.querySelector('.mes_buttons');
    if (!(container instanceof HTMLElement)) return null;

    button = document.createElement('div');
    button.className = `mes_button ${MES_PROXY_CLASS} interactable`;
    const icon = document.createElement('span');
    // RCMM renders .cat-emoji-icon children as text icons in its mobile menu.
    icon.className = 'cat-emoji-icon';
    icon.textContent = iconText;
    button.appendChild(icon);
    button.dataset.cxiAction = kind;
    button.setAttribute('role', 'button');
    button.tabIndex = -1;
    container.appendChild(button);

    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const mes = button.closest('.mes');
        if (!(mes instanceof HTMLElement)) return;
        const index = messageIndexFromElement(mes);
        if (index < 0) { toast('error', '\uba54\uc2dc\uc9c0 \ubc88\ud638\ub97c \uc77d\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4.'); return; }

        try {
            if (kind === 'one') {
                pendingRangeStart = null;
                clearMessageHighlights();
                await generateFromRange(index, index);
                return;
            }
            if (kind === 'range') {
                if (pendingRangeStart === null) {
                    pendingRangeStart = index;
                    clearMessageHighlights();
                    mes.classList.add('cxi-range-start');
                    toast('success', `#${index} \uc744(\ub97c) \uad6c\uac04 \uc2dc\uc791\uc73c\ub85c \uc9c0\uc815\ud588\uc2b5\ub2c8\ub2e4. \ub05d \uba54\uc2dc\uc9c0\uc5d0\uc11c \ub2e4\uc2dc \ub204\ub974\uc138\uc694.`);
                    updateAllMessageButtons();
                    return;
                }
                const lo = Math.min(pendingRangeStart, index);
                const hi = Math.max(pendingRangeStart, index);
                pendingRangeStart = null;
                clearMessageHighlights();
                updateAllMessageButtons();
                await generateFromRange(lo, hi);
                return;
            }
            if (kind === 'insert') {
                if (!pendingInsert) { toast('error', '\uc0bd\uc785 \ub300\uae30 \uc911\uc778 \uc774\ubbf8\uc9c0\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.'); return; }
                const item = pendingInsert;
                pendingInsert = null;
                updateAllMessageButtons();
                await insertHistoryItem(item, index);
                return;
            }
            if (kind === 'cancel') {
                pendingRangeStart = null;
                clearMessageHighlights();
                cancelPendingInsert(true);
                updateAllMessageButtons();
                toast('success', '\uad6c\uac04 / \uc0bd\uc785 \ub300\uae30\ub97c \ucde8\uc18c\ud588\uc2b5\ub2c8\ub2e4.');
            }
        } catch (error) {
            toast('error', error?.message || String(error));
        }
    });

    return button;
}

function closeAllUi() {
    try {
        closePanel();
        document.getElementById('cxi-inline-wrap')?.classList.add('cxi-hidden');
        panelOpen = false;
        stopElapsedTimer();
        // Collapse whichever ST nav drawer is currently open so the chat is visible.
        document.querySelectorAll('.drawer-content.openDrawer').forEach(panel => {
            const toggle = panel.parentElement?.querySelector('.drawer-toggle .drawer-icon, .drawer-toggle');
            if (toggle instanceof HTMLElement) toggle.click();
        });
    } catch (error) {
        console.info('[Chatelier] closeAllUi', error?.message || error);
    }
}

function armInsert(item) {
    pendingInsert = { imageUrl: item.imageUrl, chatKey: currentChatKey() };
    updateAllMessageButtons();
    closeAllUi();
    toast('success', '\uc0bd\uc785\ud560 \uba54\uc2dc\uc9c0\uc758 \uba54\ub274\uc5d0\uc11c \u{1F4E5} \uc5ec\uae30\uc5d0 \uc774\ubbf8\uc9c0 \uc0bd\uc785 \uc744 \ub204\ub974\uc138\uc694.');
}

function cancelPendingInsert(silent = false) {
    if (!pendingInsert) return;
    pendingInsert = null;
    updateAllMessageButtons();
    if (!silent) toast('success', '\uc0bd\uc785 \ub300\uae30\ub97c \ucde8\uc18c\ud588\uc2b5\ub2c8\ub2e4.');
}

async function insertHistoryItem(item, index) {
    const result = await insertIntoChat({ imageUrl: item.imageUrl, targetIndex: index, chatKey: item.chatKey || currentChatKey() });
    toast('success', `#${result.index} \uba54\uc2dc\uc9c0\uc5d0 \uc0bd\uc785\ud588\uc2b5\ub2c8\ub2e4.`);
    return result;
}

function ensureMessageButtons(messageEl) {
    if (!(messageEl instanceof HTMLElement)) return;
    if (!messageEl.querySelector('.mes_buttons')) return;

    makeProxyButton(messageEl, 'one', 'Codex CLI \u00b7 \uc774 \uba54\uc2dc\uc9c0\ub85c \uc774\ubbf8\uc9c0 \uc0dd\uc131', '\u{1F3A8}');
    const rangeTitle = pendingRangeStart === null ? 'Codex CLI \u00b7 \uad6c\uac04 \uc2dc\uc791' : 'Codex CLI \u00b7 \uc5ec\uae30\uae4c\uc9c0 \uc0dd\uc131';
    const range = makeProxyButton(messageEl, 'range', rangeTitle, '\u{1F3A8}\u2194');
    if (range) {
        range.title = rangeTitle;
        range.setAttribute('data-sttt--title', rangeTitle);
    }
    const insert = makeProxyButton(messageEl, 'insert', 'Codex CLI \u00b7 \uc5ec\uae30\uc5d0 \uc774\ubbf8\uc9c0 \uc0bd\uc785', '\u{1F4E5}');
    insert?.classList.toggle('cxi-inactive', pendingInsert === null);

    const cancel = makeProxyButton(messageEl, 'cancel', 'Codex CLI \u00b7 \uad6c\uac04 / \uc0bd\uc785 \ucde8\uc18c', '\u00d7');
    cancel?.classList.toggle('cxi-inactive', pendingRangeStart === null && pendingInsert === null);
}

function updateAllMessageButtons() {
    for (const messageEl of allMessageElements()) ensureMessageButtons(messageEl);
}

function installMessageObserver() {
    messageObserver?.disconnect?.();
    const chat = document.querySelector('#chat') || document.body;
    if (!chat) return;
    messageObserver = new MutationObserver(mutations => {
        let needsUpdate = false;
        for (const mutation of mutations) {
            if (mutation.type !== 'childList') continue;
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches?.('.mes') || node.querySelector?.('.mes') || node.matches?.('.mes_buttons') || node.querySelector?.('.mes_buttons')) {
                    needsUpdate = true;
                    break;
                }
            }
            if (needsUpdate) break;
        }
        if (needsUpdate) queueMicrotask(updateAllMessageButtons);
    });
    messageObserver.observe(chat, { childList: true, subtree: true });
    updateAllMessageButtons();
}

function getChat() {
    try {
        const ctx = getContext();
        const chat = ctx.chat || globalThis.SillyTavern?.chat || [];
        return Array.isArray(chat) ? chat : [];
    } catch (_) {
        return [];
    }
}

function messageText(message) {
    if (!message) return '';
    return String(message.mes ?? message.content ?? message.data ?? '').trim();
}

function isUserMessage(message) {
    return message?.is_user === true || message?.role === 'user';
}

function clampIndex(value) {
    const chat = getChat();
    if (!chat.length) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(chat.length - 1, Math.trunc(n)));
}

function resolvedRange() {
    const chat = getChat();
    if (!chat.length) return null;
    const rawStart = settings.rangeStart;
    const rawEnd = settings.rangeEnd;
    if (rawStart === null && rawEnd === null) return null;
    const a = clampIndex(rawStart ?? rawEnd);
    const b = clampIndex(rawEnd ?? rawStart);
    if (a === null || b === null) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

function resolveSceneRaw() {
    if ((settings.sourceMode || 'last') !== 'range') return getLastAiMessage();

    const chat = getChat();
    const range = resolvedRange();
    if (!range) throw new Error('\uad6c\uac04 \ubc88\ud638\ub97c \uc785\ub825\ud558\uc138\uc694. \uc608: 12 ~ 15');

    const parts = [];
    for (let i = range.lo; i <= range.hi; i++) {
        const text = messageText(chat[i]);
        if (text) parts.push(text);
    }
    if (!parts.length) throw new Error(`#${range.lo} ~ #${range.hi} \uad6c\uac04\uc5d0 \ud14d\uc2a4\ud2b8\uac00 \uc5c6\uc2b5\ub2c8\ub2e4.`);
    return parts.join('\n\n');
}

function sourceSummary() {
    if ((settings.sourceMode || 'last') !== 'range') return '\ucd5c\uadfc AI \uc751\ub2f5';
    const range = resolvedRange();
    if (!range) return '\uad6c\uac04 \ubbf8\uc9c0\uc815';
    const count = range.hi - range.lo + 1;
    return range.lo === range.hi ? `#${range.lo}` : `#${range.lo} ~ #${range.hi} (${count}\uac1c)`;
}

function cleanScene(raw) {
    const div = document.createElement('div');
    div.innerHTML = String(raw || '');
    const text = div.textContent || div.innerText || '';
    return text.replace(/[*_`>#~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
}

function lastAiIndex() {
    const chat = getChat();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isUserMessage(chat[i]) && messageText(chat[i])) return i;
    }
    return chat.length ? chat.length - 1 : -1;
}

function targetMessageIndex() {
    if ((settings.sourceMode || 'last') === 'range') {
        const range = resolvedRange();
        if (range) return range.hi;
    }
    return lastAiIndex();
}

function messageElementByIndex(index) {
    return document.querySelector(`#chat .mes[mesid="${index}"]`)
        || document.querySelector(`#chat .mes[data-mesid="${index}"]`)
        || null;
}

function avatarUrlFromDom(wantUser) {
    const chat = getChat();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isUserMessage(chat[i]) !== wantUser) continue;
        const el = messageElementByIndex(i);
        const img = el?.querySelector('.avatar img, .avatar_collage img');
        const src = img?.getAttribute('src');
        if (src) return src;
    }
    return '';
}

function avatarUrlFromContext(wantUser) {
    try {
        const ctx = getContext();
        if (wantUser) return '';
        const character = ctx.characters?.[ctx.characterId];
        if (character?.avatar && typeof ctx.getThumbnailUrl === 'function') {
            return ctx.getThumbnailUrl('avatar', character.avatar);
        }
    } catch (_) { /* ignore */ }
    return '';
}

async function urlToDataUrl(url) {
    const response = await fetch(url, { headers: {} });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('avatar read failed'));
        reader.readAsDataURL(blob);
    });
}

async function autoAvatarDataUrl(wantUser) {
    const url = avatarUrlFromDom(wantUser) || avatarUrlFromContext(wantUser);
    if (!url) return '';
    try {
        const dataUrl = await urlToDataUrl(url);
        return dataUrl.startsWith('data:image/') ? dataUrl : '';
    } catch (error) {
        console.info('[Chatelier] avatar fetch failed', url, error?.message || error);
        return '';
    }
}

async function collectRefsAsync() {
    const source = settings.refSource || 'chat';
    if (source === 'none') return collectRefs(false);
    if (source === 'upload') return collectRefs(true).slice(0, 3);

    // 'chat': chat avatars only; previously uploaded char/persona images must not leak in.
    const avatars = (await Promise.all([
        autoAvatarDataUrl(false).then(d => d && { slot: 'char', dataUrl: d }),
        autoAvatarDataUrl(true).then(d => d && { slot: 'persona', dataUrl: d }),
    ])).filter(Boolean);
    return [...avatars, ...collectRefs(false)].slice(0, 3);
}

function findInfoBlockOffset(text) {
    const patterns = [
        /<Info_?block\b/i,
        /<Info_panel\b/i,
        /<InfoBox\b/i,
        /<div[^>]*class=["'][^"']*(custom-info-card|info_panel|infobox)[^"']*["']/i,
        /\n\s*\[\s*Date\s*:/i,
        /```\s*Info(?:Box|_?block|_panel)?\s*\n/i,
    ];
    let offset = -1;
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && typeof match.index === 'number') {
            if (offset === -1 || match.index < offset) offset = match.index;
        }
    }
    return offset;
}

function imageBlockHtml(path) {
    const width = Math.max(10, Math.min(100, Number(settings.insertWidthPercent) || 70));
    return [
        '<div style="text-align: center; margin: 16px auto;">',
        `  <img src="${path}" style="width: ${width}%; max-width: 100%; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);" />`,
        '</div>',
    ].join('\n');
}

async function uploadToUserImages(imageUrl) {
    const dataUrl = await urlToDataUrl(imageUrl);
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/i, '');
    if (!base64) throw new Error('\uc774\ubbf8\uc9c0 \ub370\uc774\ud130\ub97c \uc77d\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4.');

    const ctx = getContext();
    const chName = ctx.characters?.[ctx.characterId]?.name || ctx.name2 || 'codex-image';
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            image: base64,
            format: 'png',
            filename: `codex-${Date.now()}`,
            ch_name: chName,
        }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.path) throw new Error(json.error || `\uc5c5\ub85c\ub4dc \uc2e4\ud328 (${response.status})`);
    return json.path;
}

function currentChatKey() {
    try {
        const ctx = getContext();
        return JSON.stringify({
            chatId: ctx.chatId ?? null,
            characterId: ctx.characterId ?? null,
            groupId: ctx.groupId ?? null,
        });
    } catch (_) {
        return '';
    }
}

function snapshotOf(index) {
    const chat = getChat();
    if (!Number.isInteger(index) || index < 0 || !chat[index]) return '';
    return String(chat[index].mes ?? '').slice(0, 200);
}

async function insertIntoChat(job) {
    const index = Number.isInteger(job?.targetIndex) ? job.targetIndex : targetMessageIndex();
    const ctx = getContext();
    const chat = getChat();

    // Guard rails: never write into a chat other than the one this image came from.
    if (!chat.length) throw new Error('\ud604\uc7ac \ucc44\ud305\uc774 \ube44\uc5b4 \uc788\uc5b4 \uc0bd\uc785\uc744 \uc911\ub2e8\ud588\uc2b5\ub2c8\ub2e4.');
    if (job?.chatKey && job.chatKey !== currentChatKey()) {
        throw new Error('\uc774\ubbf8\uc9c0\ub97c \ub9cc\ub4e0 \ucc44\ud305\uacfc \ud604\uc7ac \ucc44\ud305\uc774 \ub2e4\ub985\ub2c8\ub2e4. \uc6d0\ub798 \ucc44\ud305\uc73c\ub85c \ub3cc\uc544\uac04 \ub4a4 \ub2e4\uc2dc \uc2dc\ub3c4\ud558\uc138\uc694.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= chat.length || !chat[index]) {
        throw new Error(`\uc0bd\uc785\ud560 \uba54\uc2dc\uc9c0(#${index})\ub97c \ucc3e\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4.`);
    }
    if (job?.targetSnapshot && snapshotOf(index) !== job.targetSnapshot) {
        throw new Error(`#${index} \uba54\uc2dc\uc9c0 \ub0b4\uc6a9\uc774 \uc0dd\uc131 \uc2dc\uc810\uacfc \ub2ec\ub77c\uc84c\uc2b5\ub2c8\ub2e4. \uc548\uc804\uc744 \uc704\ud574 \uc0bd\uc785\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.`);
    }

    const path = await uploadToUserImages(job.imageUrl);
    const block = imageBlockHtml(path);
    const original = String(chat[index].mes ?? '');
    const offset = findInfoBlockOffset(original);

    chat[index].mes = offset === -1
        ? `${original.trimEnd()}\n\n${block}\n`
        : `${original.slice(0, offset).trimEnd()}\n\n${block}\n\n${original.slice(offset).trimStart()}`;

    if (!chat[index].mes || chat[index].mes.length <= original.length) {
        chat[index].mes = original;
        throw new Error('\uc0bd\uc785 \uacb0\uacfc\uac00 \ube44\uc815\uc0c1\uc774\ub77c \ub418\ub3cc\ub838\uc2b5\ub2c8\ub2e4. \ucc44\ud305\uc740 \uc800\uc7a5\ud558\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.');
    }

    try {
        if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, chat[index]);
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
    } catch (error) {
        chat[index].mes = original;
        throw new Error(`\ucc44\ud305 \uc800\uc7a5\uc5d0 \uc2e4\ud328\ud574 \uc6d0\ub798 \ub0b4\uc6a9\uc73c\ub85c \ub418\ub3cc\ub838\uc2b5\ub2c8\ub2e4: ${error?.message || error}`);
    }
    return { index, path };
}

function isDataImage(value) {
    return typeof value === 'string' && value.startsWith('data:image/');
}

// Key for the per-character upload slot. Groups share one slot per group.
function currentCharKey() {
    try {
        const ctx = getContext();
        if (ctx.groupId) return `group:${ctx.groupId}`;
        const avatar = ctx.characters?.[ctx.characterId]?.avatar;
        return avatar ? `char:${avatar}` : '';
    } catch (_) {
        return '';
    }
}

function currentCharLabel() {
    try {
        const ctx = getContext();
        if (ctx.groupId) return ctx.groups?.find(g => g.id === ctx.groupId)?.name || '그룹';
        return ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '';
    } catch (_) {
        return '';
    }
}

function currentCharUpload() {
    const key = currentCharKey();
    const value = key ? settings.charRefs?.[key] : '';
    return isDataImage(value) ? value : '';
}

// Uploaded refs. Character/persona are only included when includePeople is set;
// the style ref is always included.
function collectRefs(includePeople = true) {
    const refs = settings.refImages || {};
    const out = [];
    if (includePeople) {
        const charImage = currentCharUpload();
        if (charImage) out.push({ slot: 'char', dataUrl: charImage });
        if (isDataImage(refs.persona)) out.push({ slot: 'persona', dataUrl: refs.persona });
    }
    if (isDataImage(refs.style)) out.push({ slot: 'style', dataUrl: refs.style });
    return out;
}

async function refineWithProfile(scene, signal) {
    if (!settings.connectionProfileId) throw new Error('설정에서 사용할 SillyTavern Connection Profile을 선택하세요.');
    let template = settings.refinePrompts?.[settings.mode] || REFINE_SCENE;
    let prompt = template.replaceAll('{scene}', scene);
    const refSource = settings.refSource || 'chat';
    const hasPersonRef = refSource === 'chat'
        || (refSource === 'upload' && collectRefs(true).some(r => r.slot === 'char' || r.slot === 'persona'));
    if (hasPersonRef) {
        prompt += '\n\nReference photos will be supplied separately. In char:, output only character count/gender/solo tags; do not describe face, hair, eyes, or other identity features. Outfit, pose, expression and background must still come from the scene.';
    }
    const service = await getConnectionManagerService();
    if (!service) {
        throw new Error('이 SillyTavern 버전에서는 Connection Profile 요청 API를 찾지 못했습니다. 장면 정리를 Codex CLI로 설정하세요.');
    }
    const result = await service.sendRequest(
        settings.connectionProfileId,
        prompt,
        settings.profileMaxTokens || 700,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
    );
    const text = String(result?.content ?? '');
    const parts = parseParts(text);
    if (!parts.bg && !parts.char && !parts.outfit && !parts.comp) {
        throw new Error(`API 프로필 장면 정리 결과를 해석하지 못했습니다.\n${text.slice(0, 500)}`);
    }
    return parts;
}

function parseParts(text) {
    const grab = key => {
        const match = String(text || '').match(new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+)$`, 'im'));
        return match ? match[1].trim().replace(/^[\[<]+|[\]>]+$/g, '').trim() : '';
    };
    return { bg: grab('bg'), char: grab('char'), outfit: grab('outfit'), comp: grab('comp') };
}

function buildPrompt(rawScene, parts) {
    return buildVisualPrompt(settings.presets[settings.activePreset]?.body, rawScene, parts);
}

function engineName() {
    return (settings?.engine || 'codex') === 'vertex' ? 'Vertex' : 'Codex CLI';
}

function vertexEndpoint(model, method = 'generateContent') {
    const key = encodeURIComponent(String(settings.vertexApiKey || '').trim());
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:${method}?key=${key}`;
}

function vertexImageConfig(model) {
    const config = {};
    const warnings = [];
    const ratio = {
        square: '1:1',
        portrait: '3:4',
        landscape: '4:3',
        '1024x1024': '1:1',
        '2048x2048': '1:1',
        '1536x1024': '4:3',
        '1024x1536': '3:4',
    }[settings.sizeHint];
    if (ratio) config.aspectRatio = ratio;

    const requested = settings.qualityHint;
    if (requested && requested !== 'auto') {
        const imageSize = { low: '1K', medium: '2K', high: '4K' }[requested] || requested;
        if (model === 'gemini-3.1-flash-lite-image') {
            config.imageSize = '1K';
            if (imageSize !== '1K') warnings.push(`${model}\ub294 1K\ub9cc \uc9c0\uc6d0\ud558\uc5ec 1K\ub85c \uc694\uccad\ud569\ub2c8\ub2e4.`);
        } else if (model === 'gemini-2.5-flash-image') {
            warnings.push(`${model}\uc5d0\uc11c\ub294 \ud574\uc0c1\ub3c4 \uc635\uc158\uc744 \ubcf4\ub0b4\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.`);
        } else {
            config.imageSize = imageSize;
        }
    }
    return { config, warnings };
}

async function vertexCall(model, parts, generationConfig, signal) {
    const response = await fetch(vertexEndpoint(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        signal,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data, model };
}

async function storeImage(dataUrl) {
    try {
        const stored = await apiFetch('/store', { method: 'POST', body: JSON.stringify({ dataUrl }) });
        if (stored?.imageUrl) return stored.imageUrl;
        throw new Error('imageUrl \uc751\ub2f5\uc774 \ube44\uc5b4 \uc788\uc2b5\ub2c8\ub2e4.');
    } catch (error) {
        toast('error', `\uc774\ubbf8\uc9c0\ub97c \uc11c\ubc84\uc5d0 \uc800\uc7a5\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4(\uae30\ub85d \ubcf4\uad00 \ubd88\uac00). SillyTavern \uc11c\ubc84\ub97c \uc7ac\uc2dc\uc791\ud558\uc138\uc694. \u00b7 ${error?.message || error}`);
        return dataUrl;
    }
}

async function generateWithVertex(prompt, refs, signal) {
    if (!String(settings.vertexApiKey || '').trim()) throw new Error('Vertex Express API Key\ub97c \uc785\ub825\ud558\uc138\uc694.');

    const startedAt = Date.now();
    const parts = [];
    for (const ref of refs) {
        const match = String(ref.dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
        if (!match) continue;
        parts.push({ text: VERTEX_REF_LABELS[ref.slot] || 'Reference image.' });
        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    const hasStyleRef = refs.some(ref => ref.slot === 'style');
    const globalStylePriority = hasStyleRef
        ? 'GLOBAL STYLE PRIORITY: Render 100% of the canvas in the STYLE reference\'s visual language. Do not apply it selectively only to a character\'s face or hair. The background and all non-character elements must visibly share the same linework, coloring, shading, lighting, texture, atmosphere, and webtoon/comic finish. Preserve identities only from CHARACTER/PERSONA references; never import a person\'s identity or appearance from the STYLE reference.'
        : '';
    parts.push({ text: [
        'Create one final image that follows the scene instructions below. Use every supplied reference image only for its labeled purpose. Do not add unrelated people or objects.',
        globalStylePriority,
        prompt,
    ].filter(Boolean).join('\n\n') });

    const selected = settings.vertexModel || VERTEX_DEFAULT_MODEL;
    const { config, warnings } = vertexImageConfig(selected);
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    if (Object.keys(config).length) generationConfig.imageConfig = config;

    let result = await vertexCall(selected, parts, generationConfig, signal);
    if (!result.response.ok && result.response.status === 404 && selected === VERTEX_DEFAULT_MODEL) {
        warnings.push('Gemini 3.1 Flash Image 404 \u2192 Preview \ubaa8\ub378\ub85c \uc790\ub3d9 \uc7ac\uc2dc\ub3c4\ud588\uc2b5\ub2c8\ub2e4.');
        result = await vertexCall(VERTEX_PREVIEW_MODEL, parts, generationConfig, signal);
        if (result.response.ok) {
            settings.vertexModel = 'gemini-3.1-flash-image-preview';
            await saveSettings();
        }
    }
    if (!result.response.ok) {
        throw new Error(result.data?.error?.message || `Vertex HTTP ${result.response.status}`);
    }

    const outParts = result.data?.candidates?.[0]?.content?.parts || [];
    const imagePart = outParts.find(part => part?.inlineData?.data);
    const textOut = outParts.filter(part => part?.text).map(part => part.text).join('\n').trim();
    if (!imagePart) throw new Error(`\uc774\ubbf8\uc9c0 \ub370\uc774\ud130\uac00 \ubc18\ud658\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4.${textOut ? `\n\n${textOut}` : ''}`);

    const mime = imagePart.inlineData.mimeType || 'image/png';
    const imageUrl = await storeImage(`data:${mime};base64,${imagePart.inlineData.data}`);
    return {
        imageUrl,
        elapsedMs: Date.now() - startedAt,
        revisedPrompt: textOut,
        warning: warnings.join('\n'),
        engine: `Vertex \u00b7 ${result.model}`,
    };
}

async function runEngine(prompt, refs, signal) {
    if ((settings.engine || 'codex') === 'vertex') return await generateWithVertex(prompt, refs, signal);
    return await apiFetch('/generate', {
        method: 'POST',
        body: JSON.stringify({
            prompt,
            model: settings.codexModel,
            mode: settings.mode,
            sizeHint: settings.sizeHint,
            qualityHint: settings.qualityHint,
            refs,
        }),
        signal,
    });
}

async function handleGenerate() {
    if (currentJob?.status === 'running') {
        showView('result');
        return;
    }
    showView('result');
    runningController = new AbortController();
    const signal = runningController.signal;
    currentJob = { status: 'running', phase: 'extract', startedAt: Date.now(), prompt: '', error: '', targetIndex: targetMessageIndex(), chatKey: currentChatKey(), targetSnapshot: snapshotOf(targetMessageIndex()) };
    renderResult();

    try {
        const raw = resolveSceneRaw();
        const scene = cleanScene(raw);
        if (!scene) throw new Error('최근 AI 응답에서 이미지용 장면 텍스트를 추출하지 못했습니다.');
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        let parts = null;
        if (settings.refineMode === 'profile') {
            currentJob.phase = 'refine';
            renderResult();
            parts = await refineWithProfile(scene, signal);
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const prompt = buildPrompt(scene, parts);
        currentJob.prompt = prompt;
        currentJob.phase = 'generate';
        renderResult();

        const result = await runEngine(prompt, await collectRefsAsync(), signal);

        const elapsedMs = result.elapsedMs || Date.now() - currentJob.startedAt;
        currentJob = {
            ...currentJob,
            status: 'done',
            imageUrl: result.imageUrl,
            revisedPrompt: result.revisedPrompt || '',
            warning: result.warning || '',
            elapsedMs,
        };
        const storable = typeof currentJob.imageUrl === 'string' && !currentJob.imageUrl.startsWith('data:');
        settings.history.unshift({
            t: Date.now(),
            unavailable: !storable,
            targetIndex: currentJob.targetIndex,
            chatKey: currentJob.chatKey,
            preset: settings.presets[settings.activePreset]?.name || '-',
            mode: settings.mode,
            sec: Math.round(elapsedMs / 1000),
            prompt,
            imageUrl: result.imageUrl,
        });
        settings.history = settings.history.slice(0, HISTORY_MAX);
        await saveSettings();
    } catch (error) {
        if (error?.name === 'AbortError') {
            currentJob = null;
            toast('info', '이미지 생성을 취소했습니다.');
        } else {
            currentJob = { ...(currentJob || {}), status: 'error', error: error.message || String(error) };
            console.error('[Chatelier]', error);
        }
    } finally {
        runningController = null;
        render();
    }
}

function cancelGenerate() {
    runningController?.abort();
}

async function downloadImage(url) {
    try {
        const response = await fetch(url, { headers: headers() });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `codex-image-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
        toast('error', `이미지 저장 실패: ${error.message}`);
    }
}

async function handleRefUpload(event) {
    const slot = event.target.dataset.cxiRefUpload;
    const file = event.target.files?.[0];
    if (!slot || !file) return;
    try {
        const dataUrl = await compressReference(file);
        if (slot === 'char') {
            const key = currentCharKey();
            if (!key) throw new Error('선택된 캐릭터가 없어 캐릭터 이미지를 저장할 수 없습니다. 캐릭터 대화방에서 첨부하세요.');
            settings.charRefs[key] = dataUrl;
        } else {
            settings.refImages[slot] = dataUrl;
        }
        await saveSettings();
        renderSettings();
    } catch (error) {
        toast('error', error.message);
    }
}

function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('파일 읽기 실패'));
        reader.readAsDataURL(file);
    });
}

async function compressReference(file) {
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('PNG/JPEG/WebP 이미지만 지원합니다.');
    const src = await readFileDataUrl(file);
    const image = new Image();
    image.src = src;
    await image.decode();
    const maxSide = 1536;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1 && file.size <= 3 * 1024 * 1024) return src;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.9);
}

function showBootBanner(kind, message) {
    try {
        const inlineHost = document.getElementById('cxi-inline-wrap') || document.getElementById('cxi-extension-entry');
        if (inlineHost) {
            let inlineBox = document.getElementById('cxi-boot-banner-inline');
            if (!inlineBox) {
                inlineBox = document.createElement('div');
                inlineBox.id = 'cxi-boot-banner-inline';
                inlineBox.className = 'cxi-notice';
                inlineBox.addEventListener('click', () => inlineBox.remove());
                inlineHost.prepend(inlineBox);
            }
            inlineBox.dataset.kind = kind === 'ok' ? 'ok' : 'err';
            inlineBox.textContent = `[v${CLIENT_VERSION}] ${message}`;
            if (kind === 'ok') setTimeout(() => inlineBox.remove(), 6000);
        }
        let box = document.getElementById('cxi-boot-banner');
        if (!box) {
            box = document.createElement('div');
            box.id = 'cxi-boot-banner';
            box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;'
                + 'border-radius:12px;padding:12px 14px;font-size:12px;line-height:1.55;'
                + 'white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:55vh;'
                + 'font-family:system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4);';
            box.addEventListener('click', () => box.remove());
            document.body.appendChild(box);
        }
        const ok = kind === 'ok';
        box.style.background = ok ? '#12261a' : '#2a1416';
        box.style.color = ok ? '#c9f5d8' : '#ffd9d9';
        box.style.border = `1px solid ${ok ? '#4ad07f' : '#ff6b6b'}`;
        box.textContent = `[Chatelier v${CLIENT_VERSION}] ${message}\n\n(\ud654\uba74\uc744 \ud0ed\ud558\uba74 \ub2eb\ud798)`;
        if (ok) setTimeout(() => box.remove(), 6000);
    } catch (_) { /* ignore */ }
}

async function waitForContext(timeoutMs = 20000) {
    const startedAt = Date.now();
    let lastError = 'SillyTavern \uc804\uc5ed \uac1d\uccb4 \uc5c6\uc74c';
    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') {
                const ctx = globalThis.SillyTavern.getContext();
                if (ctx && ctx.extensionSettings) return ctx;
                lastError = 'getContext()\uc5d0 extensionSettings\uac00 \uc5c6\uc74c';
            }
        } catch (error) {
            lastError = error?.message || String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`SillyTavern \ucee8\ud14d\uc2a4\ud2b8\ub97c ${timeoutMs / 1000}\ucd08 \uc548\uc5d0 \uc5bb\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. (${lastError})`);
}

export async function init() {
    if (initialized) {
        try { createUi(); } catch (_) { /* ignore */ }
        return;
    }
    initialized = true;
    let step = 'start';
    try {
        step = 'context';
        await waitForContext();

        step = 'settings';
        try {
            loadSettings();
        } catch (error) {
            settings = normalizeSettings(null);
            console.warn('[Chatelier] settings fallback', error);
        }

        step = 'bind';
        bindDelegatedClicks();

        step = 'ui';
        createUi();

        step = 'messages';
        installMessageObserver();
        setTimeout(installMessageObserver, 3000);

        step = 'done';
        console.log(`[Chatelier] extension loaded v${CLIENT_VERSION}`);

        // Success is visible in the extension menu; only failures need a banner.

        refreshProfiles().catch(error => console.info('[Chatelier] profiles skipped', error));
        refreshCodexStatus(false).catch(() => {});
    } catch (error) {
        initialized = false;
        const message = `\ucd08\uae30\ud654 \uc2e4\ud328 (step: ${step})\n${error?.message || error}`;
        console.error('[Chatelier] init failed', error);
        showBootBanner('error', message);
        try {
            createUi();
        } catch (uiError) {
            showBootBanner('error', `${message}\n\nUI \uc0dd\uc131\ub3c4 \uc2e4\ud328: ${uiError?.message || uiError}`);
        }
    }
}

function boot() {
    init().catch(error => showBootBanner('error', `boot \uc608\uc678: ${error?.message || error}`));
}

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        queueMicrotask(boot);
    }
} catch (error) {
    showBootBanner('error', `\ubd80\ud305 \ub4f1\ub85d \uc2e4\ud328: ${error?.message || error}`);
}
