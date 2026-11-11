#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { bytesPerMiB, sameEntry, scanTextures } from '../src/budget.mjs';
import { compareBudgetBaseline, incompleteComparisonNote } from '../src/baseline.mjs';
import { groupTextures } from '../src/groups.mjs';
import { renderHtmlReport } from '../src/report-html.mjs';

const usage = `Usage:
  texture-budget <folder> [--json | --html] [--mipmaps] [--max-edge <pixels>] [--max-image-mib <MiB>]
                          [--max-total-mib <MiB>] [--baseline <report.json>] [--max-growth-mib <MiB>]
                          [--group-depth <levels>]

Scan PNG, JPEG and WebP headers and estimate uncompressed RGBA8 texture memory.

Options:
  --mipmaps               Include all mip levels down to 1 x 1.
  --max-edge <pixels>      Fail if an image exceeds this width or height.
  --max-image-mib <MiB>    Fail if any individual texture exceeds this budget.
  --max-total-mib <MiB>    Fail if the total estimate exceeds this budget.
  --baseline <report>     Compare with a saved JSON report.
  --max-growth-mib <MiB>   Fail if growth over the baseline exceeds this amount.
  --group-depth <levels>  Summarize textures by parent folder depth.
  --json                  Print every file and result as JSON.
  --html                  Print a standalone HTML report.
  -h, --help              Show this help.
  -v, --version           Show the installed version.`;

function parseLimit(value, option, minimum = 1) {
    if (value === undefined) return null;
    const limit = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(limit) || limit < minimum) {
        const kind = minimum === 0 ? 'non-negative' : 'positive';
        throw new Error(`${option} requires a ${kind} integer.`);
    }
    return limit;
}

async function readBaseline(file) {
    const statOptions = { bigint: true };
    const before = await lstat(file, statOptions);
    if (!before.isFile()) {
        throw new Error('The baseline must be a regular JSON file.');
    }
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(file, flags);
    const matchesBaseline = stat => stat?.isFile() && sameEntry(before, stat);
    try {
        if (!matchesBaseline(await handle.stat(statOptions))) {
            throw new Error('Baseline changed before reading.');
        }
        const bytes = await handle.readFile();
        const handleAfter = await handle.stat(statOptions);
        // An unchanged handle does not rule out a replacement at the baseline path.
        const pathAfter = await lstat(file, statOptions).catch(error => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            throw error;
        });
        if (!matchesBaseline(handleAfter) || !matchesBaseline(pathAfter)) {
            throw new Error('Baseline changed during reading.');
        }
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (error) {
            throw new Error(`Invalid baseline JSON: ${error.message}`);
        }
    } finally {
        await handle.close();
    }
}

function formatBytes(value, signed = false) {
    const amount = BigInt(value);
    const bytes = amount < 0n ? -amount : amount;
    const sign = amount < 0n ? '-' : signed && amount > 0n ? '+' : '';
    const hundredths = (bytes * 100n + bytesPerMiB / 2n) / bytesPerMiB;
    const fraction = String(hundredths % 100n).padStart(2, '0');
    return `${sign}${hundredths / 100n}.${fraction} MiB (${sign}${bytes} bytes)`;
}

async function writeOutput(lines) {
    try {
        await pipeline(function* () {
            for (const line of lines) yield `${line}\n`;
        }, process.stdout);
    } catch (error) {
        throw new Error(`Could not write standard output: ${error.message}`, { cause: error });
    }
}

function* reportLines(report) {
    const { totals, limits, exceeded, invalid, skippedLinks, files, mipmaps, baseline, groups, groupDepth } = report;
    const mode = mipmaps ? 'full mip chain' : 'base level';
    yield `Textures: ${totals.files}`;
    yield `Disk size: ${formatBytes(totals.diskBytes)}`;
    yield `Estimated RGBA8 (${mode}): ${formatBytes(totals.rgbaBytes)}`;
    if (files.length) {
        yield '\nLargest textures:';
        for (const file of files.slice(0, 10)) {
            yield `  ${JSON.stringify(file.path)}  ${file.width} x ${file.height}  ${formatBytes(file.rgbaBytes)}`;
        }
        if (files.length > 10) yield '  Use --json for the complete file list.';
    }
    if (groups) {
        yield `\nFolder totals (depth ${groupDepth}):`;
        for (const group of groups.slice(0, 10)) {
            yield `  ${JSON.stringify(group.path)}  ${group.files} files  ${formatBytes(group.rgbaBytes)}`;
        }
        if (!groups.length) yield '  No readable images.';
        if (groups.length > 10) yield '  Use --json or --html for all groups.';
    }
    if (limits.maxEdge !== null) {
        yield `\nEdge limit (${limits.maxEdge} px): ${exceeded.edge.length} over limit`;
        for (const path of exceeded.edge) yield `  ${JSON.stringify(path)}`;
    }
    if (limits.maxImageMiB !== undefined) {
        yield `\nPer-image limit (${limits.maxImageMiB} MiB): ${exceeded.images.length} over limit`;
        for (const path of exceeded.images) yield `  ${JSON.stringify(path)}`;
    }
    if (limits.maxTotalMiB !== null) {
        const result = exceeded.total ? 'exceeded' : 'within budget';
        yield `Total limit (${limits.maxTotalMiB} MiB): ${result}`;
    }
    if (baseline) {
        yield `\nBaseline RGBA8: ${formatBytes(baseline.previousRgbaBytes)}`;
        if (baseline.incomplete) yield incompleteComparisonNote;
        const change = baseline.incomplete ? 'Change using readable current images' : 'Change';
        yield `${change}: ${formatBytes(baseline.deltaRgbaBytes, true)}`;
        if (baseline.maxGrowthMiB !== null) {
            let result = baseline.growthExceeded ? 'exceeded' : 'within budget';
            if (baseline.incomplete) result = baseline.growthExceeded ? 'exceeded by readable images' : 'comparison incomplete';
            yield `Growth limit (${baseline.maxGrowthMiB} MiB): ${result}`;
        }
        yield `Added: ${baseline.added.length}, removed: ${baseline.removed.length}, changed estimates: ${baseline.changed.length}`;
        for (const { path, deltaRgbaBytes } of baseline.changed.slice(0, 10)) {
            yield `  ${JSON.stringify(path)}  ${formatBytes(deltaRgbaBytes, true)}`;
        }
    }
    if (invalid.length) {
        yield `\nInvalid or unreadable images: ${invalid.length}`;
        for (const { path, error } of invalid) yield `  ${JSON.stringify(path)}: ${error}`;
    }
    if (skippedLinks.length) {
        yield `\nSkipped links: ${skippedLinks.length}`;
        for (const path of skippedLinks) yield `  ${JSON.stringify(path)}`;
    }
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            json: { type: 'boolean' },
            html: { type: 'boolean' },
            mipmaps: { type: 'boolean' },
            'max-edge': { type: 'string' },
            'max-image-mib': { type: 'string' },
            'max-total-mib': { type: 'string' },
            baseline: { type: 'string' },
            'max-growth-mib': { type: 'string' },
            'group-depth': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
    });
    if (values.help) {
        await writeOutput([usage]);
        return 0;
    }
    if (values.version) {
        const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        await writeOutput([version]);
        return 0;
    }
    if (positionals.length !== 1 || !positionals[0]) {
        throw new Error('Expected one folder. See --help.');
    }
    if (values.json && values.html) {
        throw new Error('Choose either --json or --html. See --help.');
    }
    const maxGrowthMiB = parseLimit(values['max-growth-mib'], '--max-growth-mib', 0);
    if (values.baseline === '') {
        throw new Error('--baseline requires a JSON report path. See --help.');
    }
    if (maxGrowthMiB !== null && values.baseline === undefined) {
        throw new Error('--max-growth-mib requires --baseline <report.json>. See --help.');
    }
    const maxEdge = parseLimit(values['max-edge'], '--max-edge');
    const maxImageMiB = parseLimit(values['max-image-mib'], '--max-image-mib');
    const maxTotalMiB = parseLimit(values['max-total-mib'], '--max-total-mib');
    const groupDepth = parseLimit(values['group-depth'], '--group-depth');
    const previous = values.baseline === undefined ? undefined : await readBaseline(resolve(values.baseline));
    const report = await scanTextures(resolve(positionals[0]), {
        mipmaps: values.mipmaps ?? false,
        maxEdge,
        maxImageMiB,
        maxTotalMiB,
    });
    if (values.baseline !== undefined) {
        report.baseline = compareBudgetBaseline(previous, report, { maxGrowthMiB });
    }
    if (groupDepth !== null) {
        report.groupDepth = groupDepth;
        report.groups = groupTextures(report.files, groupDepth);
    }
    if (values.json) {
        if (report.baseline?.incomplete) console.error(`texture-budget: ${incompleteComparisonNote}`);
        await writeOutput([JSON.stringify(report, null, 2)]);
    } else if (values.html) {
        await writeOutput([renderHtmlReport(report)]);
    } else {
        await writeOutput(reportLines(report));
    }
    return report.exceeded.edge.length || report.exceeded.images?.length || report.exceeded.total || report.invalid.length ||
        report.baseline?.growthExceeded || report.baseline?.incomplete ? 1 : 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`texture-budget: ${error.message}`);
    process.exitCode = 2;
}
