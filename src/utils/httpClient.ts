import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'http';
import { pipeline } from 'stream/promises';
import { assertHttpsUrlAllowed, sanitizeUrlForLogs } from './networkSafety.js';

export interface HttpRequestOptions {
    url: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    allowedDomains: readonly string[];
    timeoutMs?: number;
    maxRedirects?: number;
    maxBytes?: number;
    responseType?: 'text' | 'buffer';
    decompress?: boolean;
    signal?: AbortSignal;
}

export interface HttpResponse<TBody extends string | Buffer> {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: TBody;
    finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function getDecodedStream(res: IncomingMessage): NodeJS.ReadableStream {
    const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
    if (encoding.includes('br')) {
        return res.pipe(zlib.createBrotliDecompress());
    }
    if (encoding.includes('gzip')) {
        return res.pipe(zlib.createGunzip());
    }
    if (encoding.includes('deflate')) {
        return res.pipe(zlib.createInflate());
    }
    return res;
}

export async function httpRequest(
    options: HttpRequestOptions
): Promise<HttpResponse<string | Buffer>> {
    const {
        url,
        method = 'GET',
        headers = {},
        body,
        allowedDomains,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxRedirects = DEFAULT_MAX_REDIRECTS,
        maxBytes = DEFAULT_MAX_BYTES,
        responseType = 'text',
        decompress = true,
        signal,
    } = options;

    return requestInternal(
        {
            url,
            method,
            headers,
            body,
            allowedDomains,
            timeoutMs,
            maxRedirects,
            maxBytes,
            responseType,
            decompress,
            signal,
        },
        0
    );
}

async function requestInternal(
    options: Required<Omit<HttpRequestOptions, 'headers' | 'body' | 'method' | 'timeoutMs' | 'maxRedirects' | 'maxBytes' | 'responseType' | 'decompress' | 'signal'>> &
        Pick<HttpRequestOptions, 'headers' | 'body' | 'method' | 'timeoutMs' | 'maxRedirects' | 'maxBytes' | 'responseType' | 'decompress' | 'signal'>,
    redirectCount: number
): Promise<HttpResponse<string | Buffer>> {
    const {
        url,
        method = 'GET',
        headers = {},
        body,
        allowedDomains,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxRedirects = DEFAULT_MAX_REDIRECTS,
        maxBytes = DEFAULT_MAX_BYTES,
        responseType = 'text',
        decompress = true,
        signal,
    } = options;

    if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects for ${sanitizeUrlForLogs(url)}`);
    }

    const parsed = assertHttpsUrlAllowed(url, allowedDomains);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestOptions: RequestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
    };

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error('HTTP request aborted');
            error.name = 'AbortError';
            reject(error);
            return;
        }

        let settled = false;
        const finishResolve = (value: HttpResponse<string | Buffer>) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const finishReject = (error: unknown) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            reject(error);
        };
        const req = transport.request(requestOptions, (res) => {
            const statusCode = res.statusCode ?? 0;

            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, parsed).toString();
                res.resume();

                const shouldSwitchToGet =
                    statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST');
                const nextMethod = shouldSwitchToGet ? 'GET' : method;
                const nextHeaders = { ...headers };
                const nextBody = shouldSwitchToGet ? undefined : body;

                if (shouldSwitchToGet) {
                    delete nextHeaders['Content-Length'];
                    delete nextHeaders['Content-Type'];
                }

                requestInternal(
                    {
                        url: redirectUrl,
                        method: nextMethod,
                        headers: nextHeaders,
                        body: nextBody,
                        allowedDomains,
                        timeoutMs,
                        maxRedirects,
                        maxBytes,
                        responseType,
                        decompress,
                        signal,
                    },
                    redirectCount + 1
                )
                    .then(finishResolve)
                    .catch(finishReject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                res.resume();
                finishReject(new Error(`HTTP ${statusCode} from ${sanitizeUrlForLogs(url)}`));
                return;
            }

            const source: NodeJS.ReadableStream = decompress ? getDecodedStream(res) : res;
            const chunks: Buffer[] = [];
            let totalBytes = 0;

            source.on('data', (chunk: Buffer | string) => {
                const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += bufferChunk.length;
                if (totalBytes > maxBytes) {
                    req.destroy(new Error(`Response too large for ${sanitizeUrlForLogs(url)}`));
                    return;
                }
                chunks.push(bufferChunk);
            });

            source.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const responseBody = responseType === 'buffer' ? buffer : buffer.toString('utf8');
                finishResolve({
                    statusCode,
                    headers: res.headers,
                    body: responseBody as string | Buffer,
                    finalUrl: parsed.toString(),
                });
            });

            source.on('error', finishReject);
        });

        const onAbort = () => {
            const error = new Error('HTTP request aborted');
            error.name = 'AbortError';
            req.destroy(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms for ${sanitizeUrlForLogs(url)}`));
        });
        req.on('error', finishReject);

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

export async function downloadFile(
    url: string,
    destination: string,
    allowedDomains: readonly string[],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    maxRedirects: number = DEFAULT_MAX_REDIRECTS
): Promise<void> {
    await downloadFileInternal(url, destination, allowedDomains, timeoutMs, maxRedirects, 0);
}

async function downloadFileInternal(
    url: string,
    destination: string,
    allowedDomains: readonly string[],
    timeoutMs: number,
    maxRedirects: number,
    redirectCount: number
): Promise<void> {
    if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects for ${sanitizeUrlForLogs(url)}`);
    }

    const parsed = assertHttpsUrlAllowed(url, allowedDomains);
    const requestOptions: RequestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
            'User-Agent': 'LolBot/1.0',
        },
    };

    await new Promise<void>((resolve, reject) => {
        const req = https.request(requestOptions, async (res) => {
            try {
                const statusCode = res.statusCode ?? 0;
                if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                    const redirectUrl = new URL(res.headers.location, parsed).toString();
                    res.resume();
                    await downloadFileInternal(
                        redirectUrl,
                        destination,
                        allowedDomains,
                        timeoutMs,
                        maxRedirects,
                        redirectCount + 1
                    );
                    resolve();
                    return;
                }

                if (statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode} from ${sanitizeUrlForLogs(url)}`));
                    return;
                }

                const fileStream = createWriteStream(destination);
                await pipeline(res, fileStream);
                resolve();
            } catch (error) {
                await unlink(destination).catch(() => undefined);
                reject(error);
            }
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms for ${sanitizeUrlForLogs(url)}`));
        });
        req.on('error', reject);
        req.end();
    });
}
