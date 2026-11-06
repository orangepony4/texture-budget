export function groupTextures(files, depth) {
    if (!Number.isSafeInteger(depth) || depth < 1) {
        throw new RangeError('Folder group depth must be a positive safe integer.');
    }

    const groups = new Map();
    for (const { path, diskBytes, rgbaBytes } of files) {
        const folders = path.split('/');
        folders.pop();
        const groupPath = folders.slice(0, depth).join('/') || '.';

        let group = groups.get(groupPath);
        if (!group) {
            group = { path: groupPath, files: 0, diskBytes: 0n, rgbaBytes: 0n };
            groups.set(groupPath, group);
        }
        group.files++;
        group.diskBytes += BigInt(diskBytes);
        group.rgbaBytes += BigInt(rgbaBytes);
    }

    return [...groups.values()]
        .sort((a, b) => {
            if (a.rgbaBytes !== b.rgbaBytes) return a.rgbaBytes > b.rgbaBytes ? -1 : 1;
            return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
        })
        .map(group => ({
            ...group,
            diskBytes: group.diskBytes.toString(),
            rgbaBytes: group.rgbaBytes.toString(),
        }));
}
