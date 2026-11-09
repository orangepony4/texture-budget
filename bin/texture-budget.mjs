#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bytesPerMiB, scanTextures } from '../src/budget.mjs';
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
    if (!(await lstat(file)).isFile()) {
        throw new Error('The baseline must be a regular JSON file.');
    }
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(file, flags);
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Error('The baseline must be a regular JSON file.');
        }
        const bytes = await handle.readFile();
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

function printReport(report) {
    const { totals, limits, exceeded, invalid, skippedLinks, files, mipmaps, baseline, groups, groupDepth } = report;
    const mode = mipmaps ? 'full mip chain' : 'base level';
    console.log(`Textures: ${totals.files}`);
    console.log(`Disk size: ${formatBytes(totals.diskBytes)}`);
    console.log(`Estimated RGBA8 (${mode}): ${formatBytes(totals.rgbaBytes)}`);
    if (files.length) {
        console.log('\nLargest textures:');
        for (const file of files.slice(0, 10)) {
            console.log(`  ${JSON.stringify(file.path)}  ${file.width} x ${file.height}  ${formatBytes(file.rgbaBytes)}`);
        }
        if (files.length > 10) console.log('  Use --json for the complete file list.');
    }
    if (groups) {
        console.log(`\nFolder totals (depth ${groupDepth}):`);
        for (const group of groups.slice(0, 10)) {
            console.log(`  ${JSON.stringify(group.path)}  ${group.files} files  ${formatBytes(group.rgbaBytes)}`);
        }
        if (!groups.length) console.log('  No readable images.');
        if (groups.length > 10) console.log('  Use --json or --html for all groups.');
    }
    if (limits.maxEdge !== null) {
        console.log(`\nEdge limit (${limits.maxEdge} px): ${exceeded.edge.length} over limit`);
        for (const path of exceeded.edge) console.log(`  ${JSON.stringify(path)}`);
    }
    if (limits.maxImageMiB !== undefined) {
        console.log(`\nPer-image limit (${limits.maxImageMiB} MiB): ${exceeded.images.length} over limit`);
        for (const path of exceeded.images) console.log(`  ${JSON.stringify(path)}`);
    }
    if (limits.maxTotalMiB !== null) {
        const result = exceeded.total ? 'exceeded' : 'within budget';
        console.log(`Total limit (${limits.maxTotalMiB} MiB): ${result}`);
    }
    if (baseline) {
        console.log(`\nBaseline RGBA8: ${formatBytes(baseline.previousRgbaBytes)}`);
        if (baseline.incomplete) console.log(incompleteComparisonNote);
        const change = baseline.incomplete ? 'Change using readable current images' : 'Change';
        console.log(`${change}: ${formatBytes(baseline.deltaRgbaBytes, true)}`);
        if (baseline.maxGrowthMiB !== null) {
            let result = baseline.growthExceeded ? 'exceeded' : 'within budget';
            if (baseline.incomplete) result = baseline.growthExceeded ? 'exceeded by readable images' : 'comparison incomplete';
            console.log(`Growth limit (${baseline.maxGrowthMiB} MiB): ${result}`);
        }
        console.log(`Added: ${baseline.added.length}, removed: ${baseline.removed.length}, changed estimates: ${baseline.changed.length}`);
        for (const { path, deltaRgbaBytes } of baseline.changed.slice(0, 10)) {
            console.log(`  ${JSON.stringify(path)}  ${formatBytes(deltaRgbaBytes, true)}`);
        }
    }
    if (invalid.length) {
        console.log(`\nInvalid or unreadable images: ${invalid.length}`);
        for (const { path, error } of invalid) console.log(`  ${JSON.stringify(path)}: ${error}`);
    }
    if (skippedLinks.length) {
        console.log(`\nSkipped links: ${skippedLinks.length}`);
        for (const path of skippedLinks) console.log(`  ${JSON.stringify(path)}`);
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
        console.log(usage);
        return 0;
    }
    if (values.version) {
        const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(version);
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
        console.log(JSON.stringify(report, null, 2));
    } else if (values.html) {
        console.log(renderHtmlReport(report));
    } else {
        printReport(report);
    }
    return report.exceeded.edge.length || report.exceeded.images?.length || report.exceeded.total || report.invalid.length ||
        report.baseline?.growthExceeded ? 1 : 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`texture-budget: ${error.message}`);
    process.exitCode = 2;
}
