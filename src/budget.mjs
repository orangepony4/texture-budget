import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { readImageDimensions } from './image-dimensions.mjs';

const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const statOptions = { bigint: true };
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const bytesPerMiB = 1024n * 1024n;

function rgbaBytes(width, height, mipmaps) {
    let pixels = BigInt(width) * BigInt(height);
    if (mipmaps) {
        while (width > 1 || height > 1) {
            width = Math.max(1, Math.floor(width / 2));
            height = Math.max(1, Math.floor(height / 2));
            pixels += BigInt(width) * BigInt(height);
        }
    }
    return pixels * 4n;
}

function checkFileUnchanged(before, after) {
    if (!after.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(
        field => before[field] !== after[field]
    )) {
        throw new Error('File changed while it was being read.');
    }
}

async function inspectFile(location, path, stat, mipmaps) {
    if (!stat.isFile()) {
        throw new Error('Expected a regular image file.');
    }
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('File is too large to inspect.');
    }
    const file = await open(location, readFlags);
    try {
        checkFileUnchanged(stat, await file.stat(statOptions));
        const { format, width, height } = await readImageDimensions(file, Number(stat.size));
        checkFileUnchanged(stat, await file.stat(statOptions));
        checkFileUnchanged(stat, await lstat(location, statOptions));
        return { path, format, width, height, diskBytes: stat.size, rgbaBytes: rgbaBytes(width, height, mipmaps) };
    } finally {
        await file.close();
    }
}

async function* walkTextures(directory, parentPath = '') {
    const entries = await readdir(directory, { withFileTypes: true, encoding: 'buffer' });
    for (const entry of entries) {
        const name = entry.name.toString('utf8');
        if (!Buffer.from(name).equals(entry.name)) {
            throw new Error(`Directory ${JSON.stringify(parentPath || '.')} contains a name that is invalid UTF-8.`);
        }
        const imageExtension = extensions.has(extname(name).toLowerCase());
        if (!imageExtension && !entry.isDirectory() && !entry.isSymbolicLink()) {
            continue;
        }
        const location = join(directory, name);
        const path = parentPath ? `${parentPath}/${name}` : name;
        const stat = await lstat(location, statOptions);
        if (stat.isSymbolicLink()) {
            yield { location, path, stat };
        } else if (stat.isDirectory()) {
            yield* walkTextures(location, path);
        } else if (imageExtension) {
            yield { location, path, stat };
        }
    }
}

function comparePaths(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

export async function scanTextures(root, { mipmaps = false, maxEdge = null, maxTotalMiB = null } = {}) {
    if (!(await lstat(root)).isDirectory()) {
        throw new Error('The scan root must be a regular directory.');
    }
    const files = [];
    const invalid = [];
    const skippedLinks = [];
    const exceeded = { edge: [], total: false };
    let diskBytes = 0n;
    let estimatedBytes = 0n;

    for await (const { location, path, stat } of walkTextures(root)) {
        if (stat.isSymbolicLink()) {
            skippedLinks.push(path);
            continue;
        }
        try {
            const image = await inspectFile(location, path, stat, mipmaps);
            files.push(image);
            diskBytes += image.diskBytes;
            estimatedBytes += image.rgbaBytes;
            if (maxEdge !== null && Math.max(image.width, image.height) > maxEdge) {
                exceeded.edge.push(path);
            }
        } catch (error) {
            const message = error.code ? `Could not read image (${error.code}).` : error.message;
            invalid.push({ path, error: message });
        }
    }

    files.sort((a, b) => {
        if (a.rgbaBytes === b.rgbaBytes) return comparePaths(a.path, b.path);
        return a.rgbaBytes > b.rgbaBytes ? -1 : 1;
    });
    invalid.sort((a, b) => comparePaths(a.path, b.path));
    skippedLinks.sort(comparePaths);
    exceeded.edge.sort(comparePaths);
    exceeded.total = maxTotalMiB !== null && estimatedBytes > BigInt(maxTotalMiB) * bytesPerMiB;

    return {
        files: files.map(file => ({
            ...file,
            diskBytes: file.diskBytes.toString(),
            rgbaBytes: file.rgbaBytes.toString(),
        })),
        totals: { files: files.length, diskBytes: diskBytes.toString(), rgbaBytes: estimatedBytes.toString() },
        limits: { maxEdge, maxTotalMiB },
        exceeded,
        invalid,
        skippedLinks,
        mipmaps,
    };
}
