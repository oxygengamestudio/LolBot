import assert from 'node:assert/strict';
import test from 'node:test';
import { logger } from '../src/utils/Logger.js';

test('user-controlled log text cannot inject a second console line', () => {
    const output: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));

    try {
        logger.info(
            'PlayCmd\u0085',
            'Query: harmless\n2026-07-19 08:00:00.000 INFO  [Readiness] forged\u009b2J',
            new Error('failure\r\nsecond-line')
        );
    } finally {
        console.log = original;
    }

    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0] ?? '', /\n2026-07-19 08:00:00\.000 INFO  \[Readiness\]/);
    assert.match(output[0] ?? '', /PlayCmd\\u0085/);
    assert.match(output[0] ?? '', /harmless\\n2026-07-19/);
    assert.match(output[0] ?? '', /forged\\u009b2J/);
    assert.match(output[0] ?? '', /failure\\r\\nsecond-line/);
});
