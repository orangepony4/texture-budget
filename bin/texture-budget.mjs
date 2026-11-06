#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bytesPerMiB, scanTextures } from '../src/budget.mjs';

const usage = `Usage:
  texture-budget <folder> [--json] [--mipmaps] [--max-edge <pixels>] [--max-total-mib <MiB>]

Scan PNG, JPEG and WebP headers and estimate uncompressed RGBA8 texture memory.

Options:
  --mipmaps               Include all mip levels down to 1 x 1.
  --max-edge <pixels>      Fail if an image exceeds this width or height.
  --max-total-mib <MiB>    Fail if the total estimate exceeds this budget.
  --json                  Print every file and result as JSON.
  -h, --help              Show this help.
  -v, --version           Show the installed version.`;

function parseLimit(value, option) {
    if (value === undefined) return null;
    const limit = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`${option} requires a positive integer.`);
    }
    return limit;
}

function formatBytes(value) {
    const bytes = BigInt(value);
    const hundredths = (bytes * 100n + bytesPerMiB / 2n) / bytesPerMiB;
    const fraction = String(hundredths % 100n).padStart(2, '0');
    return `${hundredths / 100n}.${fraction} MiB (${bytes} bytes)`;
}

function printReport(report) {
    const { totals, limits, exceeded, invalid, skippedLinks, files, mipmaps } = report;
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
    if (limits.maxEdge !== null) {
        console.log(`\nEdge limit (${limits.maxEdge} px): ${exceeded.edge.length} over limit`);
        for (const path of exceeded.edge) console.log(`  ${JSON.stringify(path)}`);
    }
    if (limits.maxTotalMiB !== null) {
        const result = exceeded.total ? 'exceeded' : 'within budget';
        console.log(`Total limit (${limits.maxTotalMiB} MiB): ${result}`);
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
            mipmaps: { type: 'boolean' },
            'max-edge': { type: 'string' },
            'max-total-mib': { type: 'string' },
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
    const report = await scanTextures(resolve(positionals[0]), {
        mipmaps: values.mipmaps ?? false,
        maxEdge: parseLimit(values['max-edge'], '--max-edge'),
        maxTotalMiB: parseLimit(values['max-total-mib'], '--max-total-mib'),
    });
    if (values.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printReport(report);
    }
    return report.exceeded.edge.length || report.exceeded.total || report.invalid.length ? 1 : 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`texture-budget: ${error.message}`);
    process.exitCode = 2;
}
