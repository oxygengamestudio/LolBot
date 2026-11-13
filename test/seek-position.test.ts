import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a displayed position maps past every SponsorBlock segment that precedes it', async () => {
    const { audioWrapper } = await import('../src/audio/AudioWrapper.js');
    const wrapper = audioWrapper as any;
    const intro = [{ start: 0, end: 14 }];

    assert.equal(wrapper.toSourcePosition(0, intro), 0, 'le début reste géré par le saut d’intro');
    assert.equal(wrapper.toSourcePosition(213, intro), 227, 'une intro de 14 s décale la position de 14 s');
    assert.equal(wrapper.toSourcePosition(213, []), 213);

    const introAndBreak = [{ start: 0, end: 10 }, { start: 100, end: 130 }, { start: 400, end: 420 }];
    assert.equal(wrapper.toSourcePosition(50, introAndBreak), 60, 'seul le passage déjà franchi compte');
    assert.equal(wrapper.toSourcePosition(95, introAndBreak), 135, 'franchir un second passage ajoute sa durée');
    assert.equal(wrapper.toSourcePosition(200, introAndBreak), 240, 'un passage situé après la position est ignoré');
});
