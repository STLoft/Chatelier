export const DEFAULT_PRESETS = [{ name: '기본', body: [
    'masterpiece, best quality,',
    '[background: {bg}],',
    '[characters: {char}],',
    '[outfit: {outfit}],',
    '[composition: {comp}],',
    '[style: korean manhwa style, clean cel shading, muted soft colors, slice of life],',
    'natural soft lighting, film grain, no text, no watermark, subtle details, cinematic mood',
].join('\n') }];
const MAX_PRESETS = 100;
const MAX_BODY = 30000;

export function normalizePresets(value) {
    const presets = Array.isArray(value) ? value.filter(p => p && typeof p.name === 'string' && typeof p.body === 'string')
        .map(p => ({ name: p.name.trim() || '프리셋', body: p.body })) : [];
    return presets.length ? presets : DEFAULT_PRESETS.map(p => ({ ...p }));
}

export function uniquePresetName(name, presets) {
    const base = String(name || '프리셋').trim().slice(0, 80) || '프리셋';
    const used = new Set(presets.map(p => p.name));
    let next = base;
    for (let i = 2; used.has(next); i++) next = `${base} (${i})`;
    return next;
}

export function parsePresetBundle(text) {
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('프리셋 파일은 1MB 이하여야 합니다.');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('올바른 JSON 파일을 선택하세요.'); }
    if (data?.format !== 'chatelier-presets' || data.version !== 1 || !Array.isArray(data.presets)) {
        throw new Error('Chatelier 프리셋 파일 형식이 아닙니다.');
    }
    if (!data.presets.length || data.presets.length > MAX_PRESETS) throw new Error('한 번에 1~100개 프리셋을 가져올 수 있습니다.');
    return data.presets.map(p => {
        if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || typeof p.body !== 'string' || p.body.length > MAX_BODY) {
            throw new Error('이름은 1~80자, 프롬프트는 30,000자 이하여야 합니다.');
        }
        return { name: p.name.trim(), body: p.body };
    });
}

export function createPresetBundle(presets) {
    // Deliberate allowlist: no account settings, keys, reference images or history.
    return { format: 'chatelier-presets', version: 1, presets: presets.map(p => ({ name: p.name, body: p.body })) };
}

export function buildVisualPrompt(source, rawScene, parts) {
    const scene = parts ? [parts.bg, parts.char, parts.outfit, parts.comp].filter(Boolean).join(', ') : rawScene;
    const values = parts ? { ...parts, scene } : { bg: rawScene, char: '', outfit: '', comp: '', scene: rawScene };
    const template = source || '{scene}';
    // A single pass prevents scene text that contains a placeholder from being expanded again.
    let result = template.replace(/\{(bg|char|outfit|comp|scene)\}/g, (_, key) => values[key] || '');
    if (!/\{(?:bg|char|outfit|comp|scene)\}/.test(template)) result += `\n\n${scene}`;
    return result.replace(/\[[^\[\]:]*:\s*\],?/g, '').replace(/,\s*,/g, ',').replace(/\n{3,}/g, '\n\n').trim();
}
