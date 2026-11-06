import { bytesPerMiB } from './budget.mjs';

const bytesPerKiB = 1024n;
const integers = new Intl.NumberFormat('en-US');
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
    return text.replace(/[&<>"']/g, character => entities[character]);
}

function hundredths(value, divisor) {
    const rounded = (value * 100n + divisor / 2n) / divisor;
    const fraction = String(rounded % 100n).padStart(2, '0');
    return `${integers.format(rounded / 100n)}.${fraction}`;
}

function sizeLabel(value, signed = false) {
    const amount = BigInt(value);
    const bytes = amount < 0n ? -amount : amount;
    const sign = amount < 0n ? '-' : signed && amount > 0n ? '+' : '';
    const exact = `${sign}${integers.format(bytes)} ${bytes === 1n ? 'byte' : 'bytes'}`;
    if (bytes < bytesPerKiB) return exact;
    const mib = bytes >= bytesPerMiB;
    const size = hundredths(bytes, mib ? bytesPerMiB : bytesPerKiB);
    return `${sign}${size} ${mib ? 'MiB' : 'KiB'}<small>${exact}</small>`;
}

const styles = `
    :root {
        color-scheme: light dark;
        --bg: #edf3f2; --surface: #ffffff; --ink: #132927; --muted: #48635f;
        --line: #cbdad6; --accent: #0e7364; --track: #dceae7;
        --warning: #9e381a; --warning-bg: #fff1e8;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; background: var(--bg); color: var(--ink);
        font: 1rem/1.55 system-ui, sans-serif;
    }
    main { width: min(76rem, 100% - 2rem); margin: 2rem auto 4rem; }
    header, section { padding: clamp(1rem, 3vw, 1.85rem); border-radius: 1rem; }
    header { background: #113832; color: #f4fbf8; }
    header p { color: #cce9df; }
    .eyebrow {
        margin: 0; color: #a7ebd6; font-size: .75rem; font-weight: 700;
        letter-spacing: .12em; text-transform: uppercase;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(2rem, 6vw, 3.4rem); line-height: 1.15; margin: .35rem 0 .65rem; }
    h2 { font-size: 1.3rem; margin-bottom: .6rem; }
    h3 { font-size: 1rem; margin-bottom: .4rem; }
    p + p { margin-top: .45rem; }
    section { margin-top: 1rem; background: var(--surface); border: 1px solid var(--line); }
    .summary {
        display: grid; gap: .8rem; margin: 1rem 0 0;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    }
    .summary div { background: var(--surface); border: 1px solid var(--line); padding: 1rem 1.2rem; border-radius: .8rem; }
    dt, .note, small { color: var(--muted); }
    dd { margin: .3rem 0 0; font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
    small { display: block; font-size: .8rem; font-weight: 400; white-space: nowrap; }
    ul { margin: .4rem 0 0; padding-inline-start: 1.4rem; }
    li + li { margin-top: .3rem; }
    details { margin-top: .55rem; }
    details summary { cursor: pointer; font-weight: 600; }
    .baseline-totals { display: flex; flex-wrap: wrap; gap: 1rem 2rem; margin: .5rem 0; }
    .flag {
        display: inline-block; border-radius: .35rem; padding: .08rem .45rem;
        background: var(--warning-bg); color: var(--warning); font-weight: 650; font-size: .8rem;
    }
    .table-wrap { overflow-x: auto; margin-top: .65rem; }
    .table-wrap:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    table { width: 100%; min-width: 42rem; border-collapse: collapse; text-align: start; }
    caption { text-align: start; color: var(--muted); margin: 0 0 .6rem; }
    th, td { padding: .7rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; text-align: start; }
    thead th { color: var(--muted); font-size: .86rem; }
    tbody th { width: 42%; font-weight: 500; }
    .number { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bar { height: .28rem; margin-top: .35rem; border-radius: 1rem; overflow: hidden; background: var(--track); }
    .bar span { display: block; height: 100%; background: var(--accent); }
    code { overflow-wrap: anywhere; white-space: pre-wrap; font: .9em ui-monospace, monospace; }
    .notes { margin-top: 1rem; }
    @media (prefers-color-scheme: dark) {
        :root {
            --bg: #101c1b; --surface: #182725; --ink: #e9f5f0; --muted: #b8ccc7;
            --line: #37524d; --accent: #74dfc8; --track: #354d48;
            --warning: #ffc1a6; --warning-bg: #46291f;
        }
    }
    @media print {
        :root {
            color-scheme: light;
            --bg: #fff; --surface: #fff; --ink: #111; --muted: #333; --line: #bbb;
            --warning: #6b2010; --warning-bg: #fff;
        }
        main { width: 100%; margin: 0; }
        header { background: #fff; color: #111; border: 1px solid var(--line); }
        header p, header .eyebrow { color: #333; }
        section, header { padding: .8rem; }
        .bar { display: none; }
        .table-wrap { overflow: visible; }
        table { min-width: 0; }
        thead { display: table-header-group; }
        tr, .summary div { break-inside: avoid; }
    }
`;

function listPaths(paths) {
    return paths.map(path => `<li><code><bdi>${escapeHtml(path)}</bdi></code></li>`).join('');
}

function renderBaseline(baseline) {
    if (!baseline) return '';
    const growth = baseline.maxGrowthMiB === null ? '' : `
        <p>Growth limit <strong>${integers.format(baseline.maxGrowthMiB)} MiB</strong>
            <span class="${baseline.growthExceeded ? 'flag' : 'note'}">${baseline.growthExceeded ? 'Exceeded' : 'Within budget'}</span>
        </p>`;
    const changes = baseline.changed.map(({ path, deltaRgbaBytes }) =>
        `<li><code><bdi>${escapeHtml(path)}</bdi></code> · ${sizeLabel(deltaRgbaBytes, true)}</li>`
    ).join('');
    const details = [
        ['Added images', baseline.added.length, listPaths(baseline.added)],
        ['Removed images', baseline.removed.length, listPaths(baseline.removed)],
        ['Changed estimates', baseline.changed.length, changes],
    ].filter(([, count]) => count > 0).map(([label, count, items]) =>
        `<details><summary>${label} (${integers.format(count)})</summary><ul>${items}</ul></details>`
    ).join('');
    return `
    <section aria-labelledby="baseline">
        <h2 id="baseline">Baseline comparison</h2>
        <dl class="baseline-totals">
            <div><dt>Previous RGBA8</dt><dd>${sizeLabel(baseline.previousRgbaBytes)}</dd></div>
            <div><dt>Change</dt><dd>${sizeLabel(baseline.deltaRgbaBytes, true)}</dd></div>
        </dl>
        ${growth}
        ${details || '<p class="note">No image budget changes.</p>'}
    </section>`;
}

function renderFolderTotals(groups, depth, totalBytes) {
    if (!groups) return '';
    const total = BigInt(totalBytes);
    const rows = groups.map(group => `
        <tr>
            <th scope="row"><code><bdi>${escapeHtml(group.path)}</bdi></code></th>
            <td class="number">${integers.format(group.files)}</td>
            <td class="number">${sizeLabel(group.diskBytes)}</td>
            <td class="number">${sizeLabel(group.rgbaBytes)}</td>
            <td class="number">${hundredths(BigInt(group.rgbaBytes) * 100n, total)}%</td>
        </tr>`
    ).join('');
    return `
    <section aria-labelledby="folder-totals">
        <h2 id="folder-totals">Folder totals</h2>
        ${rows ? `
        <div class="table-wrap" role="region" aria-label="Folder totals table" tabindex="0">
            <table>
                <caption>Grouped by up to ${integers.format(depth)} parent levels. A dot represents files at the root.</caption>
                <thead><tr>
                    <th scope="col">Folder</th><th scope="col">Images</th>
                    <th scope="col">Disk size</th><th scope="col">RGBA8 estimate</th>
                    <th scope="col">Share of estimate</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>` : '<p class="note">No readable images were found.</p>'}
    </section>`;
}

export function renderHtmlReport(report) {
    const { files, totals, limits, exceeded, invalid, skippedLinks, mipmaps, baseline, groups, groupDepth } = report;
    const maxBytes = BigInt(files[0]?.rgbaBytes ?? 0);
    const overEdge = new Set(exceeded.edge);
    const rows = files.map((file, index) => {
        const share = maxBytes === 0n ? '0' : hundredths(BigInt(file.rgbaBytes) * 100n, maxBytes);
        return `
            <tr>
                <td class="number">${index + 1}</td>
                <th scope="row"><code><bdi>${escapeHtml(file.path)}</bdi></code></th>
                <td>${escapeHtml(file.format.toUpperCase())}</td>
                <td class="number">${integers.format(file.width)} × ${integers.format(file.height)}
                    ${overEdge.has(file.path) ? '<br><span class="flag">Over edge limit</span>' : ''}
                </td>
                <td class="number">${sizeLabel(file.diskBytes)}</td>
                <td class="number">${sizeLabel(file.rgbaBytes)}
                    <div class="bar" aria-hidden="true"><span style="width: ${share}%"></span></div>
                </td>
            </tr>`;
    }).join('');
    const edgeBudget = limits.maxEdge === null ? '' : `
        <li>Maximum edge <strong>${integers.format(limits.maxEdge)} px</strong>
            <span class="${exceeded.edge.length ? 'flag' : 'note'}">${integers.format(exceeded.edge.length)} over limit</span>
        </li>`;
    const totalBudget = limits.maxTotalMiB === null ? '' : `
        <li>Total RGBA8 budget <strong>${integers.format(limits.maxTotalMiB)} MiB</strong>
            <span class="${exceeded.total ? 'flag' : 'note'}">${exceeded.total ? 'Exceeded' : 'Within budget'}</span>
        </li>`;
    const issues = invalid.map(({ path, error }) =>
        `<li><code><bdi>${escapeHtml(path)}</bdi></code> · ${escapeHtml(error)}</li>`
    ).join('');
    const links = listPaths(skippedLinks);

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>Texture Budget Report</title>
    <style>${styles}</style>
</head>
<body>
<main>
    <header>
        <p class="eyebrow">Asset inventory</p>
        <h1>Texture Budget</h1>
        <p>RGBA8 estimate · ${mipmaps ? 'Full mip chain down to 1 × 1' : 'Base level only'}</p>
    </header>
    <dl class="summary" aria-label="Scan totals">
        <div><dt>Images measured</dt><dd>${integers.format(totals.files)}</dd></div>
        <div><dt>Disk size</dt><dd>${sizeLabel(totals.diskBytes)}</dd></div>
        <div><dt>Estimated RGBA8</dt><dd>${sizeLabel(totals.rgbaBytes)}</dd></div>
    </dl>
    <section aria-labelledby="budgets">
        <h2 id="budgets">Budgets</h2>
        ${edgeBudget || totalBudget ? `<ul>${edgeBudget}${totalBudget}</ul>` : '<p class="note">No limits supplied.</p>'}
    </section>
    ${renderBaseline(baseline)}
    ${renderFolderTotals(groups, groupDepth, totals.rgbaBytes)}
    <section aria-labelledby="ranked">
        <h2 id="ranked">Ranked images</h2>
        ${rows ? `
        <div class="table-wrap" role="region" aria-label="Ranked image table" tabindex="0">
            <table>
                <caption>Largest RGBA8 estimate first. Bars are relative to the largest image.</caption>
                <thead><tr>
                    <th scope="col">Rank</th><th scope="col">Path</th><th scope="col">Format</th>
                    <th scope="col">Dimensions</th><th scope="col">Disk size</th><th scope="col">RGBA8 estimate</th>
                </tr></thead>
                <tbody>${rows}
                </tbody>
            </table>
        </div>` : '<p class="note">No readable images were found.</p>'}
    </section>
    <section aria-labelledby="issues">
        <h2 id="issues">Scan issues</h2>
        <h3>Invalid or unreadable images (${integers.format(invalid.length)})</h3>
        ${issues ? `<ul>${issues}</ul>` : '<p class="note">None.</p>'}
        <h3 class="notes">Skipped links (${integers.format(skippedLinks.length)})</h3>
        ${links ? `<ul>${links}</ul>` : '<p class="note">None.</p>'}
    </section>
    <p class="note notes">RGBA8 uses four bytes per pixel. Runtime allocation also depends on import settings and GPU formats.</p>
</main>
</body>
</html>`;
}
