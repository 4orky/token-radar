// radar-2, rebuilt: the token launch radar's scoring core.
//
// What comes in is one frozen DefiLlama snapshot; what goes out is a ranked
// board of pre-token protocols, each with an implied launch value and a farm
// plan. Nothing here names a protocol. Every number the model uses is either
// read off the snapshot at run time or a plainly stated tuning constant below.
//
// The valuation idea, in one breath: a protocol is worth what the market
// already pays for a dollar of TVL in its own line of business, times how fast
// its TVL is moving, times how long it has run without issuing a token, times
// how many chains it spans. The per-category price comes from the snapshot's
// live-token protocols, so lending is never priced like a bridge.

/** One protocol record, exactly as the sealed snapshot carries it. */
export interface ProtocolRecord {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The snapshot document: the protocol universe plus the watchlist floor. */
export interface SnapshotDoc {
  as_of: string; source: string; floor_usd: number;
  protocols: ProtocolRecord[]; watchlist: string[];
}

/** The tunable knobs of the model. The dashboard prints them, and a sandbox run may vary them. */
export interface Tuning {
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; unknown_age_days: number;
  multiple_floor: number; multiple_cap: number; multiple_min_samples: number;
  chain_step: number; chain_max_steps: number;
}

export const TUNING: Tuning = {
  growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4, unknown_age_days: 365,
  multiple_floor: 0.05, multiple_cap: 1.5, multiple_min_samples: 3,
  chain_step: 0.03, chain_max_steps: 8,
};

/** The model label the dashboard and the run summary both print. */
export const MODEL_TAG = "radar-2";

/** How many of the biggest live-token protocols the Live view shows. */
export const LIVE_COUNT = 24;

/** One calibrated price: what a dollar of TVL fetches in one line of business. */
export interface CategoryRate {
  category: string; multiple: number; n: number;
}

/** The snapshot's own calibration: a price per category, plus the global fallback. */
export interface CalibrationTable {
  global: number; byCategory: CategoryRate[];
}

/** One farm-plan step: the move, what it costs, how long it takes. */
export interface PlanStep {
  text: string; cost: string; time: string;
}

/** One row of board.json. */
export interface BoardEntry {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: "pre-token"; age_days: number | null; implied_value_usd: number;
  model: { category_multiple: number; growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; chain_multiplier: number; age_days: number | null }; farm_steps: string[];
}

/** The slim row the dashboard reads: the board without the farm plan, which the page rebuilds. */
export interface CompactRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; age_days: number | null; implied_value_usd: number;
  category_multiple: number; growth_multiplier: number;
  maturity_multiplier: number; chain_multiplier: number;
}

/** A live-token protocol: its market cap is a fact, not a model output. */
export interface LiveEntry {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs, in one object. */
export interface RadarPayload {
  as_of: string; source: string; floor_usd: number;
  model: Tuning; model_version: string; calibration: CalibrationTable;
  watchlist_size: number; watchlist_slugs: string[];
  board_size: number; early_size: number; live_size: number;
  rows: CompactRow[]; live: LiveEntry[];
  enrichments?: Record<string, EntryEnrichment>;
}

/** Thrown when the snapshot file is not the shape this model scores. */
export class SnapshotError extends Error { // thrown for a snapshot the model cannot score
  constructor(message: string) { super(message); this.name = "SnapshotError"; }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, or `fallback` when the value is missing or not a number. */
const asFinite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date is missing or malformed. */
export function daysListed(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) { return null; }
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const end = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((start - end) / MS_PER_DAY));
}

/** The median of an already-sorted list, or `fallback` for an empty one. */
const medianSorted = (sorted: number[], fallback: number): number => {
  if (sorted.length === 0) { return fallback; }
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[half]!;
  return (sorted[half - 1]! + sorted[half]!) / 2;
};

/** Keep a calibrated multiple inside the model's band. */
const clampRate = (x: number, tuning: Tuning): number =>
  Math.min(tuning.multiple_cap, Math.max(tuning.multiple_floor, x));

/** A protocol records no token when all three token fields are empty. */
export function hasNoToken(p: ProtocolRecord): boolean {
  const tokenFields = [p.mcap_usd, p.gecko_id, p.symbol];
  return tokenFields.every((field) => field === null);
}

/**
 * Calibrate on the snapshot itself. For each category, the median market-cap
 * per TVL of its live-token protocols (both figures positive, at least
 * `multiple_min_samples` of them); thin categories fall back to the median
 * across every live-token protocol. Nothing here is hand-written: hand this
 * function another snapshot and it calibrates to that one.
 */
export function deriveCalibration(snapshot: SnapshotDoc, tuning: Tuning = TUNING): CalibrationTable {
  const live = snapshot.protocols.filter(
    (p) => !hasNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = clampRate(medianSorted(allRatios, 0.25), tuning);
  const buckets = new Map<string, number[]>();
  for (const entry of live) {
    const key = entry.category ?? "Other";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry.mcap_usd! / entry.tvl_usd);
    else buckets.set(key, [entry.mcap_usd! / entry.tvl_usd]);
  }
  const byCategory: CategoryRate[] = [];
  const names = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const multiples = buckets.get(name)!;
    if (multiples.length < tuning.multiple_min_samples) continue;
    byCategory.push({ category: name, multiple: clampRate(medianSorted(multiples.sort((a, b) => a - b), global), tuning), n: multiples.length });
  }
  return { global: global, byCategory: byCategory };
}

/** The calibrated multiple for a protocol's category, or the global fallback. */
export function rateForCategory(p: ProtocolRecord, calibration: CalibrationTable, tuning: Tuning = TUNING): number {
  const key = p.category ?? "Other";
  const match = calibration.byCategory.find((c) => c.category === key);
  if (match !== undefined) return match.multiple;
  return clampRate(calibration.global, tuning);
}

/**
 * The maturity factor: a protocol that has run longer with no token is riper,
 * with diminishing returns. A year in scores 0.8, three years in scores 1.0.
 */
export function maturityFactor(age: number | null, tuning: Tuning = TUNING): number {
  const days = age ?? tuning.unknown_age_days;
  const x = Math.log(1 + Math.max(days, 0) / 365) / Math.log(4);
  return Math.min(1, Math.max(tuning.maturity_floor, tuning.maturity_floor + tuning.maturity_range * x));
}

/** The chain-breadth factor: each extra chain adds a little, up to eight steps. */
export function chainFactor(chains: string[], tuning: Tuning = TUNING): number {
  const steps = Math.min(Math.max(chains.length - 1, 0), tuning.chain_max_steps);
  return 1 + tuning.chain_step * steps;
}

/** Score one protocol: the four factors and the implied value they produce. */
export function scoreProtocol(protocol: ProtocolRecord, asOf: string, calibration: CalibrationTable, tuning: Tuning = TUNING): {
  implied: number;
  categoryMult: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = daysListed(asOf, protocol.listed_at);
  const rawGrowth = asFinite(protocol.change_7d, 0);
  const growthPct = Math.min(tuning.growth_cap, Math.max(tuning.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * tuning.growth_weight;
  const maturityMult = maturityFactor(age, tuning);
  const chainMult = chainFactor(protocol.chains, tuning);
  const categoryMult = rateForCategory(protocol, calibration, tuning);
  const product = protocol.tvl_usd * categoryMult * growthMult * maturityMult * chainMult;
  const implied = Math.max(1, Math.round(product));
  return { age: age, chainMult: chainMult, maturityMult: maturityMult, growthMult: growthMult, growthPct: growthPct, categoryMult: categoryMult, implied: implied };
}

/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSION_TAG = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a traded token. */
const WRAPPED_KINDS = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);

/** Exchange names a rankable protocol's name never starts with. */
const EXCHANGE_NAMES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];

/** One whole word that marks a name as a wrapped or staked product. */
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether the board may rank a protocol: it records no token, and it is not a
 * wrapped, staked or bridged product of a token that already trades, not an
 * exchange, not a versioned pool. This is the watchlist's own rule, applied to
 * every row below the floor as well.
 */
export function canRank(p: ProtocolRecord): boolean {
  const cleanCategory = p.category === null || !WRAPPED_KINDS.has(p.category);
  const cleanName = !VERSION_TAG.test(p.name) && !WRAPPED_TERM.test(p.name) && !EXCHANGE_NAMES.some((e) => p.name.startsWith(e));
  return hasNoToken(p) && cleanCategory && cleanName;
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The snapshot's protocols, keyed by slug. */
const indexBySlug = (protocols: ProtocolRecord[]): Map<string, ProtocolRecord> =>
  new Map(protocols.map((p) => [p.slug, p]));

/**
 * Rank the board. The watchlist is the floor: every one of its slugs comes
 * first, even one the snapshot no longer carries. Then the early radar: every
 * other rankable pre-token protocol, whatever its TVL — the floor is never the
 * whole board, and the smallest pre-token protocols are the ones a launch
 * radar exists to find. Strongest implied value first, ties broken by slug.
 */
export function rankBoard(snapshot: SnapshotDoc, tuning: Tuning = TUNING): BoardEntry[] {
  const calibration = deriveCalibration(snapshot, tuning);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, ProtocolRecord>();
  for (const listed of snapshot.watchlist) {
    const found = index.get(listed);
    if (found !== undefined) chosen.set(listed, found);
  }
  for (const entry of snapshot.protocols) {
    if (!chosen.has(entry.slug) && canRank(entry)) chosen.set(entry.slug, entry);
  }
  const scored = [...chosen.values()].map((p) => ({ p, ...scoreProtocol(p, snapshot.as_of, calibration, tuning) }));
  scored.sort((x, y) => y.implied - x.implied || (x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0));
  return scored.map((s, i) => ({ rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id, symbol: s.p.symbol, token_status: "pre-token", age_days: s.age, implied_value_usd: s.implied,
    model: { category_multiple: round4dp(s.categoryMult), growth_pct: s.growthPct, growth_multiplier: round4dp(s.growthMult),
      maturity_multiplier: round4dp(s.maturityMult), chain_multiplier: round4dp(s.chainMult), age_days: s.age },
    farm_steps: planFarmSteps(s.p, s.age).map(renderStep) }));
}

/** A step as one string: the action, then its cost and time, within the gate's 20 to 600 characters. */
export function renderStep(step: PlanStep): string {
  const joined = step.text + " Cost: " + step.cost + ". Time: " + step.time + ".";
  if (joined.length > 600) return joined.slice(0, 596) + "...";
  if (joined.length < 20) return joined + " Hold the position and check the protocol's own page.";
  return joined;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
const firstChain = (p: ProtocolRecord): string => (p.chains.length > 0 ? p.chains[0]! : "its main chain");

/** Whether the lowercased category carries any of these words. */
const hasAny = (category: string, words: string[]): boolean => words.some((w) => category.includes(w));

/** Capital bands by TVL: the bigger the protocol, the bigger the position the plan sizes. */
const CAPITAL_BANDS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

/** The capital one farm position needs, sized from the protocol's own TVL. */
const capitalNeeded = (p: ProtocolRecord): number => {
  const band = CAPITAL_BANDS.find(([floor]) => p.tvl_usd >= floor);
  return band === undefined ? 50 : band[1];
};

/** Hold windows by age: younger protocols get a longer qualifying window. */
const HOLD_WINDOWS: Array<[number, number]> = [
  [180, 60],
  [365, 45],
];

/** How long to hold, from the protocol's age; thirty days when the age is unknown or the protocol is old. */
const holdLength = (age: number | null): number => {
  const fallback = 30;
  if (age === null) return fallback;
  for (const [ceiling, days] of HOLD_WINDOWS) {
    if (age < ceiling) return days;
  }
  return fallback;
};

interface ActionRule {
  test: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

/**
 * The category's one action, as a rule table read top to bottom: the first
 * rule whose words appear in the category wins. A farmer can follow the
 * sentence it writes without knowing the model.
 */
const ACTION_RULES: ActionRule[] = [
  {
    test: (c) => hasAny(c, ["lend", "cdp", "collateral"]),
    write: (name, capital, chain) =>
      "Supply $" + capital + " of USDC to " + name + " on " + chain + " and keep the position open.",
  },
  {
    test: (c) => hasAny(c, ["dex", "yield", "leveraged farm"]),
    write: (name, capital, chain) =>
      "Provide $" + capital + " of liquidity to " + name + "'s main pool on " + chain +
      " and keep the position open.",
  },
  {
    test: (c) => hasAny(c, ["bridge"]),
    write: (name, capital, chain) =>
      "Bridge $" + capital + " of USDC to " + chain + " through " + name +
      " and use the bridged funds in its app.",
  },
  {
    test: (c) => hasAny(c, ["staking", "restak"]),
    write: (name, capital, chain) =>
      "Stake $" + capital + " of the chain's staking asset through " + name + " and keep the receipt.",
  },
  {
    test: (c) => hasAny(c, ["perpetual", "derivative"]),
    write: (name, capital, chain) =>
      "Deposit $" + capital + " of USDC as margin on " + name + " and open one small hedge.",
  },
  {
    test: (c) => hasAny(c, ["prediction"]),
    write: (name, capital, chain) => "Fund $" + capital + " and place one market position on " + name + ".",
  },
  {
    test: (c) => hasAny(c, ["curator", "allocator"]),
    write: (name, capital, chain) =>
      "Deposit $" + capital + " into a " + name + " vault on " + chain + " and keep the shares.",
  },
  {
    test: (c) => hasAny(c, ["stable"]),
    write: (name, capital, chain) =>
      "Mint or deposit $" + capital + " of the stable asset through " + name + " on " + chain + ".",
  },
  {
    test: (c) => hasAny(c, ["rwa"]),
    write: (name, capital, chain) =>
      "Mint $" + capital + " of the protocol's yield asset on " + chain + " and hold it.",
  },
  {
    test: (c) => hasAny(c, ["insurance"]),
    write: (name, capital, chain) =>
      "Buy $" + capital + " of cover from " + name + " on " + chain + " and keep the policy.",
  },
  {
    test: (c) => hasAny(c, ["launchpad"]),
    write: (name, capital, chain) =>
      "Join " + name + "'s next launch on " + chain + " with $" + capital + " and hold the allocation.",
  },
  {
    test: (c) => hasAny(c, ["basis"]),
    write: (name, capital, chain) =>
      "Deposit $" + capital + " of USDC into " + name + "'s basis vault on " + chain +
      " and keep the shares.",
  },
  {
    test: (c) => hasAny(c, ["option"]),
    write: (name, capital, chain) =>
      "Deposit $" + capital + " of USDC into " + name + "'s vault on " + chain +
      " and keep the position open.",
  },
  {
    test: (c) => hasAny(c, ["nft"]),
    write: (name, capital, chain) =>
      "List or buy one item on " + name + " on " + chain + " and keep the activity on the same wallet.",
  },
  {
    test: (c) => hasAny(c, ["payment", "card"]),
    write: (name, capital, chain) =>
      "Spend $" + capital + " through " + name + " on " + chain + " and keep the receipts on the same wallet.",
  },
  {
    test: (c) => hasAny(c, ["privacy"]),
    write: (name, capital, chain) =>
      "Use $" + capital + " through " + name + "'s private flow on " + chain + " and keep the receipt.",
  },
  {
    test: (c) => hasAny(c, ["index"]),
    write: (name, capital, chain) =>
      "Buy $" + capital + " of the " + name + " index on " + chain + " and hold the shares.",
  },
  {
    test: (c) => hasAny(c, ["ai"]),
    write: (name, capital, chain) =>
      "Use $" + capital + " of " + name + "'s agent or tool on " + chain +
      " and keep the activity on the same wallet.",
  },
];

/** The fallback action, for a category no rule names. */
const fallbackAction = (name: string, capital: number, chain: string): string =>
  "Deposit $" + capital + " of USDC into " + name + " on " + chain + " and keep the position open.";

/** The action for a protocol: the first matching rule, or the fallback. */
const actionForProtocol = (p: ProtocolRecord, capital: number, chain: string): string => {
  const c = (p.category ?? "").toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.test(c)) return rule.write(p.name, capital, chain);
  }
  return fallbackAction(p.name, capital, chain);
};

interface WeeklyRule {
  test: (category: string) => boolean;
  write: string;
}

/** The weekly qualifying action, fitted to the protocol's own line of business. */
const WEEKLY_RULES: WeeklyRule[] = [
  { test: (c) => hasAny(c, ["perpetual", "derivative", "option"]), write: "open and close one small trade" },
  { test: (c) => hasAny(c, ["dex", "yield"]), write: "add or remove a little liquidity, or one swap" },
  { test: (c) => hasAny(c, ["lend", "cdp"]), write: "adjust the position, or borrow and repay a little" },
  { test: (c) => hasAny(c, ["bridge"]), write: "bridge a small amount back or forth" },
  { test: (c) => hasAny(c, ["prediction"]), write: "place one small market position" },
  { test: (c) => hasAny(c, ["staking", "restak"]), write: "restake the rewards, or stake a little more" },
  { test: (c) => hasAny(c, ["launchpad"]), write: "vote in a launch or check the new listings" },
];

/** The weekly action for a protocol, or the generic one when no rule matches. */
const weeklyForProtocol = (p: ProtocolRecord): string => {
  const c = (p.category ?? "").toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.test(c)) return rule.write;
  }
  return "a deposit, a borrow, a swap or a vote";
};

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
export function planFarmSteps(p: ProtocolRecord, age: number | null): PlanStep[] {
  const chain = firstChain(p);
  const capital = capitalNeeded(p);
  const hold = holdLength(age);
  const action = actionForProtocol(p, capital, chain);
  const weekly = weeklyForProtocol(p);
  const steps: PlanStep[] = [
    { text: "Use a fresh wallet that holds only the funds you plan to farm, " + "and keep its seed phrase offline.",
      cost: "under $3 of gas for the first transaction", time: "5 minutes" },
    { text: action, cost: "$" + capital + " of capital and about $" + (capital >= 150 ? 8 : 4) + " of gas", time: "15 minutes to set up" },
    { text: "Make one qualifying action each week, such as " + weekly + ".",
      cost: "about $2 of gas a week", time: "10 minutes a week" },
    { text: "Hold the position for at least " + hold + " days so the activity " + "is counted in more than one snapshot.",
      cost: "the $" + capital + " stays in the position", time: hold + " days" },
    { text: "Before you withdraw, open the protocol's own points or rewards page " + "and claim only from the link it publishes.",
      cost: "no fee to check, and never pay to claim", time: "10 minutes" },
    { text: "Write the wallet, the dates and every transaction in a farm log " + "so you can repeat the position or unwind it.",
      cost: "nothing but the log", time: "5 minutes" },
  ];
  return steps;
}

/** The live-token protocols, biggest market cap first, for the dashboard's Live view. */
export function liveEntries(snapshot: SnapshotDoc): LiveEntry[] {
  const ranked = snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== "CEX")
    .sort((x, y) => (y.mcap_usd ?? 0) - (x.mcap_usd ?? 0) || y.tvl_usd - x.tvl_usd)
    .slice(0, LIVE_COUNT);
  return ranked.map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** A board row slimmed for data.js; the farm plan is generated in the page. */
export function compactRow(row: BoardEntry): CompactRow {
  return { rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd, category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier, chain_multiplier: row.model.chain_multiplier };
}

/** Everything the dashboard renders, built from one snapshot. */
export function assembleRadar(snapshot: SnapshotDoc, tuning: Tuning = TUNING): { board: BoardEntry[]; radar: RadarPayload } {
  const board = rankBoard(snapshot, tuning);
  const calibration = deriveCalibration(snapshot, tuning);
  const live = liveEntries(snapshot);
  const earlyCount = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const boardCats = new Set(board.map((r) => r.category ?? "Other"));
  const radar: RadarPayload = { as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model: tuning, model_version: MODEL_TAG,
    calibration: { global: calibration.global, byCategory: calibration.byCategory.filter((c) => boardCats.has(c.category)) },
    watchlist_size: snapshot.watchlist.length, watchlist_slugs: snapshot.watchlist.slice(),
    board_size: board.length, early_size: earlyCount, live_size: live.length,
    rows: board.map(compactRow), live: live };
  return { board: board, radar: radar };
}

/** Read the snapshot out of a file's text, refused unless it is the shape the model scores. */
const parseJsonText = (text: string): unknown => {
  try { return JSON.parse(text) as unknown; } catch { throw new SnapshotError("snapshot.json is not valid JSON"); }
};

export function readSnapshot(text: string): SnapshotDoc {
  const raw = parseJsonText(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotError("snapshot.json is not a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError("snapshot.json carries no as_of date");
  }
  if (typeof doc.source !== "string") throw new SnapshotError("snapshot.json carries no source");
  if (typeof doc.floor_usd !== "number" || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError("snapshot.json carries no floor_usd");
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError("snapshot.json carries no protocols array");
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== "string")) {
    throw new SnapshotError("snapshot.json carries no watchlist of slugs");
  }
  const protocols = doc.protocols.map((v, i) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new SnapshotError("snapshot.json protocol " + i + " is not an object");
    }
    const entry = v as Record<string, unknown>;
    if (typeof entry.slug !== "string" || typeof entry.name !== "string" || typeof entry.tvl_usd !== "number" || !Number.isFinite(entry.tvl_usd)) {
      throw new SnapshotError("snapshot.json protocol " + i + " lacks a slug, a name or a TVL");
    }
    return { slug: entry.slug, name: entry.name,
      category: typeof entry.category === "string" ? entry.category : null,
      chains: Array.isArray(entry.chains) ? entry.chains.filter((c): c is string => typeof c === "string") : [],
      tvl_usd: entry.tvl_usd,
      change_7d: typeof entry.change_7d === "number" && Number.isFinite(entry.change_7d) ? entry.change_7d : null,
      mcap_usd: typeof entry.mcap_usd === "number" && Number.isFinite(entry.mcap_usd) ? entry.mcap_usd : null,
      listed_at: typeof entry.listed_at === "string" ? entry.listed_at : null,
      gecko_id: typeof entry.gecko_id === "string" ? entry.gecko_id : null,
      symbol: typeof entry.symbol === "string" ? entry.symbol : null };
  });
  return { as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd, protocols: protocols, watchlist: doc.watchlist as string[] };
}

/**
 * Why a board is not one the gate will take, or null: coverage, ranks, order,
 * one shared implied value, and farm steps.
 */
export function findBoardProblem(board: BoardEntry[], snapshot: SnapshotDoc): string | null {
  const present = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !present.has(s));
  if (absent.length > 0) {
    return "the board misses " + absent.length + " watchlist slug" + (absent.length === 1 ? "" : "s") + ": " + absent.slice(0, 5).join(", ");
  }
  const orderedRanks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < orderedRanks.length; i++) {
    if (orderedRanks[i] !== i + 1) return "rank " + (i + 1) + " is " + orderedRanks[i];
  }
  for (let j = 1; j < board.length; j++) {
    if (board[j]!.implied_value_usd > board[j - 1]!.implied_value_usd) {
      return "row " + (j + 1) + " outranks row " + j + " on implied value";
    }
  }
  const first = board[0]!;
  const last = board[board.length - 1]!;
  if (board.length >= 2 && first.implied_value_usd === last.implied_value_usd) {
    return (
      "all " + board.length + " rows share the same implied value $" + first.implied_value_usd +
      ": a board that ranks nothing by value is not a ranking"
    );
  }
  for (const entry of board) {
    const steps = entry.farm_steps;
    if (steps.length < 3 || steps.length > 12) return entry.slug + " has " + steps.length + " farm steps";
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return entry.slug + " has a farm step of " + s.length + " characters";
    }
    if (!Number.isSafeInteger(entry.implied_value_usd) || entry.implied_value_usd <= 0) {
      return entry.slug + " has implied value " + entry.implied_value_usd;
    }
  }
  return null; // every gate row holds: the board is one the gate will take
}

/** The enrichment layer's version label, carried into the summary and the dashboard data. */
export const ENRICHMENT_TAG = "radar-2.1-enrichment";

/**
 * One category's context, as the enrichment layer reports it for a row: how
 * many pre-token protocols share the category, how much TVL they hold
 * together, the middle TVL among them, and the benchmark multiple the
 * snapshot's own live-token protocols in that category imply.
 */
export interface CategoryBrief {
  category: string; pre_token_count: number; total_tvl_usd: number;
  median_tvl_usd: number; benchmark_multiple: number; live_sample_count: number;
}

/** The extra fields the enrichment layer attaches to one board row: all derived, none scored. */
export interface EntryEnrichment {
  slug: string; confidence_score: number; value_tier: string;
  maturity_label: string; chain_count: number; category_context: CategoryBrief;
}

/** The middle value of a list of numbers, or `fallback` when the list is empty. */
const medianOf = (values: number[], fallback: number): number => {
  if (values.length === 0) { return fallback; }
  const sortedCopy = [...values].sort((a, b) => a - b);
  const half = Math.floor(sortedCopy.length / 2);
  if (sortedCopy.length % 2 === 1) return sortedCopy[half]!;
  return (sortedCopy[half - 1]! + sortedCopy[half]!) / 2;
};

/**
 * How complete a row's own record is, from zero to one hundred. A row earns
 * its points from what the snapshot actually carries for it: a positive TVL
 * is worth 35, a recorded seven-day change 20, a known category 15, a listing
 * date 15, and chain breadth up to 15, one quarter of it per chain up to four
 * chains. A row with every field present scores 100; a row with only a TVL
 * scores 35. Nothing here feeds back into the implied value, so the score can
 * only describe a row, never move it.
 */
export function recordCompleteness(row: BoardEntry): number {
  const contributions = [
    row.tvl_usd > 0 ? 35 : 0,
    row.change_7d !== null ? 20 : 0,
    row.category !== null && row.category !== "" ? 15 : 0,
    row.listed_at !== null && row.listed_at !== "" ? 15 : 0,
  ];
  const points = contributions.reduce((a, b) => a + b, 0);
  const chainShare = (15 * Math.min(row.chains.length, 4)) / 4;
  const total = points + chainShare;
  return Math.round(total);
}

/**
 * The value tier a dollar figure falls into. The bands are wide on purpose:
 * they are a reading aid for the dashboard, not a second ranking, and moving
 * a band would never change a row's place on the board.
 */
export function tierForValue(impliedUsd: number): string {
  if (impliedUsd >= 500_000_000) return "flagship";
  if (impliedUsd >= 100_000_000) return "major";
  if (impliedUsd >= 25_000_000) return "notable";
  if (impliedUsd >= 5_000_000) return "emerging";
  return "nascent";
}

/**
 * The maturity label for an age in days. Three years with no token is
 * seasoned, a year is established, half a year is maturing, anything younger
 * is young, and a missing listing date says so instead of guessing.
 */
export function labelForAge(ageDays: number | null): string {
  if (ageDays === null) return "unknown age";
  if (ageDays >= 1095) return "seasoned";
  if (ageDays >= 365) return "established";
  if (ageDays >= 180) return "maturing";
  return "young";
}

/**
 * One context object per category on the board. The pre-token side comes from
 * the board rows themselves: how many of them the category holds, their
 * combined TVL, and the middle TVL among them. The benchmark side comes from
 * the snapshot's live-token protocols in that same category: the median
 * market-cap-per-TVL among them, read off the snapshot at run time, with the
 * global median as the fallback when a category has fewer than three live
 * samples. The benchmark is clamped to the same [0.05, 1.5] band the scoring
 * multiple uses, so a thin category cannot report a wild benchmark. No number
 * here is written by hand.
 */
export function contextsByCategory(rows: BoardEntry[], snapshot: SnapshotDoc): Map<string, CategoryBrief> {
  const liveBuckets = new Map<string, number[]>();
  const allLiveRatios: number[] = [];
  for (const entry of snapshot.protocols) {
    if (hasNoToken(entry)) continue;
    if (entry.mcap_usd === null || entry.mcap_usd <= 0 || entry.tvl_usd <= 0) continue;
    const ratio = entry.mcap_usd / entry.tvl_usd;
    allLiveRatios.push(ratio);
    const key = entry.category ?? "Other";
    const list = liveBuckets.get(key);
    if (list) list.push(ratio);
    else liveBuckets.set(key, [ratio]);
  }
  const globalBenchmark = medianOf(allLiveRatios, 0.25);
  const grouped = new Map<string, BoardEntry[]>();
  for (const entry of rows) {
    const key = entry.category ?? "Other";
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }
  const contexts = new Map<string, CategoryBrief>();
  const categories = [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const category of categories) {
    const inCategory = grouped.get(category)!;
    const values = inCategory.map((r) => r.tvl_usd);
    const liveSamples = liveBuckets.get(category) ?? [];
    const rawBenchmark = liveSamples.length >= 3 ? medianOf(liveSamples, globalBenchmark) : globalBenchmark;
    const clamped = Math.min(1.5, Math.max(0.05, rawBenchmark));
    contexts.set(category, { category: category, pre_token_count: inCategory.length,
      total_tvl_usd: values.reduce((sum, v) => sum + v, 0), median_tvl_usd: medianOf(values, 0),
      benchmark_multiple: Math.round(clamped * 1e4) / 1e4, live_sample_count: liveSamples.length });
  }
  return contexts; // one brief per category
}

/**
 * The enrichment record for one row: its confidence score, its value tier,
 * its maturity label, how many chains it runs on, and the context of its
 * category. The category context falls back to the row's own figures when the
 * category was never built, so this function always returns a complete record.
 */
export function enrichEntry(row: BoardEntry, contexts: Map<string, CategoryBrief>): EntryEnrichment {
  const key = row.category ?? "Other";
  const brief = contexts.get(key) ?? { category: key, pre_token_count: 1,
    total_tvl_usd: row.tvl_usd, median_tvl_usd: row.tvl_usd,
    benchmark_multiple: row.model.category_multiple, live_sample_count: 0 };
  return { slug: row.slug, confidence_score: recordCompleteness(row),
    value_tier: tierForValue(row.implied_value_usd), maturity_label: labelForAge(row.age_days),
    chain_count: row.chains.length, category_context: brief };
}

/** The enrichment totals: one count per value tier, plus the mean confidence. */
export interface EnrichmentTally {
  tiers: Record<string, number>; mean_confidence: number; flagship_count: number;
}

/**
 * The enrichment totals for a board: one count per value tier and the mean
 * confidence score across every enriched row. Rows without an enrichment
 * record are skipped, never guessed.
 */
export function tallyEnrichments(rows: BoardEntry[], enrichments: Record<string, EntryEnrichment>): EnrichmentTally {
  const counts: Record<string, number> = {};
  let sum = 0;
  let seen = 0;
  for (const entry of rows) {
    const found = enrichments[entry.slug];
    if (found === undefined) continue;
    counts[found.value_tier] = (counts[found.value_tier] ?? 0) + 1;
    sum += found.confidence_score;
    seen += 1;
  }
  return { tiers: counts, mean_confidence: seen === 0 ? 0 : Math.round(sum / seen), flagship_count: counts.flagship ?? 0 };
}

/** The enrichment record for every board row, keyed by its protocol slug. */
export function enrichBoard(rows: BoardEntry[], snapshot: SnapshotDoc): Record<string, EntryEnrichment> {
  const contexts = contextsByCategory(rows, snapshot);
  const records: Record<string, EntryEnrichment> = {};
  for (const row of rows) records[row.slug] = enrichEntry(row, contexts);
  return records;
}

/** data.js, compact: the dashboard's whole dataset as one script, no fetch and no network. */
export function radarScript(radar: RadarPayload): string {
  return "window.RADAR=" + JSON.stringify(radar) + ";\n";
}
