import { copyFile } from 'node:fs/promises';
import { testFingerprint } from '../storage/recordStore.js';
import { comparePng } from './compare.js';

/**
 * @import { TestCase, VisualCapture, VisualResult } from '../core/types.js'
 * @import { BaselineStore } from './baselines.js'
 */

/**
 * Compare every screenshot a test captured for visual testing with its approved baseline.
 * The baseline is copied next to the capture (`*.baseline.png`, plus `*.diff.png`), so a report stays
 * self-contained and shows exactly what it was compared with, even after the baseline moves on.
 * @param {{
 *   test: TestCase, captures: VisualCapture[], store: BaselineStore,
 *   maxDiffRatio: number, threshold: number,
 *   abs: (rel: string) => string, rel: (abs: string) => string,
 * }} o
 * @returns {Promise<VisualResult[]>}
 */
export async function compareCaptures({
  test,
  captures,
  store,
  maxDiffRatio,
  threshold,
  abs,
  rel,
}) {
  const fingerprint = testFingerprint(test);
  /** @type {VisualResult[]} */
  const out = [];
  for (const c of captures) {
    const base = await store.get(test.id, c.checkpoint);
    const common = { checkpoint: c.checkpoint, label: c.label, theme: c.theme, current: c.path };
    if (!base) {
      out.push({ ...common, status: 'new' });
      continue;
    }
    if (base.meta.fingerprint !== fingerprint) {
      out.push({
        ...common,
        status: 'new',
        note: 'the test changed since its baseline was approved, so this starts a new one',
      });
      continue;
    }
    const currentAbs = abs(c.path);
    const baselineCopy = currentAbs.replace(/\.png$/, '.baseline.png');
    const diffAbs = currentAbs.replace(/\.png$/, '.diff.png');
    try {
      await copyFile(base.path, baselineCopy);
      const d = await comparePng(base.path, currentAbs, diffAbs, { threshold });
      out.push({
        ...common,
        status:
          d.diffPixels === null ? 'size' : d.diffRatio > maxDiffRatio ? 'changed' : 'unchanged',
        baseline: rel(baselineCopy),
        diff: d.diffPixels ? rel(diffAbs) : undefined,
        diffRatio: d.diffRatio,
        diffPixels: d.diffPixels ?? undefined,
        box: d.box,
        note: d.baselineSize
          ? `size changed from ${d.baselineSize} to ${d.width}x${d.height}`
          : undefined,
        approvedAt: base.meta.approvedAt,
        approvedRun: base.meta.runId,
      });
    } catch (e) {
      out.push({ ...common, status: 'error', note: String(e).split('\n')[0] });
    }
  }
  return out;
}

/** Percentage for people: 0.0042 -> "0.42%". @param {number | undefined} r */
export const pct = (r) =>
  r === undefined ? '' : `${r >= 0.1 ? (r * 100).toFixed(0) : (r * 100).toFixed(2)}%`;
