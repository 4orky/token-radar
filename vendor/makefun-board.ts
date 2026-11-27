// A dossier (makefun/dossier/v1) is the judge-readable summary of one dashboard
// directory: the screenshots in dir/screenshots/ plus a capped text rendering of
// the page's source files in dir/dashboard/. This file is a from-scratch rewrite
// of the vendored make.fun helper; it keeps the exact same outward contract so
// the scorer, which runs this file byte for byte over the submitted tree and
// compares its output with the dossier.json we hand in, sees identical bytes.
//
// What a dossier holds:
//   schema  always "makefun/dossier/v1"
//   cover   always 0, the first screenshot in name order
//   images  every non-hidden regular file in screenshots/, name order, each with
//           its name, media type, sha256 and base64 body
//   text    a "## Dashboard" inventory, then a "## Source" section per text file:
//           heading, byte and line counts, and the file body inside a fence whose
//           length beats the longest backtick run in the body. Only files with a
//           source extension (.html .css .js .json .mjs .svg .md .txt) get a body;
//           anything else is listed in the inventory and nowhere else.
//
// The text is trimmed to caps.text_max_bytes UTF-8 bytes: whole files in path
// order while they fit; the first file that does not fit whole contributes its
// heading plus as many complete lines as fit, then a note saying how many of
// its lines were dropped; the tail is one final line saying how many whole
// files and how many bytes never made it in. Every other cap only refuses —
// it never changes a byte — so a run that passes just {text_max_bytes} and
// writes the result has written exactly what the scorer reproduces.
//
// Anything the directory or the caps forbid raises DossierError; nothing is
// written in that case. Only the Node standard library is used, and the file
// is plain erasable TypeScript: `node main.ts` runs it with no flags.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join as joinPath } from "node:path";

/** Schema tag stamped on every dossier this module writes. */
export const DOSSIER_SCHEMA = "makefun/dossier/v1";
/** Hard ceiling on a finished dossier: four mebibytes. */
export const DOSSIER_MAX_BYTES = 1024 * 1024 * 4;
/** Hard ceiling on the images a dossier may carry. */
export const DOSSIER_MAX_IMAGES = 8; // at most eight images per dossier
/** A file name a dossier accepts: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them, no directory. */
export const PLAIN_NAME = new RegExp("^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$");
/** Extensions whose file bodies the dossier text reproduces: source, never an image. */
export const TEXT_FILE = new RegExp("\\.(?:html|css|js|json|mjs|svg|md|txt)$");

/** Raised whenever a directory or a cap forbids building a dossier at all. */
export class DossierError extends Error { // no dossier is produced on this path
  constructor(detail: string) {
    super(detail);
    this.name = "DossierError";
  }
}

/** Limits for one buildDossier call: a byte budget for the text, plus optional refuse-only caps. */
export interface DossierCaps { // caps for one buildDossier call
  text_max_bytes: number; // UTF-8 byte budget for the dossier text
  screenshots?: {max: number; max_bytes: number};
  dashboard?: {max_files: number; max_bytes: number};
}

// ---- tiny utilities ----

const utf8Len = (text: string): number => Buffer.byteLength(text, "utf8");
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const hashHex = (blob: Uint8Array): string => createHash("sha256").update(blob).digest("hex");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

const startsWithBytes = (blob: Uint8Array, prefix: readonly number[]): boolean => {
  if (blob.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (blob[i] !== prefix[i]) return false;
  }
  return true;
};

/** How many lines `bytes` holds: none when empty, otherwise newlines plus a final unterminated line. */
const countLines = (bytes: Uint8Array): number => {
  let breaks = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) breaks += 1;
  }
  return bytes.length === 0 ? 0 : bytes[bytes.length - 1] === 0x0a ? breaks : breaks + 1;
};

/** A fence that cannot be closed early by `text`: one backtick past its longest run, at least three. */
const fenceForBody = (text: string): string => {
  let peakRun = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > peakRun) peakRun = run;
    } else {
      run = 0;
    }
  }
  const wanted = peakRun + 1;
  return "`".repeat(wanted < 3 ? 3 : wanted);
};

/** Which language tag opens a file's fence: its extension, with mjs spelled js. */
const fenceLanguage = (file: string): string => {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  return ext === "mjs" ? "js" : ext;
};

/**
 * One canonical spelling for a JSON value: object keys sorted by code unit, no
 * spaces anywhere. Accepts null, booleans, finite numbers, strings, arrays and
 * plain objects only; anything else (undefined, functions, bigints, NaN,
 * Infinity, class instances) throws a TypeError naming the problem.
 */
export function canonicalJson(input: unknown): string {
  if (input === null) return "null";
  const kind = typeof input;
  if (kind === "boolean" || kind === "string") return JSON.stringify(input as boolean | string);
  if (kind === "number") {
    if (Number.isFinite(input) === false) {
      throw new TypeError("canonicalJson: " + String(input) + " is not a finite number");
    }
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return "[" + input.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (kind === "object") {
    const parentProto = Object.getPrototypeOf(input);
    if (parentProto !== Object.prototype && parentProto !== null) {
      throw new TypeError("canonicalJson: only plain objects and arrays");
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  throw new TypeError("canonicalJson: a " + kind + " has no JSON form");
}

// ---- reading one file, bounded ----

/**
 * Reads `file` whole, but only when it is a plain file no longer than `cap`
 * bytes, and never by following a symlink: the open uses O_NOFOLLOW and the
 * size is re-checked after opening, so a file that grows mid-read is refused
 * rather than half-read. Anything else fails as a DossierError naming `what`.
 */
function loadBounded(file: string, cap: number, what: string): Uint8Array {
  let claimed: number;
  try {
    const info = lstatSync(file);
    if (info.isFile() === false) {
      throw new DossierError("buildDossier: " + what + " is not a regular file");
    }
    claimed = info.size;
  } catch (caught) {
    if (caught instanceof DossierError) {
      throw caught;
    }
    throw new DossierError("buildDossier: " + what + " cannot be read");
  }
  if (claimed > cap) {
    throw new DossierError("buildDossier: " + what + " is " + claimed + " bytes, over the " + cap + " a dossier reads");
  }
  let handle: number;
  try {
    handle = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new DossierError("buildDossier: " + what + " is not a regular file");
  }
  try {
    const present = fstatSync(handle).size;
    if (present > cap) {
      throw new DossierError("buildDossier: " + what + " is " + present + " bytes, over the " + cap + " a dossier reads");
    }
    const buf = Buffer.alloc(present);
    let filled = 0;
    while (filled < buf.length) {
      const got = readSync(handle, buf, filled, buf.length - filled, filled);
      if (got === 0) break;
      filled += got;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, filled);
  } finally { // the descriptor is released on every exit, success or refusal
    closeSync(handle);
  }
}

// ---- walking the dashboard tree ----

/** One file found under the dashboard root: path relative to it, plus byte size. */
interface ListedFile {
  rel: string;
  bytes: number;
}

/**
 * Lists every plain file below `root`, sorted by relative path. Symlinks are
 * skipped as files and never followed as directories. A hidden directory, a
 * file name outside the accepted alphabet, or an entry that is neither file
 * nor directory is refused at once; when `limits` is given, so are a tree with
 * too many files or too many bytes in total. Note the walk is depth-first with
 * a stack, so when several entries are bad the first refusal follows that
 * traversal order, not path order.
 */
function collectDashboard(root: string, limits: { max_files: number; max_bytes: number } | null): ListedFile[] {
  let rootInfo: import("node:fs").Stats;
  try {
    rootInfo = lstatSync(root);
  } catch {
    throw new DossierError("buildDossier: no dashboard/ directory: the page and its source are what the judge reads");
  }
  if (rootInfo.isDirectory() === false) {
    throw new DossierError("buildDossier: dashboard is not a directory");
  }
  const found: ListedFile[] = [];
  let total = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const rel = pending.pop() as string;
    const entries = readdirSync(rel === "" ? root : joinPath(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) {
          throw new DossierError("buildDossier: dashboard/" + child + " is a dot-directory");
        }
        pending.push(child);
      } else if (entry.isFile()) {
        if (PLAIN_NAME.test(entry.name) === false) {
          throw new DossierError("buildDossier: dashboard/" + child + ": a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -");
        }
        const size = lstatSync(joinPath(root, child)).size;
        found.push({ rel: child, bytes: size });
        total += size;
        if (limits !== null && found.length > limits.max_files) {
          throw new DossierError("buildDossier: dashboard/ holds more than the " + limits.max_files + " files it may");
        }
        if (limits !== null && total > limits.max_bytes) {
          throw new DossierError("buildDossier: dashboard/'s files come to more than the " + limits.max_bytes + " bytes they may");
        }
      } else { // not a file, not a directory: a socket, a device, a dangling link
        throw new DossierError("buildDossier: dashboard/" + child + " is neither a file nor a directory");
      }
    }
  }
  found.sort((a, b) => compareText(a.rel, b.rel));
  return found;
}

// ---- turning listed files into text sections ----

/** One source file rendered for the dossier text, with its raw bytes kept for cutting. */
interface RenderedBody {
  raw: Uint8Array;
  decoded: string;
  lang: string; // fence language: the file's extension, mjs as js
  fence: string; // fence text, e.g. "```" or "````"
  /** Fenced rendering: fence plus language, the text (a trailing LF added when missing), fence, blank line. */
  rendered: string;
  renderedBytes: number;
  lineTotal: number;
}

interface PreparedSection {
  lead: string;
  leadBytes: number;
  body: RenderedBody | null;
  wholeBytes: number;
  sourceBytes: number;
}

/**
 * Builds one section per listed file whose extension marks it as source text.
 * Files with any other extension get no section: they appear in the inventory
 * only. An empty source file still gets its heading, with no fenced body after
 * it. Decoding is lenient UTF-8, so invalid bytes become replacement characters
 * in the text while `raw` keeps the original bytes for the cut logic.
 */
function prepareSections(base: string, listed: ListedFile[]): PreparedSection[] {
  const sections: PreparedSection[] = [];
  for (const f of listed) {
    if (TEXT_FILE.test(f.rel) === false) continue;
    const raw = loadBounded(joinPath(base, "dashboard", f.rel), DOSSIER_MAX_BYTES, "dashboard/" + f.rel);
    const lineTotal = countLines(raw);
    const plural = lineTotal === 1 ? "" : "s";
    const lead = "### " + f.rel + "\n\n" + raw.length + " bytes, " + lineTotal + " line" + plural + "\n\n";
    if (raw.length === 0) {
      sections.push({ lead, leadBytes: utf8Len(lead), body: null, wholeBytes: utf8Len(lead), sourceBytes: 0 });
      continue;
    }
    const decoded = new TextDecoder("utf-8").decode(raw);
    const fence = fenceForBody(decoded);
    const lang = fenceLanguage(f.rel);
    const rendered = fence + lang + "\n" + decoded + (decoded.endsWith("\n") ? "" : "\n") + fence + "\n\n";
    sections.push({
      lead,
      leadBytes: utf8Len(lead),
      body: { raw, decoded, lang, fence, rendered, renderedBytes: utf8Len(rendered), lineTotal },
      wholeBytes: utf8Len(lead) + utf8Len(rendered),
      sourceBytes: raw.length,
    });
  }
  return sections;
}

/**
 * Truncates one section inside its fenced body: heading, then the first k of
 * its lines (k at least one and short of all of them), the fence closed, a note
 * counting the lines left out, and finally `tailFn(hidden)` — the cut line fed
 * with the raw bytes this file leaves behind. k is the largest count whose
 * whole rendering still fits in `space` UTF-8 bytes, or null when even a single
 * line does not fit. Cutting happens only right after a line feed, which can
 * never fall inside a UTF-8 sequence or a replacement character, so no
 * character is ever split; a line's displayed length is measured on its decoded
 * text while the hidden-byte count is measured on the raw bytes.
 */
function cutSectionHead(lead: string, shown: RenderedBody, space: number, tailFn: (hidden: number) => string): string | null {
  const total = shown.lineTotal;
  const split = shown.decoded.split("\n");
  const opener = shown.fence + shown.lang + "\n";
  const closer = shown.fence + "\n\n";
  const droppedNote = (kept: number): string => "[" + (total - kept) + " of this file's " + total + " lines not shown.]\n";
  const fixed = utf8Len(lead) + utf8Len(opener) + utf8Len(closer);
  let mostKept = 0;
  let shownBytes = 0;
  let rawAfter = 0;
  for (let kept = 1; kept < total; kept += 1) {
    shownBytes += utf8Len(split[kept - 1] as string) + 1;
    rawAfter = shown.raw.indexOf(0x0a, rawAfter) + 1;
    const fits = fixed + shownBytes + utf8Len(droppedNote(kept)) + utf8Len(tailFn(shown.raw.length - rawAfter)) <= space;
    if (fits) mostKept = kept;
  }
  if (mostKept === 0) return null;
  let rawStop = 0;
  for (let kept = 0; kept < mostKept; kept += 1) {
    rawStop = shown.raw.indexOf(0x0a, rawStop) + 1;
  }
  let headText = "";
  for (let kept = 0; kept < mostKept; kept += 1) {
    headText += (split[kept] as string) + "\n";
  }
  return lead + opener + headText + closer + droppedNote(mostKept) + tailFn(shown.raw.length - rawStop);
}

// ---- assembling the dossier ----

/**
 * Builds the dossier of the dashboard directory at `base`: screenshots become
 * `images` (cover 0 is the first by name) and the dashboard files become the
 * capped `text`, following the inventory-plus-source layout and the cut rule
 * spelled out in the header. Refuses with DossierError when a cap cannot be
 * kept or when either directory holds something a dossier will not take.
 */
export function buildDossier(base: string, limits: DossierCaps): Uint8Array {
  const textCap = limits.text_max_bytes;
  if (Number.isSafeInteger(textCap) === false || textCap <= 0) {
    throw new DossierError("buildDossier: caps.text_max_bytes must be a positive integer, not " + String(textCap));
  }

  let imageLimit = DOSSIER_MAX_IMAGES;
  let imageLimitNote = "a dossier holds";
  let imageByteLimit = DOSSIER_MAX_BYTES;
  const shotsGiven = limits.screenshots;
  if (shotsGiven !== undefined) {
    const shotCaps = shotsGiven as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof shotCaps !== "object" || shotCaps === null) {
      throw new DossierError("buildDossier: caps.screenshots must be an object {max, max_bytes}");
    }
    for (const key of ["max", "max_bytes"] as const) {
      const val = shotCaps[key];
      if (typeof val !== "number" || Number.isSafeInteger(val) === false || val <= 0) {
        throw new DossierError("buildDossier: caps.screenshots." + key + " must be a positive integer, not " + String(val));
      }
    }
    if ((shotCaps.max as number) < imageLimit) {
      imageLimit = shotCaps.max as number;
      imageLimitNote = "caps.screenshots.max allows";
    }
    if ((shotCaps.max_bytes as number) < imageByteLimit) {
      imageByteLimit = shotCaps.max_bytes as number;
    }
  }
  let dashLimits: { max_files: number; max_bytes: number } | null = null;
  const dashGiven = limits.dashboard;
  if (dashGiven !== undefined) {
    const given = dashGiven as { max_files?: unknown; max_bytes?: unknown } | null;
    if (typeof given !== "object" || given === null) {
      throw new DossierError("buildDossier: caps.dashboard must be an object {max_files, max_bytes}");
    }
    for (const key of ["max_files", "max_bytes"] as const) {
      const val = given[key];
      if (typeof val !== "number" || Number.isSafeInteger(val) === false || val <= 0) {
        throw new DossierError("buildDossier: caps.dashboard." + key + " must be a positive integer, not " + String(val));
      }
    }
    dashLimits = { max_files: given.max_files as number, max_bytes: given.max_bytes as number };
  }

  const listed = collectDashboard(joinPath(base, "dashboard"), dashLimits);

  const shotsDir = joinPath(base, "screenshots");
  let shotFiles: string[];
  try {
    shotFiles = readdirSync(shotsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(".") === false)
      .map((entry) => entry.name)
      .sort(compareText);
  } catch (caught) {
    if ((caught as { code?: string }).code === "ENOENT") {
      throw new DossierError("buildDossier: no screenshots/ directory: the first screenshot is the cover");
    }
    throw new DossierError("buildDossier: screenshots/ cannot be read");
  }
  if (shotFiles.length === 0) {
    throw new DossierError("buildDossier: screenshots/ holds no image: the first is the cover");
  }
  if (shotFiles.length > imageLimit) {
    throw new DossierError("buildDossier: screenshots/ holds " + shotFiles.length + " files, over the " + imageLimit + " " + imageLimitNote);
  }
  const shotList: Array<{ name: string; media_type: string; sha256: string; base64: string }> = [];
  for (const name of shotFiles) {
    if (PLAIN_NAME.test(name) === false) {
      throw new DossierError("buildDossier: screenshots/" + name + ": a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -");
    }
    const data = loadBounded(joinPath(shotsDir, name), imageByteLimit, "screenshots/" + name);
    let mediaType: string | null = null;
    if (startsWithBytes(data, PNG_SIGNATURE)) mediaType = "image/png";
    else if (startsWithBytes(data, JPEG_SIGNATURE)) mediaType = "image/jpeg";
    if (mediaType === null) {
      throw new DossierError("buildDossier: screenshots/" + name + " is neither a PNG nor a JPEG");
    }
    shotList.push({ name, media_type: mediaType, sha256: hashHex(data), base64: Buffer.from(data).toString("base64") });
  }

  const totalDashBytes = listed.reduce((sum, f) => sum + f.bytes, 0);
  let text = "## Dashboard\n\nFiles: " + listed.length + " (" + totalDashBytes + " bytes)\n";
  for (const f of listed) {
    text += "- " + f.rel + " (" + f.bytes + " bytes)\n";
  }
  text += "\n## Source\n\n";

  const sections = prepareSections(base, listed);
  // suffixAfter[i]: the raw source bytes of the shown files after section i.
  const suffixAfter: number[] = new Array<number>(sections.length + 1).fill(0);
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    suffixAfter[i] = (suffixAfter[i + 1] as number) + (i + 1 < sections.length ? (sections[i + 1] as PreparedSection).sourceBytes : 0);
  }

  const cutSuffix = (count: number, bytes: number): string => {
    const plural = count === 1 ? "" : "s";
    return "[Cut at " + textCap + " bytes: " + count + " file" + plural + " and " + bytes + " bytes left out.]\n";
  };
  let used = utf8Len(text);
  if (used + utf8Len(cutSuffix(0, 0)) > textCap) {
    throw new DossierError("buildDossier: caps.text_max_bytes " + textCap + " cannot hold even the Dashboard block and the cut line");
  }
  let doneCount = 0;
  while (doneCount < sections.length) {
    const section = sections[doneCount] as PreparedSection;
    const remaining = sections.length - doneCount - 1;
    const tailBytes = remaining === 0 ? 0 : utf8Len(cutSuffix(remaining, suffixAfter[doneCount] as number));
    if (used + section.wholeBytes + tailBytes > textCap) break;
    text += section.body === null ? section.lead : section.lead + section.body.rendered;
    used += section.wholeBytes;
    doneCount += 1;
  }
  if (doneCount < sections.length) {
    // The first section that does not fit whole: keep its head, up to the last complete line that fits.
    const first = sections[doneCount] as PreparedSection;
    const remaining = sections.length - doneCount - 1;
    const after = suffixAfter[doneCount] as number;
    if (first.body === null) {
      text += cutSuffix(remaining + 1, after + first.sourceBytes);
    } else {
      const partial = cutSectionHead(first.lead, first.body, textCap - used, (hidden) => cutSuffix(remaining, after + hidden));
      text += partial === null ? cutSuffix(remaining + 1, after + first.sourceBytes) : partial;
    }
  }
  if (utf8Len(text) > textCap) {
    throw new DossierError("buildDossier: caps.text_max_bytes " + textCap + " cannot hold even the Dashboard block and the cut line");
  }

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: text.replace(/\n+$/, "\n"), images: shotList };
  const encoded = Buffer.from(canonicalJson(doc), "utf8");
  if (encoded.length > DOSSIER_MAX_BYTES) {
    throw new DossierError("buildDossier: the dossier is " + encoded.length + " bytes, over the " + DOSSIER_MAX_BYTES + " one holds");
  }
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.length);
}
