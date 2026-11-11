import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/texture-budget.mjs', import.meta.url));
const action = fileURLToPath(new URL('../bin/action.mjs', import.meta.url));

async function fixture(t, nodeArgs = []) {
    const tempRoot = await realpath(tmpdir());
    const directory = await mkdtemp(join(tempRoot, 'texture-baseline-'));
    t.after(async () => {
        assert.equal(dirname(await realpath(directory)), tempRoot);
        await rm(directory, { recursive: true, force: true });
    });
    const folder = join(directory, 'textures');
    const baseline = join(directory, 'before.json');
    await mkdir(folder);

    function run(status, ...flags) {
        const output = flags.includes('--html') ? [] : ['--json'];
        const result = spawnSync(process.execPath, [...nodeArgs, cli, folder, ...output, ...flags], {
            cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, status, result.stderr || result.stdout);
        if (status === 2) {
            assert.equal(result.stdout, '');
            assert.doesNotMatch(result.stderr, /Unknown option/i);
            return result.stderr;
        }
        return result.stdout;
    }

    async function put(name, width, height) {
        // SOI, single-component SOF0, EOI. Only the dimension header is inspected.
        const bytes = Buffer.from([
            0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
        ]);
        bytes.writeUInt16BE(height, 7);
        bytes.writeUInt16BE(width, 9);
        await writeFile(join(folder, name), bytes);
    }

    return { baseline, directory, folder, put, run };
}

function fixtureWithBaselineReadHook(t, changeBaseline) {
    const preload = `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { dirname, join } from 'node:path';

        const position = process.argv.indexOf('--baseline');
        const baseline = position < 0 ? null : process.argv[position + 1];
        const open = fs.open;
        fs.open = async (path, ...args) => {
            const handle = await open(path, ...args);
            if (path === baseline) {
                const read = handle.readFile.bind(handle);
                handle.readFile = async (...options) => {
                    const bytes = await read(...options);
                    ${changeBaseline}
                    return bytes;
                };
            }
            return handle;
        };
        syncBuiltinESMExports();
    `;
    return fixture(t, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]);
}

test('rejects a baseline edited while its original bytes are being read', async t => {
    const { baseline, directory, put, run } = await fixtureWithBaselineReadHook(t, `
        await fs.writeFile(path, await fs.readFile(join(dirname(path), 'new-baseline.json')));
    `);
    const emptyBaseline = run(0);
    await put('current.jpg', 1, 1);
    await writeFile(baseline, run(0));
    await writeFile(join(directory, 'new-baseline.json'), emptyBaseline);
    assert.match(run(2, '--baseline', baseline, '--max-growth-mib', '0'), /Baseline changed during reading/);
    assert.equal(await readFile(baseline, 'utf8'), emptyBaseline);
});

test('rejects a baseline path retargeted while the original handle stays open', async t => {
    const { directory, put, run } = await fixtureWithBaselineReadHook(t, `
        const link = dirname(path);
        const windows = process.platform === 'win32';
        if (windows) await fs.rmdir(link);
        else await fs.unlink(link);
        await fs.symlink(join(dirname(link), 'replacement'), link, windows ? 'junction' : 'dir');
    `);
    const original = join(directory, 'original');
    const replacement = join(directory, 'replacement');
    const reference = join(directory, 'reference');
    await mkdir(original);
    await mkdir(replacement);
    const emptyBaseline = run(0);
    await writeFile(join(replacement, 'baseline.json'), emptyBaseline);
    await put('current.jpg', 1, 1);
    await writeFile(join(original, 'baseline.json'), run(0));
    try {
        await symlink(original, reference, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return;
        }
        throw error;
    }
    const baseline = join(reference, 'baseline.json');
    assert.match(run(2, '--baseline', baseline, '--max-growth-mib', '0'), /Baseline changed during reading/);
    assert.equal(await readFile(baseline, 'utf8'), emptyBaseline);
});

test('compares a saved JSON report without changing the default report shape', async t => {
    const { baseline, folder, put, run } = await fixture(t);
    await put('unchanged.jpg', 1, 1);
    await put('z-removed.jpg', 1, 1);
    await put('a-removed.jpg', 3, 2);
    await put('z-grown.jpg', 2, 2);
    await put('a-shrunk.jpg', 4, 4);
    const original = run(0);
    assert.equal(Object.hasOwn(JSON.parse(original), 'baseline'), false);
    await writeFile(baseline, original);

    await rm(join(folder, 'z-removed.jpg'));
    await rm(join(folder, 'a-removed.jpg'));
    await put('z-added.jpg', 1, 1);
    await put('a-added.jpg', 4, 4);
    await put('z-grown.jpg', 4, 4);
    await put('a-shrunk.jpg', 2, 2);

    const result = JSON.parse(run(0, '--baseline', baseline));
    assert.equal(result.totals.rgbaBytes, '152');
    assert.deepEqual(result.baseline, {
        previousRgbaBytes: '112',
        deltaRgbaBytes: '40',
        added: ['a-added.jpg', 'z-added.jpg'],
        removed: ['a-removed.jpg', 'z-removed.jpg'],
        changed: [
            { path: 'a-shrunk.jpg', previousRgbaBytes: '64', currentRgbaBytes: '16', deltaRgbaBytes: '-48' },
            { path: 'z-grown.jpg', previousRgbaBytes: '16', currentRgbaBytes: '64', deltaRgbaBytes: '48' },
        ],
        maxGrowthMiB: null,
        growthExceeded: false,
    });
});

test('allows exact growth, fails above the limit, and accepts a shrinking budget', async t => {
    const { baseline, folder, put, run } = await fixture(t);
    await put('base.jpg', 4, 4);
    await writeFile(baseline, run(1, '--max-edge', '1'));

    const unchanged = JSON.parse(run(0, '--baseline', baseline, '--max-growth-mib', '0'));
    assert.equal(unchanged.baseline.deltaRgbaBytes, '0');
    assert.equal(unchanged.baseline.maxGrowthMiB, 0);
    assert.equal(unchanged.baseline.growthExceeded, false);

    await put('new-at-limit.jpg', 512, 512);
    const flags = ['--baseline', baseline, '--max-growth-mib', '1'];
    const exact = JSON.parse(run(0, ...flags));
    assert.equal(exact.baseline.deltaRgbaBytes, '1048576');
    assert.equal(exact.baseline.maxGrowthMiB, 1);
    assert.equal(exact.baseline.growthExceeded, false);

    await put('extra.jpg', 1, 1);
    const exceeded = JSON.parse(run(1, ...flags));
    assert.equal(exceeded.baseline.deltaRgbaBytes, '1048580');
    assert.equal(exceeded.baseline.growthExceeded, true);
    assert.deepEqual(exceeded.exceeded, { edge: [], total: false });
    const html = run(1, ...flags, '--html');
    assert.match(html, /Baseline comparison/);
    assert.match(html, /\+1,048,580 bytes/);
    assert.match(html, /Growth limit <strong>1 MiB<\/strong>/);
    assert.match(html, /Added images \(2\)/);

    for (const name of ['base.jpg', 'new-at-limit.jpg', 'extra.jpg']) {
        await rm(join(folder, name));
    }
    const smaller = JSON.parse(run(0, '--baseline', baseline, '--max-growth-mib', '0'));
    assert.equal(smaller.baseline.deltaRgbaBytes, '-64');
    assert.equal(smaller.baseline.growthExceeded, false);
});

test('rejects invalid reports, inconsistent totals, and different mipmap modes', async t => {
    const { baseline, put, run } = await fixture(t);
    await put('base.jpg', 4, 4);
    const original = run(0);
    await writeFile(baseline, original);
    assert.match(run(2, '--baseline', baseline, '--mipmaps'), /mipmap/i);
    run(2, '--max-growth-mib', '0');
    run(2, '--baseline', baseline, '--max-growth-mib=-1');
    run(2, '--baseline', baseline, '--max-growth-mib', '0.5');

    await writeFile(baseline, run(0, '--mipmaps'));
    const mipmapped = JSON.parse(run(0, '--baseline', baseline, '--mipmaps'));
    assert.equal(mipmapped.baseline.previousRgbaBytes, '84');
    assert.equal(mipmapped.baseline.deltaRgbaBytes, '0');

    const parsed = JSON.parse(original);
    for (const invalid of [
        '{',
        '{}',
        JSON.stringify({ ...parsed, totals: { ...parsed.totals, rgbaBytes: '1' } }),
        JSON.stringify({
            ...parsed,
            files: [...parsed.files, ...parsed.files],
            totals: { ...parsed.totals, files: 2, diskBytes: '34', rgbaBytes: '128' },
        }),
        JSON.stringify({ ...parsed, invalid: [{ path: 'failed.png', error: 'Invalid image' }] }),
    ]) {
        await writeFile(baseline, invalid);
        run(2, '--baseline', baseline);
    }
});

test('rejects self-summed baseline estimates that would hide texture growth', async t => {
    const { baseline, put, run } = await fixture(t);
    for (const { flags, previousBytes, currentBytes, delta } of [
        { flags: [], previousBytes: '60', currentBytes: '84', delta: '24' },
        { flags: ['--mipmaps'], previousBytes: '72', currentBytes: '100', delta: '28' },
    ]) {
        await put('base.jpg', 3, 5);
        const authentic = JSON.parse(run(0, ...flags));
        assert.equal(authentic.files[0].rgbaBytes, previousBytes);
        await writeFile(baseline, JSON.stringify(authentic));
        const compare = [...flags, '--baseline', baseline, '--max-growth-mib', '0'];
        const unchanged = JSON.parse(run(0, ...compare));
        assert.equal(unchanged.baseline.deltaRgbaBytes, '0');
        assert.equal(unchanged.baseline.growthExceeded, false);

        await put('base.jpg', 3, 7);
        const grown = JSON.parse(run(1, ...compare));
        assert.equal(grown.files[0].rgbaBytes, currentBytes);
        assert.equal(grown.baseline.deltaRgbaBytes, delta);
        assert.equal(grown.baseline.growthExceeded, true);

        const edited = {
            ...authentic,
            files: [{ ...authentic.files[0], rgbaBytes: currentBytes }],
            totals: { ...authentic.totals, rgbaBytes: currentBytes },
        };
        await writeFile(baseline, JSON.stringify(edited));
        assert.match(run(2, ...compare), /RGBA8 byte count.*dimensions.*mipmap mode/i);
    }
});

test('rejects missing and impossible baseline dimensions', async t => {
    const { baseline, put, run } = await fixture(t);
    await put('base.jpg', 3, 5);
    const authentic = JSON.parse(run(0));
    for (const width of [undefined, 0, 1.5, 2 ** 31, '3']) {
        await writeFile(baseline, JSON.stringify({
            ...authentic,
            files: [{ ...authentic.files[0], width }],
        }));
        assert.match(run(2, '--baseline', baseline), /invalid baseline image dimensions/i);
    }
});

test('keeps unreadable current images separate from true removals in baseline reports', async t => {
    const { baseline, folder, put, run } = await fixture(t);
    await put('atlas.jpg', 512, 512);
    await put('gone.jpg', 1, 1);
    await writeFile(baseline, run(0));
    await writeFile(join(folder, 'atlas.jpg'), Buffer.from([0xff, 0xd8]));
    await rm(join(folder, 'gone.jpg'));
    await put('added.jpg', 1, 1);

    assert.equal(Object.hasOwn(JSON.parse(run(1)), 'baseline'), false);
    const flags = ['--baseline', baseline, '--max-growth-mib', '0'];
    const json = JSON.parse(run(1, ...flags));
    assert.deepEqual(json.invalid.map(file => file.path), ['atlas.jpg']);
    assert.deepEqual(json.baseline, {
        previousRgbaBytes: '1048580', deltaRgbaBytes: '-1048576', added: ['added.jpg'], removed: ['gone.jpg'],
        changed: [], maxGrowthMiB: 0, growthExceeded: false, incomplete: true,
    });

    const text = spawnSync(process.execPath, [cli, folder, ...flags], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.ifError(text.error);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /Baseline comparison is incomplete/);
    assert.match(text.stdout, /Change using readable current images/);
    assert.match(text.stdout, /Growth limit \(0 MiB\): comparison incomplete/);
    assert.doesNotMatch(text.stdout, /within budget/i);
    const html = run(1, ...flags, '--html');
    assert.match(html, /Baseline comparison is incomplete/);
    assert.match(html, /Change using readable current images/);
    assert.match(html, /Removed images \(1\)/);
    assert.doesNotMatch(html, /within budget/i);

    await put('added.jpg', 1024, 1024);
    assert.equal(JSON.parse(run(1, ...flags)).baseline.growthExceeded, true);
    assert.match(run(1, ...flags, '--html'), /Exceeded by readable images/);
});

test('the Action keeps a JSON report and explains an incomplete baseline check', async t => {
    const { baseline, directory, folder, put, run } = await fixture(t);
    const runnerTemp = join(directory, 'runner temp');
    const output = join(directory, 'output.txt');
    await mkdir(runnerTemp);
    await put('atlas.jpg', 512, 512);
    await writeFile(baseline, run(0));

    async function runAction(status) {
        await writeFile(output, '');
        const result = spawnSync(process.execPath, [action], {
            cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
            env: {
                ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: directory, GITHUB_OUTPUT: output,
                RUNNER_TEMP: runnerTemp, INPUT_DIRECTORY: 'textures', INPUT_BASELINE: 'before.json',
                INPUT_MIPMAPS: 'false', 'INPUT_MAX-GROWTH-MIB': '0',
            },
        });
        assert.ifError(result.error);
        assert.equal(result.status, status, result.stderr);
        const [reportLine, exitLine] = (await readFile(output, 'utf8')).trimEnd().split('\n');
        assert.equal(exitLine, `exit-code=${status}`);
        assert.match(reportLine, /^report-path=/);
        const reportPath = reportLine.slice('report-path='.length);
        assert.equal(dirname(dirname(reportPath)), runnerTemp);
        return { json: JSON.parse(await readFile(reportPath, 'utf8')), stderr: result.stderr };
    }

    const healthy = await runAction(0);
    assert.deepEqual(healthy.json, JSON.parse(run(0, '--baseline', baseline, '--max-growth-mib', '0')));
    assert.equal(Object.hasOwn(healthy.json.baseline, 'incomplete'), false);
    assert.doesNotMatch(healthy.stderr, /comparison is incomplete/i);

    await writeFile(join(folder, 'atlas.jpg'), Buffer.from([0xff, 0xd8]));
    const damaged = await runAction(1);
    assert.equal(damaged.json.baseline.incomplete, true);
    assert.equal(damaged.json.baseline.growthExceeded, false);
    assert.deepEqual(damaged.json.baseline.removed, []);
    assert.deepEqual(damaged.json.invalid.map(file => file.path), ['atlas.jpg']);
    assert.match(damaged.stderr, /Baseline comparison is incomplete\. The current estimate includes readable images only\./);
});

test('keeps baseline images blocked by skipped links separate from true removals', async t => {
    const { baseline, directory, folder, put, run } = await fixture(t);
    const nested = join(folder, 'sprites');
    const outside = join(directory, 'outside');
    await mkdir(nested);
    await mkdir(outside);
    await put('sprites/atlas.jpg', 512, 512);
    await put('sprites-extra.jpg', 1, 1);
    await put('top.jpg', 2, 2);
    await writeFile(baseline, run(0));

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
        await symlink(outside, join(folder, 'untracked'), linkType);
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return;
        }
        throw error;
    }
    const flags = ['--baseline', baseline, '--max-growth-mib', '0'];
    const unrelated = JSON.parse(run(0, ...flags));
    assert.deepEqual(unrelated.skippedLinks, ['untracked']);
    assert.equal(Object.hasOwn(unrelated.baseline, 'incomplete'), false);

    await rename(nested, join(outside, 'sprites'));
    await rename(join(folder, 'top.jpg'), join(outside, 'top.jpg'));
    await symlink(join(outside, 'sprites'), nested, linkType);
    await symlink(outside, join(folder, 'top.jpg'), linkType);
    await rm(join(folder, 'sprites-extra.jpg'));

    const scan = JSON.parse(run(0));
    assert.deepEqual(scan.skippedLinks, ['sprites', 'top.jpg', 'untracked']);
    const compared = JSON.parse(run(1, ...flags));
    assert.deepEqual(compared.skippedLinks, scan.skippedLinks);
    assert.deepEqual(compared.invalid, []);
    assert.equal(compared.baseline.incomplete, true);
    assert.equal(compared.baseline.growthExceeded, false);
    assert.deepEqual(compared.baseline.removed, ['sprites-extra.jpg']);
    assert.equal(JSON.parse(run(1, '--baseline', baseline)).baseline.incomplete, true);

    const html = run(1, ...flags, '--html');
    assert.match(html, /Comparison incomplete/);
    assert.match(html, /Removed images \(1\)/);
    assert.match(html, /Skipped links \(3\)/);
    assert.doesNotMatch(html, /within budget/i);
});

test('keeps newly readable paths behind baseline links out of the growth verdict', async t => {
    const { baseline, directory, folder, put, run } = await fixture(t);
    const outside = join(directory, 'outside');
    const nested = join(folder, 'sprites');
    const top = join(folder, 'top.jpg');
    await mkdir(outside);
    const windows = process.platform === 'win32';
    const linkType = windows ? 'junction' : 'dir';
    try {
        await symlink(outside, nested, linkType);
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            t.skip('Link creation is unavailable (' + error.code + ')');
            return;
        }
        throw error;
    }
    await symlink(outside, top, linkType);
    await put('base.jpg', 2, 2);
    await put('gone.jpg', 1, 1);
    const before = run(0);
    assert.deepEqual(JSON.parse(before).skippedLinks, ['sprites', 'top.jpg']);
    await writeFile(baseline, before);
    const compare = ['--baseline', baseline, '--max-growth-mib', '0'];

    await put('sprites-extra.jpg', 1, 1);
    const unrelated = JSON.parse(run(1, ...compare));
    assert.equal(Object.hasOwn(unrelated.baseline, 'incomplete'), false);
    assert.equal(unrelated.baseline.growthExceeded, true);
    assert.deepEqual(unrelated.baseline.added, ['sprites-extra.jpg']);

    const removeLink = windows ? rmdir : unlink;
    await removeLink(nested);
    await removeLink(top);
    await mkdir(nested);
    await put('sprites/atlas.jpg', 512, 512);
    await put('top.jpg', 2, 2);
    await rm(join(folder, 'gone.jpg'));

    const json = JSON.parse(run(1, ...compare));
    assert.deepEqual(json.skippedLinks, []);
    assert.deepEqual(json.baseline, {
        previousRgbaBytes: '20', deltaRgbaBytes: '1048592',
        added: ['sprites-extra.jpg'], removed: ['gone.jpg'], changed: [],
        maxGrowthMiB: 0, growthExceeded: false, incomplete: true,
        pathsHiddenByBaselineLinks: ['sprites/atlas.jpg', 'top.jpg'],
    });
    assert.equal(JSON.parse(run(1, '--baseline', baseline)).baseline.incomplete, true);

    const text = spawnSync(process.execPath, [cli, folder, ...compare], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.ifError(text.error);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /Paths hidden by baseline links \(2\)/);
    assert.match(text.stdout, /Growth limit \(0 MiB\): comparison incomplete/);
    assert.doesNotMatch(text.stdout, /within budget|exceeded by readable images/i);
    const html = run(1, ...compare, '--html');
    assert.match(html, /Paths hidden by baseline links \(2\)/);
    assert.match(html, /Comparison incomplete/);
    assert.doesNotMatch(html, /within budget|exceeded by readable images/i);

    await rm(join(nested, 'atlas.jpg'));
    await writeFile(top, Buffer.from([0xff, 0xd8]));
    await put('sprites-extra.jpg', 16, 16);
    const unreadable = JSON.parse(run(1, ...compare));
    assert.deepEqual(unreadable.invalid.map(({ path }) => path), ['top.jpg']);
    assert.deepEqual(unreadable.baseline.pathsHiddenByBaselineLinks, ['top.jpg']);
    assert.deepEqual(unreadable.baseline.added, ['sprites-extra.jpg']);
    assert.equal(unreadable.baseline.growthExceeded, false);
    assert.equal(unreadable.baseline.incomplete, true);
});

test('accepts a baseline without link metadata and rejects malformed skipped paths', async t => {
    const { baseline, put, run } = await fixture(t);
    await put('base.jpg', 2, 2);
    const { skippedLinks, ...legacy } = JSON.parse(run(0));
    assert.deepEqual(skippedLinks, []);
    await writeFile(baseline, JSON.stringify(legacy));
    assert.equal(Object.hasOwn(JSON.parse(run(0, '--baseline', baseline)).baseline, 'incomplete'), false);

    for (const malformed of [null, 'sprites', ['../sprites'], [42]]) {
        await writeFile(baseline, JSON.stringify({ ...legacy, skippedLinks: malformed }));
        assert.match(run(2, '--baseline', baseline), /Baseline skipped links require valid relative paths/);
    }
});
