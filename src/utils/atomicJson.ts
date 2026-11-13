import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(value, null, 2), 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(() => undefined);
    }
}
