const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTHS = new Map([
    [0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]],
]);
const JPEG_FRAME_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
// Skip metadata by segment length. Bound both the header span and marker work.
const JPEG_HEADER_LIMIT = 16 * 1024 * 1024;
const JPEG_MARKER_LIMIT = 4096;
const JPEG_READ_WINDOW = 4096;
const WEBP_CHUNK_LIMIT = 4096;
// PNG allows the largest dimensions of the supported formats.
export const MAX_IMAGE_DIMENSION = 0x7fff_ffff;

async function readExactly(handle, size, offset, length, label) {
    if (length > size - offset) {
        throw new Error(`Truncated ${label}.`);
    }
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
        const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
        if (bytesRead === 0) {
            throw new Error(`Truncated ${label}.`);
        }
        read += bytesRead;
    }
    return bytes;
}

function pngDimensions(header) {
    if (header.length < 33) {
        throw new Error('Truncated PNG IHDR chunk.');
    }
    if (header.readUInt32BE(8) !== 13 || header.toString('latin1', 12, 16) !== 'IHDR') {
        throw new Error('PNG must begin with a 13-byte IHDR chunk.');
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width === 0 || height === 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        throw new Error('Invalid PNG dimensions. Width and height must be between 1 and 2147483647.');
    }
    const bitDepth = header[24];
    const colorType = header[25];
    if (!PNG_BIT_DEPTHS.get(colorType)?.includes(bitDepth) || header[26] !== 0
        || header[27] !== 0 || header[28] > 1) {
        throw new Error('Invalid PNG IHDR color type, bit depth, compression, filter, or interlace method.');
    }
    return { format: 'png', width, height };
}

async function jpegDimensions(handle, size, prefix) {
    const headerEnd = Math.min(size, JPEG_HEADER_LIMIT);
    let window = prefix;
    let windowOffset = 0;

    function checkBounds(end) {
        if (end > size) {
            throw new Error('Truncated JPEG marker or segment.');
        }
        if (end > headerEnd) {
            throw new Error('JPEG frame header was not found within the first 16 MiB. Try removing metadata.');
        }
    }

    async function read(offset, length) {
        checkBounds(offset + length);
        if (offset + length > windowOffset + window.length) {
            window = await readExactly(handle, size, offset, Math.min(JPEG_READ_WINDOW, headerEnd - offset), 'JPEG header');
            windowOffset = offset;
        }
        return window.subarray(offset - windowOffset, offset - windowOffset + length);
    }

    let offset = 2;
    for (let count = 0; count < JPEG_MARKER_LIMIT; count++) {
        const markerBytes = await read(offset, 2);
        if (markerBytes[0] !== 0xff) {
            throw new Error(`Invalid JPEG marker at byte ${offset}.`);
        }
        const marker = markerBytes[1];
        if (marker === 0xff) {
            offset++;
            continue;
        }
        offset += 2;
        if (marker === 0x01) continue; // TEM has no segment length.
        if (marker === 0xd9 || marker === 0xda) {
            throw new Error('JPEG reached end of image or scan data before a frame header.');
        }
        if (marker === 0xde || marker === 0xf7) {
            throw new Error('Hierarchical JPEG and JPEG-LS are outside the supported JPEG formats.');
        }
        if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8)) {
            throw new Error(`Unexpected JPEG marker 0x${marker.toString(16)} at byte ${offset - 2}.`);
        }

        const length = (await read(offset, 2)).readUInt16BE(0);
        if (length < 2) {
            throw new Error(`Invalid JPEG segment length at byte ${offset}.`);
        }
        checkBounds(offset + length);
        if (JPEG_FRAME_MARKERS.has(marker)) {
            if (length < 8) {
                throw new Error('Invalid JPEG frame header length.');
            }
            const frame = await read(offset + 2, 6);
            const height = frame.readUInt16BE(1);
            const width = frame.readUInt16BE(3);
            const components = frame[5];
            const precision = frame[0];
            if (precision < 2 || precision > 16 || components === 0 || length !== 8 + 3 * components) {
                throw new Error('Invalid JPEG frame header precision, component count, or length.');
            }
            if (width === 0 || height === 0) {
                throw new Error('JPEG frame dimensions must be nonzero. Files with a height defined later by DNL are unsupported.');
            }
            return { format: 'jpeg', width, height };
        }
        offset += length;
    }
    throw new Error('JPEG exceeded the limit of 4096 header markers and marker padding bytes. Try removing metadata.');
}

async function webpDimensions(handle, size, prefix) {
    const riffSize = prefix.readUInt32LE(4);
    if (riffSize < 4 || riffSize > 0xffff_fff6 || riffSize % 2 !== 0) {
        throw new Error('Invalid WebP RIFF size.');
    }
    const end = riffSize + 8;
    if (end > size) {
        throw new Error('Truncated WebP file. The RIFF size exceeds the file size.');
    }

    function read(offset, length) {
        if (offset + length <= prefix.length) {
            return prefix.subarray(offset, offset + length);
        }
        return readExactly(handle, size, offset, length, 'WebP header');
    }

    let offset = 12;
    for (let count = 0; offset < end && count < WEBP_CHUNK_LIMIT; count++) {
        if (offset + 8 > end) {
            throw new Error('Truncated WebP chunk header.');
        }
        const header = await read(offset, 8);
        const type = header.toString('latin1', 0, 4);
        const length = header.readUInt32LE(4);
        const payloadOffset = offset + 8;
        offset = payloadOffset + length + length % 2;
        if (offset > end) {
            throw new Error(`Truncated WebP ${JSON.stringify(type)} chunk or padding.`);
        }
        if (type === 'VP8L') {
            if (length < 5) throw new Error('Truncated WebP VP8L image header.');
            const data = await read(payloadOffset, 5);
            const dimensions = data.readUInt32LE(1);
            if (data[0] !== 0x2f || (dimensions >>> 29) !== 0) {
                throw new Error('Invalid WebP VP8L signature or version.');
            }
            return {
                format: 'webp', width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1,
            };
        }
        if (type === 'VP8X') {
            if (length < 10) throw new Error('Truncated WebP VP8X canvas header.');
            const data = await read(payloadOffset, 10);
            const width = data.readUIntLE(4, 3) + 1;
            const height = data.readUIntLE(7, 3) + 1;
            if (width * height > 0xffff_ffff) {
                throw new Error('Invalid WebP VP8X canvas area. It exceeds 4294967295 pixels.');
            }
            return { format: 'webp', width, height };
        }
        if (type === 'VP8 ') {
            if (length < 10) throw new Error('Truncated WebP VP8 frame header.');
            const data = await read(payloadOffset, 10);
            const frameTag = data.readUIntLE(0, 3);
            const width = data.readUInt16LE(6) & 0x3fff;
            const height = data.readUInt16LE(8) & 0x3fff;
            if ((frameTag & 1) !== 0 || data.readUIntBE(3, 3) !== 0x9d012a || width === 0 || height === 0) {
                throw new Error('Invalid WebP VP8 key frame or dimensions.');
            }
            if ((frameTag >>> 5) > length - 10) {
                throw new Error('Truncated WebP VP8 frame partition.');
            }
            return { format: 'webp', width, height };
        }
    }
    if (offset < end) {
        throw new Error('WebP exceeded the limit of 4096 chunks before its image header.');
    }
    throw new Error('WebP contains no VP8, VP8L, or VP8X image header.');
}

export async function readImageDimensions(handle, size) {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('Image file size must be a non-negative safe integer.');
    }
    const prefix = await readExactly(handle, size, 0, Math.min(size, 33), 'image header');
    if (prefix.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return pngDimensions(prefix);
    }
    if (prefix[0] === 0xff && prefix[1] === 0xd8) {
        return jpegDimensions(handle, size, prefix);
    }
    if (prefix.toString('latin1', 0, 4) === 'RIFF') {
        if (prefix.length < 12) {
            throw new Error('Truncated RIFF header. Cannot identify the WebP image.');
        }
        if (prefix.toString('latin1', 8, 12) === 'WEBP') {
            return webpDimensions(handle, size, prefix);
        }
    }
    throw new Error('Unrecognized image signature. Expected PNG, JPEG, or WebP.');
}
