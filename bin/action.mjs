import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { appendFile, mkdtemp, open, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./texture-budget.mjs', import.meta.url));
const limitInputs = ['max-edge', 'max-image-mib', 'max-total-mib', 'max-growth-mib', 'group-depth'];

function requireEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
}

function scanArguments(workspace) {
    const directory = resolve(workspace, requireEnvironment('INPUT_DIRECTORY'));
    const mipmaps = process.env.INPUT_MIPMAPS?.trim().toLowerCase() || 'false';
    if (mipmaps !== 'true' && mipmaps !== 'false') {
        throw new Error('The mipmaps input must be true or false.');
    }

    const args = [cli, '--json'];
    if (mipmaps === 'true') args.push('--mipmaps');
    const baseline = process.env.INPUT_BASELINE;
    if (baseline) args.push(`--baseline=${resolve(workspace, baseline)}`);
    for (const option of limitInputs) {
        const value = process.env[`INPUT_${option.toUpperCase()}`];
        if (value) args.push(`--${option}=${value}`);
    }
    args.push('--', directory);
    return args;
}

async function runScan(args, workspace, reportPath) {
    const handle = await open(reportPath, 'wx', 0o600);
    try {
        const result = spawnSync(process.execPath, args, {
            cwd: workspace,
            stdio: ['ignore', handle.fd, 'inherit'],
            shell: false,
            windowsHide: true,
        });
        if (result.error) throw result.error;
        if (result.status === 0 || result.status === 1 || result.status === 2) {
            return result.status;
        }
        throw new Error(`Unexpected CLI termination (${result.signal ?? result.status}).`);
    } finally {
        await handle.close();
    }
}

function diagnostic(message) {
    writeSync(2, `texture-budget action: ${message}\n`);
}

async function main() {
    const outputPath = process.env.GITHUB_OUTPUT;
    let reportDirectory;
    let reportPath;
    try {
        if (!outputPath) throw new Error('GITHUB_OUTPUT is required.');
        const workspace = resolve(requireEnvironment('GITHUB_WORKSPACE'));
        const args = scanArguments(workspace);
        const runnerTemp = resolve(requireEnvironment('RUNNER_TEMP'));
        if (/[\r\n]/.test(runnerTemp)) {
            throw new Error('RUNNER_TEMP cannot contain line breaks in an action output path.');
        }
        reportDirectory = await mkdtemp(join(runnerTemp, 'texture-budget-'));
        reportPath = join(reportDirectory, 'report.json');
        const status = await runScan(args, workspace, reportPath);
        if (status === 0 || status === 1) {
            if ((await stat(reportPath)).size === 0) {
                throw new Error('The CLI produced an empty report.');
            }
            await appendFile(outputPath, `report-path=${reportPath}\nexit-code=${status}\n`, 'utf8');
            if (status === 1) diagnostic('The scan reported budget violations or unreadable images. See the JSON report.');
            return status;
        }
    } catch (error) {
        diagnostic(error.message);
    }

    try {
        if (reportPath) await rm(reportPath, { force: true });
        if (reportDirectory) await rmdir(reportDirectory);
    } catch (error) {
        diagnostic(`Could not remove the unfinished report: ${error.message}`);
    }
    if (outputPath) {
        try {
            await appendFile(outputPath, 'exit-code=2\n', 'utf8');
        } catch (error) {
            diagnostic(`Could not write the exit-code output: ${error.message}`);
        }
    }
    return 2;
}

// CLI errors may include a supplied path. Keep them visible without interpreting
// any part of those diagnostics as a workflow command.
const stopToken = process.env.GITHUB_ACTIONS === 'true' ? randomUUID() : null;
if (stopToken) writeSync(2, `::stop-commands::${stopToken}\n`);
try {
    process.exitCode = await main();
} finally {
    if (stopToken) writeSync(2, `::${stopToken}::\n`);
}
