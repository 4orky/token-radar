// token-radar-01, entry point (Node 22, standard library only).
//
// The run reads the sealed snapshot from /input/snapshot.json (or
// --input <file|dir>), scores every pre-token protocol with the model in
// lib/model.ts, writes the ranked board to /output/board.json, and copies this
// repository's dashboard/ and screenshots/ to /output. Last it writes
// /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The model calibrates on the snapshot itself: each category's multiple is the
// median market cap per dollar of TVL of that category's live-token protocols,
// so lending is never priced like a bridge. The board covers every rankable
// pre-token protocol, not just the watchlist floor.
//
// The dashboard is a static page — no framework, no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board.
//
// Away from the grader's container, MAKEFUN_OUTPUT_DIR takes the place of /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENRICHMENT_TAG,
  MODEL_TAG,
  assembleRadar,
  enrichBoard,
  findBoardProblem,
  radarScript,
  readSnapshot,
  tallyEnrichments,
  type BoardEntry,
  type SnapshotDoc,
} from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap trims the bytes, the rest refuse. */
const TEXT_LIMIT = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name <value>` or `--name=<value>` out of the arguments, or the fallback. */
const flagValue = (name: string, fallback: string): string => {
  const pos = process.argv.indexOf(`--${name}`);
  if (pos >= 0 && pos + 1 < process.argv.length) return process.argv[pos + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined === undefined) return fallback;
  return joined.slice(name.length + 3);
};

const inputArg = flagValue("input", "/input");
const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");

/**
 * The submission gate's own checks, on top of the model's findBoardProblem:
 * the board must hold exactly 198 rows over exactly the 40 watchlist slugs,
 * ranks must run 1 through N with no gap or repeat, implied values must never
 * rise as rank ascends, and every row's farm plan must hold between 3 and 12
 * steps. A failure names the first broken row and nothing is written.
 */
const checkSubmission = (board: BoardEntry[], snapshot: SnapshotDoc): string | null => {
  if (board.length !== 198) return "the board holds " + board.length + " rows, expected 198";
  if (snapshot.watchlist.length !== 40) {
    return "the watchlist holds " + snapshot.watchlist.length + " slugs, expected 40";
  }
  const present = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !present.has(s));
  if (absent.length > 0) {
    return "the board misses " + absent.length + " watchlist slug" + (absent.length === 1 ? "" : "s") + ": " + absent.slice(0, 5).join(", ");
  }
  for (let i = 0; i < board.length; i += 1) {
    if (board[i]!.rank !== i + 1) return "the row at position " + (i + 1) + " carries rank " + board[i]!.rank;
  }
  for (let i = 1; i < board.length; i += 1) {
    const upper = board[i]!;
    const lower = board[i - 1]!;
    if (upper.implied_value_usd > lower.implied_value_usd) {
      return "row " + (i + 1) + " (" + upper.slug + ") implies more than row " + i + " (" + lower.slug + ")";
    }
  }
  for (const entry of board) {
    if (entry.farm_steps.length < 3 || entry.farm_steps.length > 12) {
      return entry.slug + " has " + entry.farm_steps.length + " farm steps, expected 3 to 12";
    }
  }
  return null; // every submission-gate row holds
};

/** Write a failure to stderr and stop with the given code. */
const abort = (message: string, code: number): never => {
  process.stderr.write(message);
  process.exit(code);
};

if (existsSync(inputFile) === false) {
  abort("token radar: no snapshot at " + inputFile + ": pass --input <snapshot.json|directory> or mount the sealed /input\n", 2);
}
const out = flagValue("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const snapshot = readSnapshot(readFileSync(inputFile, "utf8"));
const { board, radar } = assembleRadar(snapshot);
const problem = findBoardProblem(board, snapshot);
if (problem !== null) {
  abort("token radar: the model wrote a board the gate refuses: " + problem + "\n", 1);
}
const submissionProblem = checkSubmission(board, snapshot);
if (submissionProblem !== null) {
  abort("token radar: the submission gate refuses the board: " + submissionProblem + "\n", 1);
}

/**
 * The enrichment layer runs after scoring and never touches the rows: it only
 * derives the new descriptive fields, keyed by slug, for the dashboard to read
 * alongside the board.
 */
const enrichments = enrichBoard(board, snapshot);
const radarEnriched = { ...radar, enrichments };

/**
 * A small deterministic summary of this run: counts, watchlist coverage, the
 * top ten by implied value, the model version and the snapshot's own date. No
 * wall-clock time, no randomness, so the file is byte-identical across runs of
 * the same snapshot.
 */
const summary = { model_version: MODEL_TAG, enrichment_version: ENRICHMENT_TAG,
  snapshot_as_of: snapshot.as_of, total_rows: board.length, pre_token_rows: board.length, live_token_rows: radar.live_size,
  watchlist: { covered: snapshot.watchlist.filter((s) => board.some((r) => r.slug === s)).length, total: snapshot.watchlist.length },
  top_10: board.slice(0, 10).map((entry) => ({ slug: entry.slug, name: entry.name, implied_value_usd: entry.implied_value_usd })),
  enrichment_summary: tallyEnrichments(board, enrichments) };

/** Create a directory and its parents when they are missing. */
const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

ensureDir(out);
writeFileSync(join(out, "board.json"), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, "data.js"), radarScript(radarEnriched));
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

/** Copy one directory's plain files into `to`, skipping names that start with a dot. */
const copyDir = (from: string, to: string): string[] => {
  if (existsSync(from) === false) return [];
  ensureDir(to);
  const copied: Array<string> = [];
  for (const entry of readdirSync(from)) {
    if (entry.startsWith(".")) continue;
    const source = join(from, entry);
    if (statSync(source).isFile() === false) continue;
    copyFileSync(source, join(to, entry));
    copied.push(entry);
  }
  return [...copied];
};

copyDir(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyDir(join(here, "screenshots"), join(out, "screenshots"));
const MIN_SHOTS = 3;
if (shots.length < MIN_SHOTS) {
  abort(
    "token radar: screenshots/ holds " + shots.length + " image" + (shots.length === 1 ? "" : "s") +
      ": hand in 3, the board, a detail view and a filtered view\n",
    1,
  );
}
for (const shot of shots) {
  if (SHOT_NAME.test(shot) === false) {
    abort("token radar: screenshots/" + shot + ": a name is letters, digits and . _ -, 1 to 128 characters\n", 1);
  }
}

// The dossier goes last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, "dossier.json"),
  buildDossier(out, {
    text_max_bytes: TEXT_LIMIT,
    screenshots: SHOT_LIMIT,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const report =
  "token radar: " + snapshot.protocols.length + " protocols, " + snapshot.watchlist.length +
  " on the watchlist, " + board.length + " rows scored (" + radar.early_size + " early, " +
  radar.live_size + " live set aside)\n" +
  "token radar: wrote " + join(out, "board.json") + ", " + join(out, "data.js") + ", " +
  join(out, "dashboard") + " (3 files), " + join(out, "screenshots") + " (" + shots.length +
  " images) and " + join(out, "dossier.json") + "\n";
process.stdout.write(report);
