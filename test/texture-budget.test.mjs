import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { renderHtmlReport } from '../src/report-html.mjs';

const cli = fileURLToPath(new URL('../bin/texture-budget.mjs', import.meta.url));
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

async function fixture(t) {
    const tempRoot = await realpath(tmpdir());
    const directory = await mkdtemp(join(tempRoot, 'texture-budget-'));
    t.after(async () => {
        assert.equal(dirname(await realpath(directory)), tempRoot);
        await rm(directory, { recursive: true, force: true });
    });
    const folder = join(directory, 'texture assets');
    await mkdir(folder);
    return {
        directory,
        folder,
        run(...args) {
            const result = spawnSync(process.execPath, [cli, ...args], {
                cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true,
            });
            assert.ifError(result.error);
            assert.equal(result.signal, null);
            return result;
        },
    };
}

function expectExit(result, status) {
    assert.equal(result.status, status, result.stderr || result.stdout);
}

function expectStandaloneHtml(html) {
    assert.match(html, /^\s*<!doctype html>\s*<html\b/i);
    assert.match(html, /<head\b[\s\S]*<\/head>\s*<body\b[\s\S]*<\/body>\s*<\/html>\s*$/i);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
    assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i);
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, 'ascii');
    data.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, 8 + data.length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return chunk;
}

function pngHeader(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // Bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([pngSignature, pngChunk('IHDR', ihdr)]);
}

function png(width, height) {
    const scanlines = Buffer.alloc((1 + width * 4) * height);
    return Buffer.concat([
        pngHeader(width, height),
        pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// Only dimension-bearing headers are needed. JPEG entropy data is outside the scanner's scope.
function jpegHeader(width, height) {
    const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
    frame.writeUInt16BE(height, 5);
    frame.writeUInt16BE(width, 7);
    const soiAndApp = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 6, 0, 0xff, 0xc0, 0]);
    return Buffer.concat([soiAndApp, frame, Buffer.from([0xff, 0xd9])]);
}

function webpLosslessHeader(width, height) {
    const file = Buffer.alloc(26);
    file.write('RIFF', 0, 'ascii');
    file.writeUInt32LE(file.length - 8, 4);
    file.write('WEBPVP8L', 8, 'ascii');
    file.writeUInt32LE(5, 16);
    file[20] = 0x2f;
    file.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
    return file;
}

test('scans nested texture headers and sorts descending by RGBA size then path', async t => {
    const { folder, run } = await fixture(t);
    const nested = join(folder, 'level art');
    await mkdir(nested);
    const atlas = png(5, 3);
    const thumbnail = jpegHeader(3, 2);
    const icon = webpLosslessHeader(2, 2);
    await writeFile(join(nested, 'Atlas.PNG'), atlas);
    await writeFile(join(folder, 'Z-last.JPEG'), thumbnail);
    await writeFile(join(folder, 'A-first.jpg'), thumbnail);
    await writeFile(join(folder, 'Icon.WeBp'), icon);
    await writeFile(join(folder, 'mislabeled.JPG'), icon);
    await writeFile(join(folder, 'not-scanned.txt'), atlas);

    const result = run('texture assets', '--json');
    expectExit(result, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
        files: [
            { path: 'level art/Atlas.PNG', format: 'png', width: 5, height: 3, diskBytes: String(atlas.length), rgbaBytes: '60' },
            { path: 'A-first.jpg', format: 'jpeg', width: 3, height: 2, diskBytes: String(thumbnail.length), rgbaBytes: '24' },
            { path: 'Z-last.JPEG', format: 'jpeg', width: 3, height: 2, diskBytes: String(thumbnail.length), rgbaBytes: '24' },
            { path: 'Icon.WeBp', format: 'webp', width: 2, height: 2, diskBytes: String(icon.length), rgbaBytes: '16' },
            { path: 'mislabeled.JPG', format: 'webp', width: 2, height: 2, diskBytes: String(icon.length), rgbaBytes: '16' },
        ],
        totals: { files: 5, diskBytes: String(atlas.length + 2 * thumbnail.length + 2 * icon.length), rgbaBytes: '140' },
        limits: { maxEdge: null, maxTotalMiB: null },
        exceeded: { edge: [], total: false },
        invalid: [],
        skippedLinks: [],
        mipmaps: false,
    });
    assert.deepEqual(await readFile(join(nested, 'Atlas.PNG')), atlas);
});

test('counts non-power-of-two mip levels and flags an edge over the limit', async t => {
    const { folder, run } = await fixture(t);
    await writeFile(join(folder, 'wide.png'), png(5, 3));
    await writeFile(join(folder, 'allowed.png'), png(4, 1));

    const result = run(folder, '--json', '--mipmaps', '--max-edge', '4');
    expectExit(result, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mipmaps, true);
    assert.deepEqual(report.files.map(({ path, rgbaBytes }) => ({ path, rgbaBytes })), [
        { path: 'wide.png', rgbaBytes: '72' }, // 5x3, 2x1, 1x1.
        { path: 'allowed.png', rgbaBytes: '28' }, // 4x1, 2x1, 1x1.
    ]);
    assert.equal(report.totals.rgbaBytes, '100');
    assert.deepEqual(report.limits, { maxEdge: 4, maxTotalMiB: null });
    assert.deepEqual(report.exceeded, { edge: ['wide.png'], total: false });
});

test('permits exact limits and flags a mipmapped total over one MiB', async t => {
    const { folder, run } = await fixture(t);
    await writeFile(join(folder, 'square.png'), png(512, 512));
    const args = [folder, '--json', '--max-edge', '512', '--max-total-mib', '1'];
    const baseline = run(...args);
    expectExit(baseline, 0);
    const report = JSON.parse(baseline.stdout);
    assert.equal(report.totals.rgbaBytes, '1048576');
    assert.deepEqual(report.limits, { maxEdge: 512, maxTotalMiB: 1 });
    assert.deepEqual(report.exceeded, { edge: [], total: false });

    const mipmapped = run(...args, '--mipmaps');
    expectExit(mipmapped, 1);
    assert.equal(JSON.parse(mipmapped.stdout).totals.rgbaBytes, '1398100');
    assert.deepEqual(JSON.parse(mipmapped.stdout).exceeded, { edge: [], total: true });
});

test('checks per-image budgets independently and includes mipmaps', async t => {
    const { folder, run } = await fixture(t);
    await writeFile(join(folder, 'edge.png'), png(512, 512));
    await writeFile(join(folder, 'small.png'), png(64, 64));
    const exact = run(folder, '--json', '--max-image-mib', '1');
    expectExit(exact, 0);
    assert.equal(JSON.parse(exact.stdout).limits.maxImageMiB, 1);
    assert.deepEqual(JSON.parse(exact.stdout).exceeded, { edge: [], total: false, images: [] });

    const mipmapped = run(folder, '--json', '--max-image-mib', '1', '--mipmaps');
    expectExit(mipmapped, 1);
    assert.deepEqual(JSON.parse(mipmapped.stdout).exceeded, { edge: [], total: false, images: ['edge.png'] });
    const html = run(folder, '--html', '--max-image-mib', '1', '--mipmaps');
    expectExit(html, 1);
    assert.match(html.stdout, /Over image budget/);
    expectExit(run(folder, '--max-image-mib', '0'), 2);
});

test('preserves large byte estimates and sorting beyond Number precision', async t => {
    const { folder, run } = await fixture(t);
    const edge = 0x7ffffffe;
    await writeFile(join(folder, 'Z-larger.png'), pngHeader(edge, edge));
    await writeFile(join(folder, 'A-smaller.png'), pngHeader(edge - 1, edge + 1));
    const larger = BigInt(edge) ** 2n * 4n;
    const smaller = larger - 4n;

    const result = run(folder, '--json');
    expectExit(result, 0);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.files.map(({ path, rgbaBytes }) => ({ path, rgbaBytes })), [
        { path: 'Z-larger.png', rgbaBytes: String(larger) },
        { path: 'A-smaller.png', rgbaBytes: String(smaller) },
    ]);
    assert.equal(report.totals.rgbaBytes, String(larger + smaller));
});

test('reports malformed images and continues scanning other textures', async t => {
    const { folder, run } = await fixture(t);
    await writeFile(join(folder, 'z-truncated.png'), pngSignature);
    await writeFile(join(folder, 'a-unrecognized.JPEG'), 'not an image');
    await writeFile(join(folder, 'm-zero-width.png'), pngHeader(0, 1));
    const valid = png(1, 1);
    await writeFile(join(folder, 'good.png'), valid);

    const result = run(folder, '--json');
    expectExit(result, 1);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.invalid.map(entry => entry.path), [
        'a-unrecognized.JPEG', 'm-zero-width.png', 'z-truncated.png',
    ]);
    for (const entry of report.invalid) {
        assert.equal(typeof entry.error, 'string');
        assert.ok(entry.error.length > 0);
    }
    assert.deepEqual(report.totals, { files: 1, diskBytes: String(valid.length), rgbaBytes: '4' });
    assert.deepEqual(report.exceeded, { edge: [], total: false });
});

test('rejects a corrupted PNG dimension checksum without inspecting pixel data', async t => {
    const { folder, run } = await fixture(t);
    const wide = png(1025, 1);
    const image = join(folder, 'wide.png');
    await writeFile(image, wide);

    const scan = () => run(folder, '--json', '--max-edge', '512');
    const before = scan();
    expectExit(before, 1);
    const original = JSON.parse(before.stdout);
    assert.equal(original.files[0].width, 1025);
    assert.deepEqual(original.exceeded.edge, ['wide.png']);
    assert.deepEqual(original.invalid, []);

    wide[18] ^= 0x04; // Width becomes 1 while the original IHDR checksum stays intact.
    await writeFile(image, wide);
    const badPixels = png(2, 2);
    badPixels[41] ^= 0x80; // Corrupt IDAT data outside the dimension header.
    await writeFile(join(folder, 'pixels.png'), badPixels);

    const after = scan();
    expectExit(after, 1);
    const report = JSON.parse(after.stdout);
    assert.deepEqual(report.files.map(file => file.path), ['pixels.png']);
    assert.deepEqual(report.totals, { files: 1, diskBytes: String(badPixels.length), rgbaBytes: '16' });
    assert.deepEqual(report.exceeded.edge, []);
    assert.equal(report.invalid.length, 1);
    assert.equal(report.invalid[0].path, 'wide.png');
    assert.match(report.invalid[0].error, /PNG IHDR checksum/i);
});

test('reports directory links without scanning outside the texture folder', async t => {
    const { directory, folder, run } = await fixture(t);
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'large.png'), png(32, 16));
    try {
        await symlink(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
            t.skip(`Link creation is unavailable (${error.code})`);
            return;
        }
        throw error;
    }

    const result = run(folder, '--json');
    expectExit(result, 0);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.skippedLinks, ['linked']);
    assert.deepEqual(report.files, []);
    assert.deepEqual(report.totals, { files: 0, diskBytes: '0', rgbaBytes: '0' });
});

test('emits a standalone HTML report and preserves CLI exit codes', async t => {
    const { folder, run } = await fixture(t);
    await writeFile(join(folder, "O'Brien & Sons.png"), png(5, 3));
    const thumbnail = png(1, 1);
    for (let index = 0; index < 10; index++) {
        await writeFile(join(folder, `small-${index}.png`), thumbnail);
    }
    await writeFile(join(folder, 'zz-tail.png'), thumbnail);

    const clean = run(folder, '--html');
    expectExit(clean, 0);
    expectStandaloneHtml(clean.stdout);
    assert.match(clean.stdout, /O(?:&#39;|&#x27;|&apos;)Brien &amp; Sons\.png/);
    assert.doesNotMatch(clean.stdout, /O'Brien & Sons\.png/);
    assert.match(clean.stdout, /zz-tail\.png/);

    const exceeded = run(folder, '--html', '--max-edge', '4');
    expectExit(exceeded, 1);
    expectStandaloneHtml(exceeded.stdout);
    assert.match(exceeded.stdout, /O(?:&#39;|&#x27;|&apos;)Brien &amp; Sons\.png/);

    await writeFile(join(folder, 'broken.png'), pngSignature);
    const invalid = run(folder, '--html');
    expectExit(invalid, 1);
    expectStandaloneHtml(invalid.stdout);
    assert.match(invalid.stdout, /broken\.png/);

    const conflict = run(folder, '--html', '--json');
    expectExit(conflict, 2);
    assert.equal(conflict.stdout, '');
});

test('HTML report escapes hostile paths, diagnostic text, and skipped links', () => {
    const path = `<script>probe()</script> & "double" 'single'.png`;
    const report = {
        files: [{ path, format: 'png', width: 5, height: 3, diskBytes: '71', rgbaBytes: '60' }],
        totals: { files: 1, diskBytes: '71', rgbaBytes: '60' },
        limits: { maxEdge: 4, maxTotalMiB: null },
        exceeded: { edge: [path], total: false },
        invalid: [{ path: '<bad-path>.png', error: 'bad <img src=x onerror=probe()> & "message"' }],
        skippedLinks: ['<iframe src="https://example.test">'],
        mipmaps: false,
    };

    const html = renderHtmlReport(report);
    expectStandaloneHtml(html);
    assert.match(html, /&lt;script&gt;probe\(\)&lt;\/script&gt; &amp; &quot;double&quot; (?:&#39;|&#x27;|&apos;)single(?:&#39;|&#x27;|&apos;)\.png/);
    assert.match(html, /&lt;bad-path&gt;\.png/);
    assert.match(html, /bad &lt;img src=x onerror=probe\(\)&gt; &amp; &quot;message&quot;/);
    assert.match(html, /&lt;iframe src=&quot;https:\/\/example\.test&quot;&gt;/);
    assert.doesNotMatch(html, /<script>probe\(\)<\/script>|<img src=x|<bad-path>|<iframe\b/i);
});

test('returns execution or usage errors for missing folders and invalid limits', async t => {
    const { folder, directory, run } = await fixture(t);
    expectExit(run('--json'), 2);
    expectExit(run(join(directory, 'missing'), '--json'), 2);
    expectExit(run(folder, '--max-edge', '4.5'), 2);
    expectExit(run(folder, '--max-total-mib', 'bad'), 2);
});
