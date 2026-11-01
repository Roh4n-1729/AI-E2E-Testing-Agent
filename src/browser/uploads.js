import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * File uploads with no person at the keyboard. When the page opens a file picker (an `<input type=file>` is
 * clicked, however: by the agent, by a replayed step, by a drop zone's own script), Playwright's `filechooser`
 * event fires instead of the system dialog, and the harness answers it with a sample file that fits the input's
 * `accept` list. So upload flows run headless, in CI and on the deployed instance, and a replay answers the same
 * picker the same way.
 *
 * Samples ship in `assets/uploads` (an image as PNG and JPEG, a PDF, CSV, text and JSON). Files in
 * AIE2E_UPLOAD_DIR come first, for apps that need their own kind of file (a video, a .docx, a real invoice).
 *
 * @import { FileChooser } from 'playwright'
 * @import { UploadRecord } from '../core/types.js'
 */

export const SAMPLE_DIR = fileURLToPath(new URL('../../assets/uploads/', import.meta.url));

/** Extension -> MIME type, for matching an `accept` list like "image/*,.pdf". */
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  md: 'text/markdown',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  zip: 'application/zip',
};

/** @param {string} file */
const extOf = (file) => path.extname(file).slice(1).toLowerCase();

/**
 * Does a file satisfy one `accept` token (".png", "image/*", "image/png")?
 * @param {string} file @param {string} token
 */
export function matchesAccept(file, token) {
  const t = token.trim().toLowerCase();
  if (!t) return false;
  const ext = extOf(file);
  if (t.startsWith('.')) return t.slice(1) === ext || (t === '.jpg' && ext === 'jpeg');
  const mime = MIME[/** @type {keyof typeof MIME} */ (ext)];
  if (!mime) return false;
  if (t.endsWith('/*')) return mime.startsWith(t.slice(0, -1));
  return mime === t || (t === 'image/jpg' && mime === 'image/jpeg');
}

/** @param {string} dir */
const filesIn = (dir) => {
  try {
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile() && !d.name.startsWith('.'))
          .map((d) => path.join(dir, d.name))
          .sort()
      : [];
  } catch {
    return [];
  }
};

/**
 * The file to give a picker: the first file (your folder first, then the samples) that fits its `accept` list.
 * With no `accept`, an image: most uploads in web apps are pictures.
 * @param {string | null | undefined} accept  the input's accept attribute
 * @param {{ dir?: string, sampleDir?: string }} [opts]
 * @returns {string | null}
 */
export function pickUpload(accept, opts = {}) {
  const tokens = (accept ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const wanted = tokens.length ? tokens : ['image/*'];
  const candidates = [
    ...(opts.dir ? filesIn(opts.dir) : []),
    ...filesIn(opts.sampleDir ?? SAMPLE_DIR),
  ];
  for (const token of wanted)
    for (const file of candidates) if (matchesAccept(file, token)) return file;
  return null;
}

/**
 * Answer a file picker with a fitting file, and say what happened. Never throws: an unanswered picker leaves the
 * page waiting, which the agent sees and the evidence shows.
 * @param {FileChooser} chooser @param {{ dir?: string }} [opts]
 * @returns {Promise<UploadRecord>}
 */
export async function answerFileChooser(chooser, opts = {}) {
  const accept = await chooser
    .element()
    .getAttribute('accept')
    .catch(() => null);
  const ts = new Date().toISOString();
  const file = pickUpload(accept, opts);
  if (!file)
    return {
      accept: accept ?? '',
      ts,
      error: `no sample file fits "${accept}": add one to AIE2E_UPLOAD_DIR`,
    };
  try {
    await chooser.setFiles(file);
    return { accept: accept ?? '', file: path.basename(file), ts };
  } catch (e) {
    return {
      accept: accept ?? '',
      file: path.basename(file),
      ts,
      error: `could not set the file: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    };
  }
}
