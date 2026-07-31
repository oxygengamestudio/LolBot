import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, test } from 'node:test';
import { httpRequest } from '../src/utils/httpClient.js';

type FakeResponse = {
    statusCode: number;
    location?: string;
};

const originalRequest = https.request;

function mockHttps(responses: FakeResponse[]) {
    const requests: string[] = [];
    let destroyedResponses = 0;

    https.request = ((options: Record<string, unknown>, callback: (response: any) => void) => {
        requests.push(`${String(options.protocol)}//${String(options.hostname)}${String(options.path)}`);
        const request = new EventEmitter() as any;
        request.setTimeout = () => request;
        request.write = () => true;
        request.destroy = (error?: Error) => {
            if (error) queueMicrotask(() => request.emit('error', error));
        };
        request.end = () => {
            queueMicrotask(() => {
                const next = responses.shift();
                assert.ok(next, 'une réponse HTTP factice est requise');
                const response = new EventEmitter() as any;
                response.statusCode = next.statusCode;
                response.headers = next.location ? { location: next.location } : {};
                response.resume = () => undefined;
                response.destroy = () => { destroyedResponses += 1; };
                callback(response);
            });
        };
        return request;
    }) as typeof https.request;

    return {
        requests,
        get destroyedResponses() { return destroyedResponses; },
    };
}

afterEach(() => {
    https.request = originalRequest;
});

test('bodyless HTTP responses stop after headers without downloading the page', async () => {
    const observed = mockHttps([{ statusCode: 200 }]);
    const response = await httpRequest({
        url: 'https://on.soundcloud.com/AbC123',
        allowedDomains: ['soundcloud.com'],
        responseType: 'none',
    });

    assert.equal(response.body, null);
    assert.equal(response.finalUrl, 'https://on.soundcloud.com/AbC123');
    assert.equal(observed.destroyedResponses, 1);
    assert.equal(observed.requests.length, 1);
});

test('every redirect is revalidated against the SoundCloud HTTPS allowlist', async () => {
    for (const location of [
        'https://example.com/track',
        'http://soundcloud.com/user/track',
    ]) {
        const observed = mockHttps([{ statusCode: 302, location }]);
        await assert.rejects(
            httpRequest({
                url: 'https://on.soundcloud.com/AbC123',
                allowedDomains: ['soundcloud.com'],
                responseType: 'none',
            }),
            /Blocked (?:host|non-HTTPS URL)/
        );
        assert.equal(observed.requests.length, 1, 'la cible interdite ne doit jamais être contactée');
    }
});

test('redirect loops stop at the configured maximum', async () => {
    const observed = mockHttps([
        { statusCode: 302, location: 'https://on.soundcloud.com/loop' },
        { statusCode: 302, location: 'https://on.soundcloud.com/loop' },
        { statusCode: 302, location: 'https://on.soundcloud.com/loop' },
    ]);

    await assert.rejects(
        httpRequest({
            url: 'https://on.soundcloud.com/loop',
            allowedDomains: ['soundcloud.com'],
            maxRedirects: 2,
            responseType: 'none',
        }),
        /Too many redirects/
    );
    assert.equal(observed.requests.length, 3);
});
