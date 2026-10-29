import { readFile, writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** colour pixelmatch paints differing pixels with; also how the changed area is found again */
const DIFF_RGB = /** @type {[number, number, number]} */ ([230, 40, 60]);

/**
 * @typedef {object} PixelDiff
 * @property {number} width
 * @property {number} height
 * @property {number | null} diffPixels  null when the sizes differ (nothing comparable)
 * @property {number} diffRatio  differing pixels / all pixels (1 when the sizes differ)
 * @property {{ x: number, y: number, width: number, height: number }} [box]  where the change is
 * @property {string} [baselineSize]  "WxH" when it differs from the current screenshot
 */

/**
 * Compare two PNGs pixel by pixel (pixelmatch, anti-aliasing ignored) and write a diff image:
 * the baseline faded out, differing pixels in red.
 * @param {string} baselinePath @param {string} currentPath @param {string} diffPath
 * @param {{ threshold?: number }} [o]  per-pixel colour tolerance, 0..1
 * @returns {Promise<PixelDiff>}
 */
export async function comparePng(baselinePath, currentPath, diffPath, { threshold = 0.02 } = {}) {
  const [rawA, rawB] = await Promise.all([readFile(baselinePath), readFile(currentPath)]);
  // Chromium renders the same page to the same bytes: the common case needs no decoding at all
  if (rawA.equals(rawB)) {
    // width and height sit at fixed offsets of the PNG header (IHDR)
    return {
      width: rawB.readUInt32BE(16),
      height: rawB.readUInt32BE(20),
      diffPixels: 0,
      diffRatio: 0,
    };
  }
  const [a, b] = [PNG.sync.read(rawA), PNG.sync.read(rawB)];
  if (!a || !b) throw new Error('could not read the screenshots');
  if (a.width !== b.width || a.height !== b.height) {
    return {
      width: b.width,
      height: b.height,
      diffPixels: null,
      diffRatio: 1,
      baselineSize: `${a.width}x${a.height}`,
    };
  }
  const { width, height } = a;
  const diff = new PNG({ width, height });
  const n = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.25,
    diffColor: DIFF_RGB,
  });
  if (n) await writeFile(diffPath, PNG.sync.write(diff)); // only worth an image when something changed
  return {
    width,
    height,
    diffPixels: n,
    diffRatio: n / (width * height),
    box: n ? boxOf(diff) : undefined,
  };
}

/** Bounding box of the pixels pixelmatch marked as different. @param {PNG} diff */
function boxOf(diff) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  const { width, height, data } = diff;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === DIFF_RGB[0] && data[i + 1] === DIFF_RGB[1] && data[i + 2] === DIFF_RGB[2]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  return x1 < 0 ? undefined : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
