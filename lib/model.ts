// Token Radar model — radar-2.
//
// The board ranks pre-token protocols by an implied token value derived only
// from the sealed snapshot's own figures. Nothing here names a protocol:
// the same function scores every row.
//
//   implied = tvl_usd x categoryMultiple x growthFactor x ageFactor x plausibility
//
// categoryMultiple — the market's own yardstick. For the protocol's category
//   we take the median market-cap-per-TVL of the token-bearing protocols in
//   that category (at least 3 of them, else the global median), clamped to
//   [0.05, 2.00]. A DEX category whose live tokens trade at 0.34x TVL gives
//   its pre-token peers the same 0.34x; a lending category at 0.13x gives
//   0.13x. The multiple is read from the snapshot at run time, never typed
//   in by hand.
// growthFactor — 1 + clamp(change_7d, -40, +80) / 100. A protocol whose TVL
//   grew 20% in a week is worth 20% more than one standing still; one that
//   shrank 40% is worth 40% less. No 7-day figure: 1.00.
// ageFactor — 1 + 0.12 * log10(1 + ageDays / 365), capped at 1.25. A protocol
//   that has run for years with no token has proven staying power, so a
//   launch would land on a real user base; a two-month-old protocol gets
//   almost no premium. No listing date: 365 days.
// plausibility — not every pre-token record can become a token. A centralised
//   exchange, a bridge, or a liquid-staking wrapper holds other people's
//   assets or another protocol's token, so a launch is unlikely: 0.05. A
//   name that ends in a version marker (V2, 2.0) or carries wrapped /
//   staked / staking, or begins with an exchange's name: 0.50. Everything
//   else: 1.00. The factor is shown on the dashboard, with its reason, so a
//   reader can see why a giant CEX sits low on the board.
//
// The board holds 200 rows: every protocol on the snapshot's watchlist, plus
// the 160 other pre-token protocols with the highest implied value. The
// snapshot's token-bearing protocols are kept apart and counted, never
// ranked: the board is a pre-token board, and the dashboard says so.

/** One protocol entry, exactly the ten fields the sealed snapshot carries. */
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

/** How the model scores one protocol, kept for the dashboard's breakdown. */
export interface ValueBreakdown {
  base_usd: number;
  category_multiple: number;
  growth_factor: number;
  age_factor: number;
  plausibility: number;
  plausibility_reason: string;
}

/** One row of the ranked board, as board.json carries it. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  tvl_usd: number;
}

/** One row as the dashboard reads it: the board row plus its evidence. */
export interface RadarRow extends BoardRow {
  chains: string[];
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  breakdown: ValueBreakdown;
}

/** Everything the dashboard page needs, written out as data.js. */
export interface RadarData {
  meta: {
    model: string;
    as_of: string;
    source: string;
    floor_usd: number;
    tracked: number;
    pre_token: number;
    live_token: number;
    watchlist: number;
    board_rows: number;
    early_left_out: number;
    global_multiple: number;
  };
  rows: RadarRow[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';
/** Rows on the board: the whole watchlist plus this many more pre-token rows. */
export const BOARD_ROWS = 200;

/** Categories whose TVL is custodial or a wrapped product: a token is unlikely. */
const LOW_PLAUSIBILITY_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Exchange names a protocol name must not begin with (case-insensitive). */
const EXCHANGE_NAMES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** A version marker at the end of a name: a space, then V2, v2, 2.0 or the like. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Days between two YYYY-MM-DD dates, whole days, never negative. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** A protocol records no token when DefiLlama gives it no market cap, id or ticker. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The median of a sorted list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The market-cap-per-TVL multiple for every category, read from the
 * snapshot's own token-bearing protocols, plus the global fallback.
 * A category needs at least 3 live tokens to earn its own multiple.
 */
export function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '(none)';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  const global = clamp(median(all), 0.05, 2.0);
  const out = new Map<string, number>();
  for (const [key, list] of byCategory) {
    out.set(key, list.length >= 3 ? clamp(median(list), 0.05, 2.0) : global);
  }
  return { byCategory: out, global };
}

/** Why a protocol's token is plausible or not, and the factor it earns. */
export function plausibility(p: SnapshotProtocol): { factor: number; reason: string } {
  if (p.category !== null && LOW_PLAUSIBILITY_CATEGORIES.has(p.category)) {
    return {
      factor: 0.05,
      reason: `${p.category}: custodial or wrapped value, a token launch is very unlikely`,
    };
  }
  const lower = p.name.toLowerCase();
  if (EXCHANGE_NAMES.some((x) => lower.startsWith(x))) {
    return { factor: 0.5, reason: 'named for an exchange: an exchange token is a different product' };
  }
  if (VERSION_TAIL.test(p.name) || WRAPPED_WORD.test(p.name)) {
    return { factor: 0.5, reason: 'a versioned or wrapped product of a protocol whose token already trades' };
  }
  return { factor: 1.0, reason: 'a standalone protocol whose token has not launched yet' };
}

/** The implied token value of one pre-token protocol, with its breakdown. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Map<string, number>; global: number },
): { implied: number; age: number | null; breakdown: ValueBreakdown } {
  const catMultiple = multiples.byCategory.get(p.category ?? '(none)') ?? multiples.global;
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, -40, 80);
  const growthFactor = 1 + growthPct / 100;
  const age = ageDays(asOf, p.listed_at);
  const ageDaysUsed = age === null ? 365 : age;
  const ageFactor = Math.min(1.25, 1 + 0.12 * Math.log10(1 + ageDaysUsed / 365));
  const plaus = plausibility(p);
  const base = p.tvl_usd * catMultiple;
  const implied = Math.max(1, Math.round(base * growthFactor * ageFactor * plaus.factor));
  return {
    implied,
    age,
    breakdown: {
      base_usd: Math.round(base),
      category_multiple: catMultiple,
      growth_factor: growthFactor,
      age_factor: ageFactor,
      plausibility: plaus.factor,
      plausibility_reason: plaus.reason,
    },
  };
}

/** Parse and check the sealed snapshot document. */
export function parseSnapshot(text: string): Snapshot {
  const doc = JSON.parse(text) as Snapshot;
  if (!Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return doc;
}

// ---------------------------------------------------------------- farm plans

/** One template step: {name} and {chain} are filled in per protocol. */
const FARM_BANKS: Record<string, string[]> = {
  Dexs: [
    'Swap $25–100 on {name} on {chain} once a week to build a steady on-chain history; each swap costs about $0.50–$3 in gas and takes 2–3 minutes.',
    'Add $100–500 of liquidity to one {name} pool on {chain} and leave it for at least 30 days; setup takes 5–20 minutes, then check it weekly for impermanent loss.',
    'Route one larger trade a month, $200–$1,000, through {name} instead of a centralised exchange so the volume is visible on {chain}; a routed trade takes about 5 minutes.',
    'Place one limit order a month on {name} 2–5% away from spot; placing it takes 3–5 minutes and it fills on its own when the price reaches it.',
    'Bridge $50–200 onto {chain} first, then trade it on {name}, so your activity starts on the chain itself; bridging takes 5–15 minutes plus $1–5 in fees.',
  ],
  Lending: [
    'Supply $100–500 of a stablecoin to {name} on {chain} and leave it earning for at least 30 days; the deposit takes about 5 minutes and $0.50–$3 in gas.',
    'Borrow a small amount, $50–200, against your supply on {name} and repay it within two weeks, keeping the health factor above 2; borrowing takes 5 minutes, repaying another 5.',
    'Use the borrowed funds for one more on-chain action, such as a swap on {chain}, instead of letting them sit idle; the round trip takes 10–15 minutes.',
    'Supply a second asset, such as ETH or a liquid-staking token, to a different {name} market on {chain} to spread your activity across markets; about 10 minutes per market.',
    'Check your {name} health factor every Sunday, about 5 minutes, and top up collateral if it falls below 1.5, so a price dip never liquidates your position.',
  ],
  Yield: [
    'Deposit $100–500 into one {name} vault on {chain} and leave it compounding for at least 30 days; the deposit takes 5–10 minutes and $1–4 in gas.',
    'Harvest or compound your {name} rewards once a week, about 5 minutes each time, so the position keeps growing instead of sitting still.',
    'Split a second deposit, $50–200, into a different {name} vault on another chain to show activity across chains; each new vault takes about 10 minutes.',
    'Compare {name}\u2019s vault APY with two similar vaults once a month, about 15 minutes, and move funds only when the gap stays above 2% for a full week.',
    'Withdraw a small test amount, $20–50, from {name} once, to confirm you can exit cleanly; the withdrawal takes 3–5 minutes plus gas.',
  ],
  Derivatives: [
    'Open one small perpetual position, $50–200 with 2x leverage at most, on {name} on {chain}; opening takes 3–5 minutes and $1–5 in fees.',
    'Set a stop-loss 3–5% from your entry on every {name} trade so a bad move costs you a known amount; setting it takes 1 minute per trade.',
    'Close each position within a week and record the entry, exit and fees in a notes file; closing takes 2–3 minutes per trade.',
    'Try one options or structured-product position, $25–100, on {name} to show range beyond perps; the first one takes 10–15 minutes to understand.',
    'Keep total exposure under $500 and never trade more than twice a week on {name}, so fees and losses stay small while the history builds.',
  ],
  RWA: [
    'Buy $100–500 of a tokenised real-world asset on {name} on {chain} and hold it for at least 60 days; the purchase takes 5–10 minutes plus $1–5 in fees.',
    'Read {name}\u2019s asset backing report once a month, about 15 minutes, and note the issuer, custodian and audit date in your own file.',
    'Claim or reinvest any yield {name} pays on your holding, weekly or monthly, about 5 minutes per claim, so the position stays active.',
    'Add a second, different asset class on {name}, $50–200, such as a second treasury or credit product, to widen your footprint; about 10 minutes.',
    'Test a small redemption, $20–50, once on {name} to prove you can exit; redemptions can take 1–3 days to settle, so plan ahead.',
  ],
  CDP: [
    'Lock $200–500 of collateral in a {name} vault on {chain} and mint a modest amount of its stablecoin, keeping the collateral ratio above 200%; setup takes 10–15 minutes.',
    'Use the minted stablecoin for one real payment or swap on {chain} within the week, instead of leaving it idle; about 5 minutes.',
    'Repay half the minted debt within 30 days on {name} to show a full borrow-and-repay cycle; repaying takes 5 minutes plus gas.',
    'Open a second, smaller vault on {name} with a different collateral asset, $100–300, to diversify; about 10 minutes.',
    'Check your {name} collateral ratio every Sunday, about 5 minutes, and add collateral if it drifts below 180% so a price dip never liquidates you.',
  ],
  'Risk Curators': [
    'Deposit $100–500 into a {name} curated vault on {chain} and leave it for at least 30 days; the deposit takes 5–10 minutes and $1–4 in gas.',
    'Read the vault curator\u2019s strategy note on {name} once, about 15 minutes, and write down which markets it allocates to and its fee.',
    'Compare {name}\u2019s vault return with the underlying markets once a month, about 15 minutes, to see what the curator actually adds.',
    'Split a second deposit, $50–200, into a different {name} vault run by another curator; each new vault takes about 10 minutes.',
    'Withdraw a $20–50 test amount from {name} once to confirm the exit path; withdrawals settle in minutes to a day depending on the vault.',
  ],
  'Onchain Capital Allocator': [
    'Deposit $100–500 into an {name} allocation vault on {chain} and hold for at least 30 days; setup takes 5–10 minutes and $1–4 in gas.',
    'Read {name}\u2019s allocation report once a month, about 15 minutes, noting where the capital is deployed and the reported yield.',
    'Claim any distributions {name} pays, about 5 minutes per claim, and reinvest them rather than withdrawing.',
    'Add a second allocation, $50–200, in a different strategy on {name} to show range; about 10 minutes per allocation.',
    'Test a small exit, $20–50, from {name} once to confirm redemptions work; allow 1–3 days for settlement.',
  ],
  'Liquid Staking': [
    'Stake $100–500 of ETH or SOL through {name} on {chain} and hold the receipt token for at least 30 days; staking takes 5 minutes and $1–5 in gas.',
    'Use the receipt token once in another protocol on {chain}, such as supplying it to a lending market, so the stake does real work; about 10 minutes.',
    'Claim staking rewards on {name} monthly, about 5 minutes per claim, and restake them to compound.',
    'Compare {name}\u2019s staking APR with two other staking options once a month, about 15 minutes, and move only if the gap holds for two weeks.',
    'Test unstaking a small amount, $20–50, on {name} once to learn the queue time; unstaking can take minutes to several days.',
  ],
  Bridge: [
    'Bridge $50–200 onto {chain} through {name} once a week for a month, so the volume builds steadily; each bridge takes 5–20 minutes and $1–8 in fees.',
    'Bridge back a small amount, $20–50, on {name} once to complete a round trip; allow up to an hour for the return leg to settle.',
    'Use a different destination chain each week on {name} to show range across chains; each route takes the same 5–20 minutes.',
    'Keep each bridge under $500 and never bridge the same amount twice in a row on {name}, so the pattern reads as real use rather than farming.',
    'Track every bridge in a notes file, about 2 minutes per entry, with date, amount, chains and fee, so the history is clean if it ever matters.',
  ],
  CEX: [
    'Deposit $100–500 onto {name} and make one spot trade a week for a month; each trade takes 2–3 minutes and the exchange fee is usually 0.1% or less.',
    'Withdraw a small amount, $50–100, from {name} to your own wallet once, to prove you control the funds; withdrawals take minutes to an hour.',
    'Use {name}\u2019s earn or savings product once with $50–200 for at least 30 days; setup takes about 5 minutes.',
    'Trade a second pair on {name}, $25–100, to widen your activity beyond a single market; about 5 minutes per trade.',
    'Keep a simple log of deposits, trades and withdrawals on {name}, 2 minutes per entry, so your history is tidy.',
  ],
  Generic: [
    'Use {name} on {chain} once a week for a month, $25–100 per action, to build a steady history; each action takes 3–10 minutes and a few dollars in gas.',
    'Deposit $100–500 into {name} and leave it working for at least 30 days; setup takes 5–15 minutes.',
    'Try a second feature of {name} on {chain}, such as a different market or pool, with $50–200; about 10 minutes.',
    'Check your {name} position every Sunday, about 5–10 minutes, and record each action with its date and cost in a notes file.',
    'Test a small withdrawal of $20–50 from {name} once to confirm you can exit; allow minutes to a few days for it to settle.',
  ],
};

/** The bank for a category: Yield Aggregator shares Yield, the bridges share Bridge. */
function bankFor(category: string | null): string[] {
  if (category === 'Yield Aggregator') return FARM_BANKS['Yield']!;
  if (category === 'Canonical Bridge' || category === 'Cross Chain Bridge') return FARM_BANKS['Bridge']!;
  if (category !== null && FARM_BANKS[category] !== undefined) return FARM_BANKS[category]!;
  return FARM_BANKS['Generic']!;
}

/** A sixth step, written from this protocol's own 7-day move. */
function timingStep(p: SnapshotProtocol): string {
  if (p.change_7d !== null && p.change_7d > 10) {
    return `TVL is up ${p.change_7d.toFixed(1)}% in 7 days on ${p.name}, so start small \u2014 a $50 test action first \u2014 and scale up only after a second week of growth; the test takes 5 minutes.`;
  }
  if (p.change_7d !== null && p.change_7d < -10) {
    return `TVL is down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days on ${p.name}, so keep first deposits under $100 and re-check in two weeks before adding more; the check takes 5 minutes.`;
  }
  return `Set a calendar reminder for the 1st of next month, 10 minutes, to re-check ${p.name}\u2019s TVL and your position, and only add funds when the numbers still justify it.`;
}

/** The farm plan for one protocol: its category's bank, filled in, plus a timing step. */
export function farmSteps(p: SnapshotProtocol): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const steps = bankFor(p.category).map((t) => t.replaceAll('{name}', p.name).replaceAll('{chain}', chain));
  steps.push(timingStep(p));
  return steps;
}

// ---------------------------------------------------------------- board

/** Build the ranked board: the whole watchlist plus the best other pre-token rows. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isPreToken)
    .map((p) => {
      const { implied, age, breakdown } = impliedValue(p, snapshot.as_of, multiples);
      return { p, implied, age, breakdown };
    })
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Take the best rows, then swap in any watchlist protocol the cut left out.
  const chosen = scored.slice(0, BOARD_ROWS);
  const chosenSlugs = new Set(chosen.map((c) => c.p.slug));
  for (const slug of snapshot.watchlist) {
    if (chosenSlugs.has(slug)) continue;
    const row = scored.find((c) => c.p.slug === slug);
    if (row === undefined) continue;
    let replaced = chosen.length - 1;
    while (replaced >= 0 && watchlist.has(chosen[replaced]!.p.slug)) replaced -= 1;
    if (replaced < 0) break;
    chosen[replaced] = row;
    chosenSlugs.add(slug);
  }
  chosen.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Ranks 1..N, values strictly non-increasing (a $1 nudge only breaks exact ties).
  const rows: BoardRow[] = [];
  let prev = Number.POSITIVE_INFINITY;
  chosen.forEach((c, i) => {
    let value = c.implied;
    if (value >= prev) value = prev - 1;
    if (value < 1) value = 1;
    prev = value;
    rows.push({
      slug: c.p.slug,
      name: c.p.name,
      rank: i + 1,
      implied_value_usd: value,
      farm_steps: farmSteps(c.p),
      category: c.p.category,
      tvl_usd: c.p.tvl_usd,
    });
  });
  return rows;
}

/** The gate's own shape checks, run before anything is written. First issue or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, the gate wants 100 to 4000`;
  const slugs = new Set<string>();
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (const row of board) {
    if (!bySlug.has(row.slug)) return `row names ${row.slug}, not one of the snapshot's protocols`;
    if (slugs.has(row.slug)) return `slug ${row.slug} appears twice`;
    slugs.add(row.slug);
    if (row.name.trim() === '') return `row ${row.slug} has an empty name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has rank ${row.rank}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${row.farm_steps.length} farm steps, the gate wants 3 to 12`;
    }
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters, the gate wants 20 to 600`;
    }
  }
  const ranks = [...board.map((r) => r.rank)].sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `ranks are not exactly 1 to ${board.length}`;
  const sorted = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.implied_value_usd > sorted[i - 1]!.implied_value_usd) {
      return `implied value rises from rank ${sorted[i - 1]!.rank} to rank ${sorted[i]!.rank}`;
    }
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every row has the same implied value: the board ranks nothing';
  }
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

// ---------------------------------------------------------------- radar data

/** The full board plus the evidence the dashboard page renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const preCount = snapshot.protocols.filter(isPreToken).length;
  const boardSlugs = new Set(board.map((r) => r.slug));
  const rows: RadarRow[] = board.map((row) => {
    const p = bySlug.get(row.slug)!;
    const { age, breakdown } = impliedValue(p, snapshot.as_of, multiples);
    return {
      ...row,
      chains: p.chains,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: age,
      watchlist: watchlist.has(p.slug),
      breakdown,
    };
  });
  const radar: RadarData = {
    meta: {
      model: MODEL_VERSION,
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      tracked: snapshot.protocols.length,
      pre_token: preCount,
      live_token: snapshot.protocols.length - preCount,
      watchlist: snapshot.watchlist.length,
      board_rows: board.length,
      early_left_out: preCount - boardSlugs.size,
      global_multiple: multiples.global,
    },
    rows,
  };
  return { board, radar };
}

/** The dashboard's data file: window.TOKEN_RADAR, safe inside a <script> tag. */
export function dataScript(radar: RadarData): string {
  return `window.TOKEN_RADAR = ${JSON.stringify(radar).replaceAll('<', '\\u003c')};\n`;
}
