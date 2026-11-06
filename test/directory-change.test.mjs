import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { scanTextures } from '../src/budget.mjs';

const fs = createRequire(import.meta.url)('node:fs/promises');

test('rejects a directory replaced by a link before opening any outside texture', async t => {
    const tempRoot = await fs.realpath(tmpdir());
    const fixture = await fs.mkdtemp(join(tempRoot, 'texture-budget-directory-change-'));
    t.after(async () => {
        assert.equal(dirname(await fs.realpath(fixture)), tempRoot);
        await fs.rm(fixture, { recursive: true, force: true });
    });

    const root = join(fixture, 'root');
    const nested = join(root, 'nested');
    const outside = join(fixture, 'outside');
    const outsideTexture = join(outside, 'outside.png');
    const replacement = join(fixture, 'replacement');
    await fs.mkdir(root);
    await fs.mkdir(nested);
    await fs.mkdir(outside);
    await fs.writeFile(outsideTexture, 'The scanner should never open this file.');
    try {
        await fs.symlink(outside, replacement, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return;
        }
        throw error;
    }

    const { open, readdir } = fs;
    let replaced = false;
    let outsideOpens = 0;
    fs.readdir = async (path, options) => {
        if (path === nested && !replaced) {
            // The walker has statted the directory but has yet to enumerate it.
            await fs.rename(nested, join(fixture, 'original'));
            await fs.rename(replacement, nested);
            replaced = true;
        }
        return readdir(path, options);
    };
    fs.open = (path, ...args) => {
        if (path === outsideTexture || path === join(nested, 'outside.png')) {
            outsideOpens++;
        }
        return open(path, ...args);
    };
    try {
        syncBuiltinESMExports();
        await assert.rejects(scanTextures(root), /Directory "nested" changed while it was being scanned/);
        assert.equal(replaced, true);
        assert.equal(outsideOpens, 0);
    } finally {
        fs.open = open;
        fs.readdir = readdir;
        syncBuiltinESMExports();
    }
});
