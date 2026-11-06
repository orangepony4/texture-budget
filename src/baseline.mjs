import { bytesPerMiB } from './budget.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFilePath(path) {
    return typeof path === 'string'
        && !/[\x00\uD800-\uDFFF]/u.test(path)
        && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function readBaseline(report, mipmaps) {
    if (!isRecord(report) || typeof report.mipmaps !== 'boolean'
        || !Array.isArray(report.files) || !isRecord(report.totals) || !Array.isArray(report.invalid)) {
        throw new Error('Expected a complete Texture Budget JSON baseline.');
    }
    if (report.mipmaps !== mipmaps) {
        throw new Error('Baseline and current report must use the same mipmap mode.');
    }
    if (report.invalid.length > 0) {
        throw new Error('Baseline includes invalid or unreadable images.');
    }

    const files = new Map();
    let total = 0n;
    for (const file of report.files) {
        if (!isRecord(file) || !isFilePath(file.path)) {
            throw new Error('Baseline image entries require a valid relative path.');
        }
        const { path, rgbaBytes } = file;
        if (files.has(path)) {
            throw new Error(`Duplicate baseline path ${JSON.stringify(path)}.`);
        }
        if (typeof rgbaBytes !== 'string' || rgbaBytes.length === 0 || rgbaBytes.length > 20
            || rgbaBytes.startsWith('0') || /[^0-9]/.test(rgbaBytes)) {
            throw new Error(`Invalid baseline RGBA8 byte count for ${JSON.stringify(path)}.`);
        }
        const size = BigInt(rgbaBytes);
        total += size;
        files.set(path, size);
    }
    if (report.totals.rgbaBytes !== total.toString()) {
        throw new Error('Baseline RGBA8 total does not match its image entries.');
    }
    return { files, total };
}

export function compareBudgetBaseline(previous, current, { maxGrowthMiB = null } = {}) {
    const { files: remaining, total: previousTotal } = readBaseline(previous, current.mipmaps);
    const added = [];
    const changed = [];
    let currentTotal = 0n;
    for (const { path, rgbaBytes } of current.files) {
        const size = BigInt(rgbaBytes);
        currentTotal += size;
        const previousSize = remaining.get(path);
        remaining.delete(path);
        if (previousSize === undefined) {
            added.push(path);
        } else if (previousSize !== size) {
            changed.push({
                path,
                previousRgbaBytes: previousSize.toString(),
                currentRgbaBytes: rgbaBytes,
                deltaRgbaBytes: (size - previousSize).toString(),
            });
        }
    }

    const delta = currentTotal - previousTotal;
    return {
        previousRgbaBytes: previousTotal.toString(),
        deltaRgbaBytes: delta.toString(),
        added: added.sort(),
        removed: [...remaining.keys()].sort(),
        changed: changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        maxGrowthMiB,
        growthExceeded: maxGrowthMiB !== null && delta > BigInt(maxGrowthMiB) * bytesPerMiB,
    };
}
