import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/texture-budget.mjs', import.meta.url));

async function fixture(t) {
    const tempRoot = await realpath(tmpdir());
    const folder = await mkdtemp(join(tempRoot, 'texture-groups-'));
    t.after(async () => {
        assert.equal(dirname(await realpath(folder)), tempRoot);
        await rm(folder, { recursive: true, force: true });
    });

    return {
        async put(path, width, height) {
            const location = join(folder, path);
            await mkdir(dirname(location), { recursive: true });
            // JPEG SOI, single-component SOF0 and EOI.
            const header = Buffer.from([
                0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
            ]);
            header.writeUInt16BE(height, 7);
            header.writeUInt16BE(width, 9);
            await writeFile(location, header);
        },
        run(expectedExit, ...args) {
            const result = spawnSync(process.execPath, [cli, folder, ...args], {
                encoding: 'utf8', timeout: 10_000, windowsHide: true,
            });
            assert.ifError(result.error);
            assert.equal(result.signal, null);
            assert.equal(result.status, expectedExit, result.stderr || result.stdout);
            return result;
        },
    };
}

test('groups root and nested textures by folder depth in byte order with exact-path ties', async t => {
    const { put, run } = await fixture(t);
    for (const [path, width, height] of [
        ['root.jpg', 4, 4],
        ['root-extra.jpg', 2, 2],
        ['actors/enemies/grunt.jpg', 4, 4],
        ['actors/enemies/boss/frame.jpg', 2, 2],
        ['actors/heroes/main.jpg', 2, 3],
        ['actors/portrait.jpg', 1, 2],
        ['Z-ui/hud/health.jpg', 5, 4],
        ['effects/dot.jpg', 2, 1],
    ]) {
        await put(path, width, height);
    }

    const defaultReport = JSON.parse(run(0, '--json').stdout);
    assert.equal(Object.hasOwn(defaultReport, 'groupDepth'), false);
    assert.equal(Object.hasOwn(defaultReport, 'groups'), false);
    assert.deepEqual(defaultReport.totals, { files: 8, diskBytes: '136', rgbaBytes: '280' });

    const shallow = JSON.parse(run(0, '--json', '--group-depth', '1').stdout);
    assert.equal(shallow.groupDepth, 1);
    assert.deepEqual(shallow.groups, [
        { path: 'actors', files: 4, diskBytes: '68', rgbaBytes: '112' },
        { path: '.', files: 2, diskBytes: '34', rgbaBytes: '80' },
        { path: 'Z-ui', files: 1, diskBytes: '17', rgbaBytes: '80' },
        { path: 'effects', files: 1, diskBytes: '17', rgbaBytes: '8' },
    ]);
    assert.deepEqual(shallow.totals, defaultReport.totals);

    const deep = JSON.parse(run(0, '--json', '--group-depth', '2').stdout);
    assert.equal(deep.groupDepth, 2);
    assert.deepEqual(deep.groups, [
        { path: '.', files: 2, diskBytes: '34', rgbaBytes: '80' },
        { path: 'Z-ui/hud', files: 1, diskBytes: '17', rgbaBytes: '80' },
        { path: 'actors/enemies', files: 2, diskBytes: '34', rgbaBytes: '80' },
        { path: 'actors/heroes', files: 1, diskBytes: '17', rgbaBytes: '24' },
        { path: 'actors', files: 1, diskBytes: '17', rgbaBytes: '8' },
        { path: 'effects', files: 1, diskBytes: '17', rgbaBytes: '8' },
    ]);
    assert.deepEqual(deep.totals, defaultReport.totals);

    const html = run(0, '--html', '--group-depth', '2').stdout;
    assert.match(html, /Folder totals/i);
});

test('returns no groups for an empty scan and rejects invalid depths', async t => {
    const { run } = await fixture(t);
    const empty = JSON.parse(run(0, '--json', '--group-depth', '1').stdout);
    assert.equal(empty.groupDepth, 1);
    assert.deepEqual(empty.groups, []);

    for (const depth of ['0', '-1', '1.5', 'not-a-number']) {
        const result = run(2, '--json', `--group-depth=${depth}`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /group-depth.*positive integer/i);
    }
});
