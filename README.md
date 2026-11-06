# Texture Budget

[![Tests](https://github.com/orangepony4/texture-budget/actions/workflows/test.yml/badge.svg)](https://github.com/orangepony4/texture-budget/actions/workflows/test.yml)

Check texture dimensions and estimate uncompressed RGBA8 memory before importing art into a game. Texture Budget scans PNG, JPEG, and WebP headers in a folder and ranks the largest textures. It runs locally without installing any package dependencies.

## Quick start

Install Node.js 20 or newer, then clone or download the repository.

```sh
git clone https://github.com/orangepony4/texture-budget.git
cd texture-budget
node bin/texture-budget.mjs "/path/to/assets"
```

Use limits to check a game asset folder in CI. This example sets a 2,048-pixel edge limit and a 128 MiB total budget, including mipmaps.

```sh
node bin/texture-budget.mjs assets --max-edge 2048 --max-total-mib 128 --mipmaps
```

Add `--json` for the complete list, totals, limit violations, unreadable headers, and skipped links. Byte counts are decimal strings so scripts can preserve exact values. Limits allow the boundary value. A texture measuring exactly 2,048 pixels on its longest edge passes a limit of 2,048.

Use `--html` to save a report you can open in a browser or share with a teammate. The report contains paths and dimensions, uses no external resources, and keeps the same exit codes as the text and JSON formats.

```sh
node bin/texture-budget.mjs assets --mipmaps --html > texture-report.html
```

![Example report for six synthetic textures, showing estimated memory and two edge-limit violations](docs/report-preview.png)

| Exit code | Meaning |
| --- | --- |
| `0` | Scan completed and the inspected images are within any supplied limits. |
| `1` | At least one limit was exceeded or an image header could not be inspected. |
| `2` | The command or the folder could not be processed. |

## How the estimate works

- The base level uses `width × height × 4` bytes. With `--mipmaps`, each dimension is halved and rounded down at every step, with a minimum of 1 pixel, until the chain reaches 1 × 1.
- The estimate treats each image as a separate RGBA8 texture. Compression, padding, atlases, animation frames, and engine import settings can change actual runtime use. For animated WebP, the estimate covers its canvas.
- The scan looks for `.png`, `.jpg`, `.jpeg`, and `.webp` extensions and identifies the format from the header. It reads stored dimensions without decoding pixels, so it does not validate the image payload. Symbolic links and junctions are skipped.
- JPEG inspection reads frame headers within the first 16 MiB and reports an error if it reaches the header scan limit. JPEG-LS and JPEG files whose dimensions are defined later in the image stream are outside the supported scope.
- Totals include images whose headers were read successfully. Review any invalid or unreadable paths before using the totals as a budget.
- Scan a stable folder. If the scanner detects a directory change during the scan, it exits with code `2`.

## Development

Run `npm test` for the CLI integration suite. The tests generate synthetic image headers and require no external services.

Released under the [MIT License](LICENSE).
