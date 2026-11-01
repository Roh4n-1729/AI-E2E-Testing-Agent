import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesAccept, pickUpload } from '../src/browser/uploads.js';

describe('choosing a file for a file picker', () => {
  it('matches accept tokens by extension, exact type and wildcard', () => {
    expect(matchesAccept('a/sample.png', 'image/*')).toBe(true);
    expect(matchesAccept('a/sample.png', '.PNG')).toBe(true);
    expect(matchesAccept('a/sample.jpg', 'image/jpeg')).toBe(true);
    expect(matchesAccept('a/sample.jpg', '.jpeg')).toBe(false);
    expect(matchesAccept('a/sample.jpg', '.jpg')).toBe(true);
    expect(matchesAccept('a/sample.pdf', 'image/*')).toBe(false);
    expect(matchesAccept('a/sample.csv', 'text/csv')).toBe(true);
    expect(matchesAccept('a/sample.txt', 'text/*')).toBe(true);
  });

  it('picks a bundled sample that fits, an image when nothing is asked, and nothing for a type it lacks', () => {
    expect(path.basename(/** @type {string} */ (pickUpload('image/*')))).toBe('sample.jpg');
    expect(path.basename(/** @type {string} */ (pickUpload('image/png')))).toBe('sample.png');
    expect(path.basename(/** @type {string} */ (pickUpload('.pdf,.docx')))).toBe('sample.pdf');
    expect(path.basename(/** @type {string} */ (pickUpload('.csv')))).toBe('sample.csv');
    expect(path.basename(/** @type {string} */ (pickUpload('')))).toMatch(/^sample\.(jpg|png)$/);
    expect(pickUpload('video/*')).toBeNull();
  });

  it('prefers your own folder (AIE2E_UPLOAD_DIR), which also covers types the samples lack', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aie2e-files-'));
    writeFileSync(path.join(dir, 'clip.mp4'), 'x');
    writeFileSync(path.join(dir, 'photo.png'), 'x');
    expect(path.basename(/** @type {string} */ (pickUpload('video/*', { dir })))).toBe('clip.mp4');
    expect(pickUpload('image/*', { dir })).toBe(path.join(dir, 'photo.png'));
    expect(path.basename(/** @type {string} */ (pickUpload('.pdf', { dir })))).toBe('sample.pdf');
  });
});
