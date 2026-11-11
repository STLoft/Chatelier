import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePresets, uniquePresetName, parsePresetBundle, createPresetBundle, buildVisualPrompt } from '../presets.js';

test('fresh installs have one editable default preset; saved presets survive normalization', () => {
    assert.equal(normalizePresets().length, 1);
    assert.equal(normalizePresets()[0].name, '기본');
    assert.match(normalizePresets()[0].body, /korean manhwa style/);
    const existing = [{ name: 'My style', body: 'custom {scene}' }];
    assert.deepEqual(normalizePresets(existing), existing);
    assert.notEqual(normalizePresets(existing)[0], existing[0]);
});
test('exports whitelist name and prompt, and round-trip through import', () => {
    const original = [{ name: 'My preset', body: 'draw {scene}', apiKey: 'excluded', refImages: 'excluded', history: ['excluded'] }];
    const bundle = createPresetBundle(original);
    assert.deepEqual(Object.keys(bundle.presets[0]), ['name', 'body']);
    assert.deepEqual(parsePresetBundle(JSON.stringify(bundle)), [{ name: 'My preset', body: 'draw {scene}' }]);
});
test('invalid import rejects the whole bundle, including oversized prompts', () => {
    for (const presets of [[], [{ name: 'valid', body: 'ok' }, { name: '', body: 'bad' }], [{ name: 'long', body: 'x'.repeat(30001) }]]) {
        assert.throws(() => parsePresetBundle(JSON.stringify({ format: 'chatelier-presets', version: 1, presets })));
    }
    assert.throws(() => parsePresetBundle('{broken'));
    assert.throws(() => parsePresetBundle(JSON.stringify({ format: 'other', version: 1, presets: [{}] })));
    assert.throws(() => parsePresetBundle('x'.repeat(1024 * 1024 + 1)));
});
test('duplicate imported names remain distinct', () => {
    assert.equal(uniquePresetName('Art', [{ name: 'Art' }, { name: 'Art (2)' }]), 'Art (3)');
});
test('raw scene interpolation preserves literal dollar signs and nested placeholder text', () => {
    assert.equal(buildVisualPrompt('style\n{scene}', '$& {char}', null), 'style\n$& {char}');
});
test('profile mode expands each field and appends scene when there are no placeholders', () => {
    const parts = { bg: 'cafe', char: 'one person', outfit: 'coat', comp: 'close-up' };
    assert.equal(buildVisualPrompt('{bg} / {char} / {outfit} / {comp}', '', parts), 'cafe / one person / coat / close-up');
    assert.equal(buildVisualPrompt('watercolor', '', parts), 'watercolor\n\ncafe, one person, coat, close-up');
});
