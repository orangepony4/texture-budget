import { bytesPerMiB, estimateRgbaBytes } from './budget.mjs';
import { MAX_IMAGE_DIMENSION } from './image-dimensions.mjs';

export const incompleteComparisonNote = 'Baseline comparison is incomplete. The current estimate includes readable images only.';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFilePath(path) {
    return typeof path === 'string'
        && !/[\x00\uD800-\uDFFF]/u.test(path)
        && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function isImageDimension(value) {
    return Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_DIMENSION;
}

function hasSkippedLink(path, skippedLinks) {
    let end = path.length;
    while (end > 0) {
        if (skippedLinks.has(path.slice(0, end))) return true;
        end = path.lastIndexOf('/', end - 1);
    }
    return false;
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
        const { path, width, height, rgbaBytes } = file;
        if (files.has(path)) {
            throw new Error(`Duplicate baseline path ${JSON.stringify(path)}.`);
        }
        if (!isImageDimension(width) || !isImageDimension(height)) {
            throw new Error(`Invalid baseline image dimensions for ${JSON.stringify(path)}.`);
        }
        const size = estimateRgbaBytes(width, height, mipmaps);
        if (rgbaBytes !== size.toString()) {
            throw new Error(`Baseline RGBA8 byte count for ${JSON.stringify(path)} does not match its dimensions and mipmap mode.`);
        }
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

    const invalid = current.invalid ?? [];
    for (const { path } of invalid) remaining.delete(path);

    const skippedLinks = new Set(current.skippedLinks ?? []);
    let incomplete = invalid.length > 0;
    const removed = [];
    for (const path of remaining.keys()) {
        if (skippedLinks.size && hasSkippedLink(path, skippedLinks)) incomplete = true;
        else removed.push(path);
    }

    const delta = currentTotal - previousTotal;
    return {
        previousRgbaBytes: previousTotal.toString(),
        deltaRgbaBytes: delta.toString(),
        added: added.sort(),
        removed: removed.sort(),
        changed: changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
        maxGrowthMiB,
        growthExceeded: maxGrowthMiB !== null && delta > BigInt(maxGrowthMiB) * bytesPerMiB,
        ...(incomplete ? { incomplete: true } : {}),
    };
}
