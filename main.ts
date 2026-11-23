// A token-radar-01 entry (Node 22, standard library only), model radar-2.
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// copies this repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// radar-2 calibrates on the snapshot itself: each category's multiple is the median market cap per
// dollar of TVL of that category's live-token protocols, so lending is not priced like a bridge; the
// board covers every rankable pre-token protocol, not just the watchlist floor.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENRICHMENT_VERSION, MODEL_VERSION, boardIssue, buildEnrichments, buildRadar, dataScript, parseSnapshot, summarizeEnrichments, type BoardRow, type Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');

/**
 * The submission gate's own checks, on top of the model's boardIssue: the board must hold
 * exactly 198 rows over exactly the 40 watchlist slugs, ranks must run 1 through N with no gap
 * or repeat, implied values must never rise as rank ascends, and every row's farm plan must
 * hold between 3 and 12 steps. A failure names the first broken row and nothing is written.
 */
function validateSubmission(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length !== 198) return `the board holds ${board.length} rows, expected 198`;
  if (snapshot.watchlist.length !== 40) return `the watchlist holds ${snapshot.watchlist.length} slugs, expected 40`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `the row at position ${i + 1} carries rank ${board[i]!.rank}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} (${board[i]!.slug}) implies more than row ${i} (${board[i - 1]!.slug})`;
    }
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps, expected 3 to 12`;
  }
  return null;
}
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
const submissionIssue = validateSubmission(board, snapshot);
if (submissionIssue !== null) {
  process.stderr.write(`token radar: the submission gate refuses the board: ${submissionIssue}\n`);
  process.exit(1);
}

/**
 * The enrichment layer runs after scoring and never touches the rows: it only derives the new
 * descriptive fields, keyed by slug, for the dashboard to read alongside the board.
 */
const enrichments = buildEnrichments(board, snapshot);
const radarWithEnrichments = { ...radar, enrichments };

/**
 * A small deterministic summary of this run: counts, watchlist coverage, the top ten by implied
 * value, the model version and the snapshot's own date. No wall-clock time, no randomness, so
 * the file is byte-identical across runs of the same snapshot.
 */
const summary = {
  model_version: MODEL_VERSION,
  enrichment_version: ENRICHMENT_VERSION,
  snapshot_as_of: snapshot.as_of,
  total_rows: board.length,
  pre_token_rows: board.length,
  live_token_rows: radar.live_size,
  watchlist: {
    covered: snapshot.watchlist.filter((s) => board.some((r) => r.slug === s)).length,
    total: snapshot.watchlist.length,
  },
  top_10: board.slice(0, 10).map((r) => ({ slug: r.slug, name: r.name, implied_value_usd: r.implied_value_usd })),
  enrichment_summary: summarizeEnrichments(board, enrichments),
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radarWithEnrichments));
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
