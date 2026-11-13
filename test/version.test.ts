import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { botVersion } from '../src/utils/version.js';

test('the displayed bot version is the package version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.match(botVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(botVersion, pkg.version);
});
