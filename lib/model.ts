// The token radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// other pre-token protocol the exclusion rule keeps: a protocol is pre-token when its index entry
// records no token (no market cap, no CoinGecko id, no symbol), and it is rankable when it is also
// not a wrapped, staked or bridged product of a token that already trades. The snapshot's
// live-token protocols are kept apart and shown as the market's own values, never mixed into the
// ranked board.
//
// Implied value follows only from the snapshot's own figures, calibrated on the snapshot itself:
//
//   category multiple  = the median market-cap-per-TVL of the live-token protocols in the
//                        protocol's own category (at least 3 of them; otherwise the median over
//                        all live-token protocols), clamped to [0.05, 1.5]. What the market
//                        actually pays for a dollar of TVL differs by line of business: lending
//                        and staking trade near 0.1x, exchanges near 0.3x, bridges near 1x.
//   growth             = clamp(change_7d, -60, 120) per cent
//   growth multiplier  = 1 + (growth / 100) x 0.5
//   maturity           = 0.6 + 0.4 x ln(1 + age_days / 365) / ln(4), clamped to [0.6, 1.0]
//                        (age_days unknown: 365). Older no-token protocols are riper, with
//                        diminishing returns: a year in is 0.8, three years in is 1.0.
//   chain breadth      = 1 + 0.03 x min(chains - 1, 8), at most 1.24. A protocol live on more
//                        chains has more surface for a launch.
//   implied            = max(1, round(tvl_usd x category multiple x growth multiplier
//                        x maturity multiplier x chain breadth))
//
// No protocol name is ever special-cased: the same function scores every row, and every constant
// the calibration uses is read off the snapshot at run time.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  multiple_min_samples: number;
  chain_step: number;
  chain_max_steps: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 1.5,
  multiple_min_samples: 3,
  chain_step: 0.03,
  chain_max_steps: 8,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One calibrated multiple: the market's price per dollar of TVL for a line of business. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  n: number;
}

/** The calibration the snapshot itself yields: a multiple per category, plus the global fallback. */
export interface Calibration {
  global: number;
  byCategory: CategoryMultiple[];
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  enrichments?: Record<string, RowEnrichment>;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted list of numbers, or `fallback` when it holds none. */
function median(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Clamp a multiple into the model's [floor, cap]. */
function clampMultiple(x: number, model: ModelConstants): number {
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, x));
}

/**
 * Calibrate the model on the snapshot itself: for each category, the median market-cap-per-TVL
 * of its live-token protocols (market cap and TVL both positive, at least `multiple_min_samples`
 * of them); categories short of samples fall back to the median over every live-token protocol.
 * The calibration is data, not a list: it is recomputed from whatever snapshot is handed in.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const global = clampMultiple(median(live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b), 0.25), model);
  const byCategory: CategoryMultiple[] = [];
  const cats = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const arr = cats.get(key);
    if (arr) arr.push(p.mcap_usd! / p.tvl_usd);
    else cats.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  for (const [category, multiples] of [...cats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (multiples.length < model.multiple_min_samples) continue;
    byCategory.push({ category, multiple: clampMultiple(median(multiples.sort((a, b) => a - b), global), model), n: multiples.length });
  }
  return { global, byCategory };
}

/** The multiple a protocol's category calibrates to, or the global fallback. */
export function categoryMultiple(p: SnapshotProtocol, calibration: Calibration, model: ModelConstants = MODEL): number {
  const key = p.category ?? 'Other';
  const hit = calibration.byCategory.find((c) => c.category === key);
  if (hit) return hit.multiple;
  return clampMultiple(calibration.global, model);
}

/** The maturity multiplier: older no-token protocols are riper, with diminishing returns. */
export function maturityMultiplier(age: number | null, model: ModelConstants = MODEL): number {
  const ageForModel = age ?? model.unknown_age_days;
  const x = Math.log(1 + Math.max(ageForModel, 0) / 365) / Math.log(4);
  return Math.min(1, Math.max(model.maturity_floor, model.maturity_floor + model.maturity_range * x));
}

/** The chain-breadth multiplier: more chains, more surface for a launch. */
export function chainMultiplier(chains: string[], model: ModelConstants = MODEL): number {
  const steps = Math.min(Math.max(chains.length - 1, 0), model.chain_max_steps);
  return 1 + model.chain_step * steps;
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
  model: ModelConstants = MODEL,
): { implied: number; categoryMult: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const maturityMult = maturityMultiplier(age, model);
  const chainMult = chainMultiplier(protocol.chains, model);
  const categoryMult = categoryMultiple(protocol, calibration, model);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * categoryMult * growthMult * maturityMult * chainMult));
  return { implied, categoryMult, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a rankable protocol's name never begins with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word that marks a name as a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that already trades, not an exchange, not a versioned pool. The watchlist's
 * own rule, applied to every row below the floor too.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrate(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its TVL. The floor is never
  // the whole board: the smallest pre-token protocols are the ones a launch radar exists to find.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, calibration, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: round4(s.categoryMult),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('launchpad')) return `Join ${name}'s next launch on ${chain} with $${capital} and hold the allocation.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the shares.`;
  if (c.includes('option')) return `Deposit $${capital} of USDC into ${name}'s vault on ${chain} and keep the position open.`;
  if (c.includes('nft')) return `List or buy one item on ${name} on ${chain} and keep the activity on the same wallet.`;
  if (c.includes('payment') || c.includes('card')) return `Spend $${capital} through ${name} on ${chain} and keep the receipts on the same wallet.`;
  if (c.includes('privacy')) return `Use $${capital} through ${name}'s private flow on ${chain} and keep the receipt.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold the shares.`;
  if (c.includes('ai')) return `Use $${capital} of ${name}'s agent or tool on ${chain} and keep the activity on the same wallet.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, fitted to what the protocol does. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return 'open and close one small trade';
  if (c.includes('dex') || c.includes('yield')) return 'add or remove a little liquidity, or one swap';
  if (c.includes('lend') || c.includes('cdp')) return 'adjust the position, or borrow and repay a little';
  if (c.includes('bridge')) return 'bridge a small amount back or forth';
  if (c.includes('prediction')) return 'place one small market position';
  if (c.includes('staking') || c.includes('restak')) return 'restake the rewards, or stake a little more';
  if (c.includes('launchpad')) return 'vote in a launch or check the new listings';
  return 'a deposit, a borrow, a swap or a vote';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const weekly = weeklyActionFor(p);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as ${weekly}.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrate(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const boardCats = new Set(board.map((r) => r.category ?? 'Other'));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration: {
      global: calibration.global,
      byCategory: calibration.byCategory.filter((c) => boardCats.has(c.category)),
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The enrichment layer's own version label, carried into the summary and the dashboard data. */
export const ENRICHMENT_VERSION = 'radar-2.1-enrichment';

/**
 * One category's context, as the enrichment layer reports it for a row: how many pre-token
 * protocols share the category, how much TVL they hold together, the middle TVL among them, and
 * the benchmark multiple the snapshot's own live-token protocols in that category imply.
 */
export interface CategoryContext {
  category: string;
  pre_token_count: number;
  total_tvl_usd: number;
  median_tvl_usd: number;
  benchmark_multiple: number;
  live_sample_count: number;
}

/** The extra fields the enrichment layer attaches to one board row, all derived, none scored. */
export interface RowEnrichment {
  slug: string;
  confidence_score: number;
  value_tier: string;
  maturity_label: string;
  chain_count: number;
  category_context: CategoryContext;
}

/** The middle value of a list of numbers, or `fallback` when the list holds nothing. */
function middleValue(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/**
 * How complete a row's own record is, from zero to one hundred. A row earns its points from
 * what the snapshot actually carries for it: a positive TVL is worth 35, a recorded seven-day
 * change is worth 20, a known category is worth 15, a listing date is worth 15, and chain
 * breadth is worth up to 15, one quarter of it per chain up to four chains. A row with every
 * field present scores 100; a row with only a TVL scores 35. Nothing here feeds back into the
 * implied value, so the score can only describe a row, never move it.
 */
export function confidenceScore(row: BoardRow): number {
  let points = 0;
  if (row.tvl_usd > 0) points += 35;
  if (row.change_7d !== null) points += 20;
  if (row.category !== null && row.category !== '') points += 15;
  if (row.listed_at !== null && row.listed_at !== '') points += 15;
  const chainShare = 15 * Math.min(row.chains.length, 4) / 4;
  return Math.round(points + chainShare);
}

/**
 * The value tier a dollar figure falls into. The bands are wide on purpose: they are a reading
 * aid for the dashboard, not a second ranking, and moving a band would never change a row's
 * place on the board.
 */
export function valueTier(impliedUsd: number): string {
  if (impliedUsd >= 500_000_000) return 'flagship';
  if (impliedUsd >= 100_000_000) return 'major';
  if (impliedUsd >= 25_000_000) return 'notable';
  if (impliedUsd >= 5_000_000) return 'emerging';
  return 'nascent';
}

/**
 * The maturity label for an age in days. Three years with no token is seasoned, a year is
 * established, half a year is maturing, anything younger is young, and a missing listing date
 * says so instead of guessing.
 */
export function maturityLabel(ageDays: number | null): string {
  if (ageDays === null) return 'unknown age';
  if (ageDays >= 1095) return 'seasoned';
  if (ageDays >= 365) return 'established';
  if (ageDays >= 180) return 'maturing';
  return 'young';
}

/**
 * One context object per category on the board. The pre-token side comes from the board rows
 * themselves: how many of them the category holds, their combined TVL, and the middle TVL
 * among them. The benchmark side comes from the snapshot's live-token protocols in that same
 * category: the median market-cap-per-TVL among them, read off the snapshot at run time, with
 * the global median as the fallback when a category has fewer than three live samples. The
 * benchmark is clamped to the same [0.05, 1.5] band the scoring multiple uses, so a thin
 * category cannot report a wild benchmark. No number here is written by hand.
 */
export function buildCategoryContexts(rows: BoardRow[], snapshot: Snapshot): Map<string, CategoryContext> {
  const liveByCategory = new Map<string, number[]>();
  const liveAll: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    liveAll.push(ratio);
    const key = p.category ?? 'Other';
    const bucket = liveByCategory.get(key);
    if (bucket) bucket.push(ratio);
    else liveByCategory.set(key, [ratio]);
  }
  const globalBenchmark = middleValue(liveAll, 0.25);
  const grouped = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const key = row.category ?? 'Other';
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  const contexts = new Map<string, CategoryContext>();
  const names = [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const category of names) {
    const members = grouped.get(category)!;
    const tvls = members.map((r) => r.tvl_usd);
    const samples = liveByCategory.get(category) ?? [];
    const rawBenchmark = samples.length >= 3 ? middleValue(samples, globalBenchmark) : globalBenchmark;
    contexts.set(category, {
      category,
      pre_token_count: members.length,
      total_tvl_usd: tvls.reduce((sum, v) => sum + v, 0),
      median_tvl_usd: middleValue(tvls, 0),
      benchmark_multiple: Math.round(Math.min(1.5, Math.max(0.05, rawBenchmark)) * 1e4) / 1e4,
      live_sample_count: samples.length,
    });
  }
  return contexts;
}

/**
 * The enrichment record for one row: its confidence score, its value tier, its maturity label,
 * how many chains it runs on, and the context of its category. The category context falls back
 * to the row's own figures when the category was never built, so this function always returns
 * a complete record.
 */
export function enrichRow(row: BoardRow, contexts: Map<string, CategoryContext>): RowEnrichment {
  const key = row.category ?? 'Other';
  const context = contexts.get(key) ?? {
    category: key,
    pre_token_count: 1,
    total_tvl_usd: row.tvl_usd,
    median_tvl_usd: row.tvl_usd,
    benchmark_multiple: row.model.category_multiple,
    live_sample_count: 0,
  };
  return {
    slug: row.slug,
    confidence_score: confidenceScore(row),
    value_tier: valueTier(row.implied_value_usd),
    maturity_label: maturityLabel(row.age_days),
    chain_count: row.chains.length,
    category_context: context,
  };
}

/** The enrichment layer's totals: how many board rows fall into each value tier, and the mean confidence. */
export interface EnrichmentSummary {
  tiers: Record<string, number>;
  mean_confidence: number;
  flagship_count: number;
}

/**
 * The enrichment totals for a board: one count per value tier and the mean confidence score
 * across every enriched row. Rows without an enrichment record are skipped, never guessed.
 */
export function summarizeEnrichments(rows: BoardRow[], enrichments: Record<string, RowEnrichment>): EnrichmentSummary {
  const tiers: Record<string, number> = {};
  let total = 0;
  let counted = 0;
  for (const row of rows) {
    const e = enrichments[row.slug];
    if (e === undefined) continue;
    tiers[e.value_tier] = (tiers[e.value_tier] ?? 0) + 1;
    total += e.confidence_score;
    counted += 1;
  }
  return {
    tiers,
    mean_confidence: counted === 0 ? 0 : Math.round(total / counted),
    flagship_count: tiers.flagship ?? 0,
  };
}

/** The enrichment record for every board row, keyed by protocol slug. */
export function buildEnrichments(rows: BoardRow[], snapshot: Snapshot): Record<string, RowEnrichment> {
  const contexts = buildCategoryContexts(rows, snapshot);
  const out: Record<string, RowEnrichment> = {};
  for (const row of rows) out[row.slug] = enrichRow(row, contexts);
  return out;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
