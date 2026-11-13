import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CrossfadeMixer, PcmDeck, PCM_BYTES_PER_SECOND } from '../src/audio/CrossfadeMixer.js';

/** `seconds` de PCM stéréo dont tous les échantillons valent `value`. */
function constantPcm(seconds: number, value: number): Buffer {
    const buffer = Buffer.alloc(Math.floor(seconds * PCM_BYTES_PER_SECOND));
    for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(value, offset);
    return buffer;
}

function sourceOf(pcm: Buffer, chunkBytes = 7_001): PassThrough {
    // Taille de bloc impaire : la source ne coupe pas sur des frontières d'échantillon.
    const stream = new PassThrough();
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        stream.write(pcm.subarray(offset, offset + chunkBytes));
    }
    stream.end();
    return stream;
}

async function collect(mixer: CrossfadeMixer): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of mixer) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}

function sampleAt(pcm: Buffer, seconds: number): number {
    const offset = Math.floor(seconds * PCM_BYTES_PER_SECOND);
    return pcm.readInt16LE(offset - (offset % 4));
}

test('without a next source the mixer is a byte-exact passthrough that ends with its source', async () => {
    const input = constantPcm(1.5, 1234);
    const mixer = new CrossfadeMixer(sourceOf(input), 2);
    let tails = 0;
    mixer.on('tail', () => { tails += 1; });

    const output = await collect(mixer);
    assert.equal(output.length, input.length);
    assert.ok(output.equals(input));
    assert.equal(tails, 1, 'la fin de piste est annoncée une seule fois');
});

test('an attached next source overlaps the tail: total length shrinks by the fade and both tracks are mixed', async () => {
    const first = constantPcm(3, 10_000);
    const second = constantPcm(3, -10_000);
    const mixer = new CrossfadeMixer(sourceOf(first), 4);
    let handovers = 0;
    mixer.once('tail', () => {
        assert.equal(mixer.awaitingNext, true);
        const attached = mixer.attachNext(new PcmDeck(sourceOf(second), PCM_BYTES_PER_SECOND), 1, () => {
            handovers += 1;
            return true;
        });
        assert.equal(attached, true);
    });

    const output = await collect(mixer);
    assert.equal(handovers, 1);
    assert.equal(output.length, first.length + second.length - PCM_BYTES_PER_SECOND, 'une seconde de recouvrement');
    assert.equal(sampleAt(output, 1), 10_000, 'avant le fondu : première piste seule');
    assert.equal(sampleAt(output, 4), -10_000, 'après le fondu : seconde piste seule');
    // Au milieu du fondu, deux signaux opposés à puissance égale s'annulent.
    assert.ok(Math.abs(sampleAt(output, 2.5)) < 200, `milieu du fondu: ${sampleAt(output, 2.5)}`);
    // Juste après le début, la première piste domine encore ; juste avant la fin, la seconde.
    assert.ok(sampleAt(output, 2.1) > 5_000);
    assert.ok(sampleAt(output, 2.9) < -5_000);
});

test('a refused handover drops the next source and lets the current track finish alone', async () => {
    const first = constantPcm(2, 500);
    const nextSource = sourceOf(constantPcm(2, 900));
    const mixer = new CrossfadeMixer(sourceOf(first), 3);
    mixer.once('tail', () => {
        mixer.attachNext(new PcmDeck(nextSource, PCM_BYTES_PER_SECOND), 1, () => false);
    });

    const output = await collect(mixer);
    assert.ok(output.equals(first));
    assert.equal(nextSource.destroyed, true, 'la source refusée est libérée');
});

test('detaching before the fade and destroying the mixer release every source', async () => {
    const currentSource = new PassThrough();
    const nextSource = new PassThrough();
    const mixer = new CrossfadeMixer(currentSource, 2);
    currentSource.write(constantPcm(0.2, 1));

    assert.equal(mixer.attachNext(new PcmDeck(nextSource, 1_000), 1, () => true), true);
    assert.equal(mixer.hasPendingNext, true);
    mixer.detachNext();
    assert.equal(mixer.hasPendingNext, false);
    assert.equal(nextSource.destroyed, true);

    const lateSource = new PassThrough();
    mixer.attachNext(new PcmDeck(lateSource, 1_000), 1, () => true);
    mixer.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentSource.destroyed, true);
    assert.equal(lateSource.destroyed, true);
});

test('a track too short to fade is chained without mixing', async () => {
    const first = constantPcm(0.1, 700);
    const second = constantPcm(0.5, -700);
    const mixer = new CrossfadeMixer(sourceOf(first), 2);
    mixer.once('tail', () => {
        mixer.attachNext(new PcmDeck(sourceOf(second), PCM_BYTES_PER_SECOND), 5, () => true);
    });

    const output = await collect(mixer);
    assert.ok(output.equals(Buffer.concat([first, second])), 'aucun échantillon perdu ni mixé');
});

test('a deck paces its source and only hands out whole stereo frames', async () => {
    const source = new PassThrough({ highWaterMark: 64 });
    const deck = new PcmDeck(source, 8);
    source.write(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]));
    assert.equal(await deck.waitForData(100), true);
    assert.equal(source.isPaused(), true, 'la source est mise en pause au-delà du tampon d’avance');
    assert.equal(deck.length, 8, 'les deux octets orphelins attendent la suite');
    assert.equal(deck.read(6).length, 4);
    assert.equal(source.isPaused(), false);
    deck.destroy();
    assert.equal(source.destroyed, true);
});
