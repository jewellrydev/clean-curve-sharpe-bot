// agent-fun/replay/v2 bot shim for Node 22. Zero dependencies and erasable TypeScript only, so it
// runs as-is under the grader's fixed command `node /bot/main.ts` (Node strips the types; no build,
// no install). Copy this one file into your bot's repository (vendor/agentfun-bot.ts keeps it out of
// the authorship counts) and hand runBot your strategy:
//
//   import { runBot, LAMPORTS_PER_SOL } from './vendor/agentfun-bot.ts';
//
//   await runBot({
//     onHello(state) {},               // optional: once, before the first batch
//     onBatch(state, batch) {          // once per batch: the orders decided on this slot
//       return [{ side: 'buy', mint, quote_lamports: LAMPORTS_PER_SOL / 20n, max_slippage_bps: 500 }];
//     },
//     onDone(state, done) {},         // optional: once, last; no reply is sent
//   });
//
// The shim owns the wire. It reads one JSON line at a time from stdin (each at most
// MAX_HARNESS_LINE_BYTES), keeps `state` current (account, positions, every curve's latest reserves,
// the orders still in flight), calls onBatch and writes exactly one reply per batch (at most
// MAX_BOT_LINE_BYTES), echoing the batch's seq, before it reads the next line. Amounts may be bigint,
// u64 decimal strings or safe integers; the shim writes them as decimal strings and fills in client_id
// when you leave it out. An order the harness would treat as a protocol violation (malformed mint,
// amount, bps or client_id, a client_id starting with `_`, an unknown key, a reply line over the
// limit) throws OrderError here, so a broken bot fails on your machine and not in grading. So does a
// reply with more orders than hello.caps.max_orders_per_batch: the harness rejects the orders past
// the cap and fails the run on a reply over it. Orders the market refuses (position and size caps,
// cash, slippage) are not errors: they come back in a later batch's fills with status "rejected" and
// a reason.
//
// Two market rules worth knowing before you size orders: the buys on one coin in one reply share one
// size cap (state.maxBuyLamports), and your own fills on one coin in one slot move the reserves for
// each other, so splitting an order never gets you a better price than sending it whole.
//
// stdout carries replies only: write diagnostics to stderr (console.error). Determinism: every entry
// is executed twice and the two action logs must match byte for byte, so never read the clock, the
// environment or Math.random; seed any randomness from state.hello.seed.

export const PROTOCOL = 'agent-fun/replay/v2';

/** Harness -> bot lines are at most this many UTF-8 bytes, the `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines (your replies) are at most this many UTF-8 bytes, the `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Basis points per unit: 10_000 bps = 100%. */
export const BPS = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

// --------------------------------------------------------------------------- wire types (contracts/protocol.ts)

/** A u64 as a canonical decimal string; read it with BigInt. */
export type U64 = string;
/** An i64 as a canonical decimal string. */
export type I64 = string;
/** A base58 Solana address. */
export type Pubkey = string;

export interface Universe {
  program: typeof PUMP_PROGRAM_ID;
  quote: 'SOL';
  /** Mayhem-mode coins (CreateEvent is mayhem mode) are never delivered. */
  mayhem: 'excluded';
  /** Cashback-enabled coins (CreateEvent is cashback enabled) are never delivered. */
  exclude_cashback: true;
  /** A mint is in iff sha256(base58 mint) as a big-endian integer mod modulus equals residue. */
  sample: { hash: 'sha256'; modulus: number; residue: number };
}

export type CurveKind = 'bonding';

export interface Curve {
  mint: Pubkey;
  kind: CurveKind;
  bonding_curve: Pubkey;
  creator: Pubkey;
  created_slot: number | null;
  complete: boolean;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
  // --- Derived fields (not on the wire; the shim computes them from the event stream.) ---
  /** Lamports per whole token, scaled by 1e9: lamports/token * 1e9, from virtual reserves. */
  price_lamports_per_token_x1e9: U64;
  /** Real quote reserves in lamports, as a BigInt. */
  real_quote_lamports: bigint;
  /** Whole-token supply (virtual token reserves / 1e6), rounded down. */
  supply_tokens: bigint;
  /** Virtual token reserves / virtual quote reserves, as a float. */
  tokens_per_lamport: number;
  /** Virtual quote reserves / virtual token reserves, as a float (lamports per whole token). */
  lamports_per_token: number;
  /** (virtual_quote_reserves - real_quote_reserves) / virtual_quote_reserves * 100, 0..100. */
  complete_pct: number;
}

export interface Caps {
  max_open_positions: number;
  max_orders_per_batch: number;
  /** The smallest buy the market accepts, in lamports. */
  min_buy_lamports: U64;
  /** A buy may not exceed this share of a curve's real quote reserves, in basis points. */
  max_buy_share_bps: number;
  /** A sell may not exceed this share of your position, in basis points. */
  max_sell_share_bps: number;
  /** An open order may sit unfilled for at most this many slots. */
  max_order_lifetime_slots: number;
  /** Open positions' total cost may not exceed this share of starting capital, in basis points. */
  max_exposure_bps: number;
  /** Fee charged per order, in lamports, taken from the cash balance. */
  tx_fee_lamports: U64;
}

export interface HelloMessage {
  type: 'hello';
  protocol: typeof PROTOCOL;
  /** The entry's seed (see the determinism note in the header). */
  seed: U64;
  universe: Universe;
  caps: Caps;
  /** Starting cash, in lamports. */
  starting_capital_lamports: U64;
  /** Slots per batch, as a number. */
  slots_per_batch: number;
  /** Total batches in the run. */
  total_batches: number;
  /** Slots per hour, as a number. */
  slots_per_hour: number;
  /** The harness binary's build identifier. */
  harness_version: string;
  /** First slot of the replay (batch 0 covers slots [start_slot, start_slot + slots_per_batch)). */
  start_slot: number;
}

export type Event =
  | {
      event: 'CreateEvent';
      mint: Pubkey;
      bonding_curve: Pubkey;
      creator: Pubkey;
      slot: number;
    }
  | {
      event: 'TradeEvent';
      mint: Pubkey;
      bonding_curve: Pubkey;
      slot: number;
      user: Pubkey;
      is_buy: boolean;
      /** Lamports spent (buys) or received (sells), a u64 string. */
      sol_amount: U64;
      /** Whole tokens bought (buys) or sold (sells), a u64 string. */
      token_amount: U64;
      virtual_token_reserves: U64;
      virtual_quote_reserves: U64;
      real_token_reserves: U64;
      real_quote_reserves: U64;
    }
  | {
      event: 'CompleteEvent';
      mint: Pubkey;
      bonding_curve: Pubkey;
      slot: number;
      user: Pubkey;
    }
  | {
      event: 'SetParamsEvent';
      mint: Pubkey;
      bonding_curve: Pubkey;
      slot: number;
      fee_recipient: Pubkey;
      initial_virtual_token_reserves: U64;
      initial_virtual_quote_reserves: U64;
      initial_real_token_reserves: U64;
      initial_real_quote_reserves: U64;
      token_total_supply: U64;
      fee_basis_points: U64;
    }
  | {
      event: 'CreateEventV2';
      mint: Pubkey;
      bonding_curve: Pubkey;
      creator: Pubkey;
      slot: number;
      mayhem_mode: boolean;
      is_cashback_enabled: boolean;
    }
  | {
      event: 'CompletePumpAmmMigrationEvent';
      mint: Pubkey;
      bonding_curve: Pubkey;
      slot: number;
      user: Pubkey;
    };

export type FillStatus = 'filled' | 'rejected' | 'expired';

export interface Fill {
  order_id: string;
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  /** The submitted order's size. */
  quote_lamports: U64;
  token_amount: U64;
  status: FillStatus;
  /** Lamports spent (buys) or received (sells); '0' when rejected or expired. */
  filled_quote_lamports: U64;
  /** Whole tokens bought or sold; '0' when rejected or expired. */
  filled_token_amount: U64;
  /** Average fill price, lamports per whole token, scaled by 1e9; '0' when rejected or expired. */
  avg_price_lamports_per_token_x1e9: U64;
  slot: number;
  /** Only on rejected fills: why the market refused the order. */
  reason?: string;
}

export interface BatchMessage {
  type: 'batch';
  seq: number;
  /** First slot of this batch. */
  slot: number;
  /** Events in slot order, as they happened. */
  events: Event[];
  /** Fills for orders submitted in earlier batches, in submission order. */
  fills: Fill[];
  /** Cash balance in lamports after this batch's fills, as a u64 string. */
  cash_lamports: U64;
  /** Total fees paid so far, in lamports, as a u64 string. */
  total_fees_lamports: U64;
}

export interface DoneMessage {
  type: 'done';
  /** Final cash in lamports, as a u64 string. */
  final_cash_lamports: U64;
  /** Total fees paid, in lamports, as a u64 string. */
  total_fees_lamports: U64;
  /** Open positions liquidated at the end, valued at their final price. */
  liquidated_positions_value_lamports: U64;
  total_batches: number;
}

export type Inbound = HelloMessage | BatchMessage | DoneMessage;

export interface Position {
  mint: Pubkey;
  /** Whole tokens held. */
  token_amount: bigint;
  /** Lamports paid for the tokens still held (fees excluded). */
  cost_lamports: bigint;
  /** Lamports paid, including the part already sold. */
  total_cost_lamports: bigint;
  /** Lamports received from the part already sold (fees excluded). */
  realized_lamports: bigint;
  entry_slot: number;
}

export type OrderSide = 'buy' | 'sell';

export interface OrderInput {
  side: OrderSide;
  mint: Pubkey;
  /** Size for buys, in lamports. Ignored on sells (a sell always exits the whole position). */
  quote_lamports?: bigint | U64 | number;
  /** Size for sells, in whole tokens. Defaults to the whole position. */
  token_amount?: bigint | U64 | number;
  /** In basis points; defaults to 10_000 (no limit). */
  max_slippage_bps?: number;
  /** Opaque per-order id for reconciling fills; must not start with `_`. Omit to let the shim fill it in. */
  client_id?: string;
}

interface OrderWire {
  side: OrderSide;
  mint: Pubkey;
  quote_lamports: U64;
  token_amount: U64;
  max_slippage_bps: number;
  client_id: string;
}

export interface ReplyMessage {
  type: 'reply';
  seq: number;
  orders: OrderWire[];
}

type Outbound = ReplyMessage;

/** The state your strategy sees. The shim owns it and updates it between batches. */
export interface BotState {
  hello: HelloMessage;
  /** Latest batch number, starting at 0; -1 before the first batch. */
  batch: number;
  /** First slot of the latest batch; -1 before the first batch. */
  slot: number;
  /** Cash balance in lamports, after the latest batch's fills. */
  cash_lamports: bigint;
  /** Total fees paid so far, in lamports. */
  total_fees_lamports: bigint;
  /** Every curve delivered so far, keyed by mint, in first-seen order. */
  curves: Map<Pubkey, Curve>;
  /** Open positions, keyed by mint, in entry order. */
  positions: Map<Pubkey, Position>;
  /** Orders still in flight (submitted, not yet filled), keyed by client_id, in submission order. */
  pending: Map<string, { order: OrderWire; submitted_seq: number }>;
  /** Fills from the latest batch, in submission order. */
  fills: Fill[];
  /** Events from the latest batch, in slot order. */
  events: Event[];
  /** Number of entries you have made in this run (fills, buys only). */
  entriesCount: number;
  /** Number of exits you have made in this run (fills, sells only). */
  exitsCount: number;
  /** Lamports spent on entries so far (fees excluded). */
  totalBoughtLamports: bigint;
  /** Lamports received from exits so far (fees excluded). */
  totalSoldLamports: bigint;
  /** Number of open positions, excluding orders still in flight. */
  committedPositionCount(): number;
  /** Cash not tied up in pending buys, in lamports. */
  freeCashLamports(): bigint;
  /** Transaction fee per order, in lamports. */
  txFeeLamports(): bigint;
  /** Largest buy the market accepts on this curve right now, in lamports. */
  maxBuyLamports(mint: Pubkey): bigint;
  /** The position's current market value in lamports, or null if there is no position or curve. */
  positionValueLamports(mint: Pubkey): bigint | null;
  /** Sum of all open positions' current market values, in lamports. */
  totalPositionValueLamports(): bigint;
  /** Cash plus positions at current prices, in lamports. */
  equityLamports(): bigint;
}

export interface Bot {
  onHello?(state: BotState): void;
  onBatch(state: BotState, batch: BatchMessage): OrderInput[];
  onDone?(state: BotState, done: DoneMessage): void;
}

/** Thrown when a reply would violate the protocol; see the header note. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

/** Base58 alphabet, in canonical order. */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LAMPORTS_PER_TOKEN = 1_000_000n;
const X1E9 = 1_000_000_000n;

function fail(message: string): never {
  throw new OrderError(message);
}

function isBase58(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  for (const ch of value) if (!BASE58.includes(ch)) return false;
  return true;
}

function toU64(value: bigint | U64 | number, what: string): U64 {
  if (typeof value === 'bigint') {
    if (value < 0n || value > U64_MAX) fail(`${what} is out of range: ${value}`);
    return value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${what} is out of range: ${value}`);
    return BigInt(value).toString(10);
  }
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) fail(`${what} is not a canonical u64 string: ${value}`);
    let n = 0n;
    try {
      n = BigInt(value);
    } catch {
      fail(`${what} is not a canonical u64 string: ${value}`);
    }
    if (n > U64_MAX) fail(`${what} is out of range: ${value}`);
    return value;
  }
  return fail(`${what} has an unsupported type: ${typeof value}`);
}

function cmpU64(a: U64, b: U64): number {
  const aa = a.replace(/^0+(?=[0-9])/, '');
  const bb = b.replace(/^0+(?=[0-9])/, '');
  if (aa.length !== bb.length) return aa.length < bb.length ? -1 : 1;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function checkBatch(message: unknown): asserts message is BatchMessage {
  if (typeof message !== 'object' || message === null) fail('batch message is not an object');
  const m = message as Record<string, unknown>;
  if (m['type'] !== 'batch') fail(`expected a batch message, got ${JSON.stringify(m['type'])}`);
  if (typeof m['seq'] !== 'number' || !Number.isSafeInteger(m['seq']) || m['seq'] < 0) {
    fail(`batch seq is not a non-negative integer: ${JSON.stringify(m['seq'])}`);
  }
  if (typeof m['slot'] !== 'number' || !Number.isSafeInteger(m['slot']) || m['slot'] < 0) {
    fail(`batch slot is not a non-negative integer: ${JSON.stringify(m['slot'])}`);
  }
  if (!Array.isArray(m['events'])) fail('batch events is not an array');
  if (!Array.isArray(m['fills'])) fail('batch fills is not an array');
  if (typeof m['cash_lamports'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(m['cash_lamports'])) {
    fail(`batch cash_lamports is not a canonical u64 string: ${JSON.stringify(m['cash_lamports'])}`);
  }
  if (typeof m['total_fees_lamports'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(m['total_fees_lamports'])) {
    fail(`batch total_fees_lamports is not a canonical u64 string: ${JSON.stringify(m['total_fees_lamports'])}`);
  }
  const events = m['events'] as Record<string, unknown>[];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (typeof e !== 'object' || e === null || typeof e['event'] !== 'string') {
      fail(`batch event ${i} is not an object with an event field`);
    }
    if (!isBase58(e['mint'])) fail(`batch event ${i} mint is not a base58 address: ${JSON.stringify(e['mint'])}`);
    if (!isBase58(e['bonding_curve'])) {
      fail(`batch event ${i} bonding_curve is not a base58 address: ${JSON.stringify(e['bonding_curve'])}`);
    }
    if (typeof e['slot'] !== 'number' || !Number.isSafeInteger(e['slot']) || e['slot'] < 0) {
      fail(`batch event ${i} slot is not a non-negative integer: ${JSON.stringify(e['slot'])}`);
    }
  }
  const fills = m['fills'] as Record<string, unknown>[];
  for (let i = 0; i < fills.length; i += 1) {
    const f = fills[i];
    if (typeof f !== 'object' || f === null) fail(`batch fill ${i} is not an object`);
    if (typeof f['order_id'] !== 'string' || f['order_id'].length === 0) {
      fail(`batch fill ${i} order_id is not a non-empty string`);
    }
    if (typeof f['client_id'] !== 'string' || f['client_id'].length === 0) {
      fail(`batch fill ${i} client_id is not a non-empty string`);
    }
    if (!isBase58(f['mint'])) fail(`batch fill ${i} mint is not a base58 address: ${JSON.stringify(f['mint'])}`);
    if (f['side'] !== 'buy' && f['side'] !== 'sell') {
      fail(`batch fill ${i} side is not buy or sell: ${JSON.stringify(f['side'])}`);
    }
    if (typeof f['quote_lamports'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(f['quote_lamports'])) {
      fail(`batch fill ${i} quote_lamports is not a canonical u64 string: ${JSON.stringify(f['quote_lamports'])}`);
    }
    if (typeof f['token_amount'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(f['token_amount'])) {
      fail(`batch fill ${i} token_amount is not a canonical u64 string: ${JSON.stringify(f['token_amount'])}`);
    }
    if (f['status'] !== 'filled' && f['status'] !== 'rejected' && f['status'] !== 'expired') {
      fail(`batch fill ${i} status is not filled, rejected or expired: ${JSON.stringify(f['status'])}`);
    }
    if (typeof f['filled_quote_lamports'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(f['filled_quote_lamports'])) {
      fail(`batch fill ${i} filled_quote_lamports is not a canonical u64 string: ${JSON.stringify(f['filled_quote_lamports'])}`);
    }
    if (typeof f['filled_token_amount'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(f['filled_token_amount'])) {
      fail(`batch fill ${i} filled_token_amount is not a canonical u64 string: ${JSON.stringify(f['filled_token_amount'])}`);
    }
    if (
      typeof f['avg_price_lamports_per_token_x1e9'] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(f['avg_price_lamports_per_token_x1e9'])
    ) {
      fail(`batch fill ${i} avg_price_lamports_per_token_x1e9 is not a canonical u64 string`);
    }
    if (typeof f['slot'] !== 'number' || !Number.isSafeInteger(f['slot']) || f['slot'] < 0) {
      fail(`batch fill ${i} slot is not a non-negative integer: ${JSON.stringify(f['slot'])}`);
    }
  }
}

function deriveCurve(
  mint: Pubkey,
  bondingCurve: Pubkey,
  creator: Pubkey,
  createdSlot: number | null,
  complete: boolean,
  vt: U64,
  vq: U64,
  rt: U64,
  rq: U64,
): Curve {
  const vtN = BigInt(vt);
  const vqN = BigInt(vq);
  const rtN = BigInt(rt);
  const rqN = BigInt(rq);
  const priceX1e9 = vtN === 0n ? 0n : (vqN * X1E9 * LAMPORTS_PER_TOKEN) / vtN;
  const completePct = vqN === 0n ? 0 : Number(((vqN - rqN) * 100n) / vqN);
  return {
    mint,
    kind: 'bonding',
    bonding_curve: bondingCurve,
    creator,
    created_slot: createdSlot,
    complete,
    virtual_token_reserves: vt,
    virtual_quote_reserves: vq,
    real_token_reserves: rt,
    real_quote_reserves: rq,
    price_lamports_per_token_x1e9: priceX1e9.toString(10),
    real_quote_lamports: rqN,
    supply_tokens: vtN / LAMPORTS_PER_TOKEN,
    tokens_per_lamport: vqN === 0n ? 0 : Number(vtN) / Number(vqN),
    lamports_per_token: vtN === 0n ? 0 : Number(vqN) / Number(vtN),
    complete_pct: completePct,
  };
}

/**
 * Run the bot: read hello, then one reply per batch, then done. Resolves when the harness closes
 * stdin or sends `done`; rejects on a protocol violation or an I/O error. Never returns early.
 */
export async function runBot(bot: Bot): Promise<void> {
  let nextClientId = 1;
  const state = {
    hello: null as unknown as HelloMessage,
    batch: -1,
    slot: -1,
    cash_lamports: 0n,
    total_fees_lamports: 0n,
    curves: new Map<Pubkey, Curve>(),
    positions: new Map<Pubkey, Position>(),
    pending: new Map<string, { order: OrderWire; submitted_seq: number }>(),
    fills: [] as Fill[],
    events: [] as Event[],
    entriesCount: 0,
    exitsCount: 0,
    totalBoughtLamports: 0n,
    totalSoldLamports: 0n,
  };
  const caps = (): Caps => state.hello.caps;
  const txFee = (): bigint => BigInt(state.hello.caps.tx_fee_lamports);
  const committedPositionCount = (): number => state.positions.size;
  const freeCashLamports = (): bigint => {
    let held = 0n;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') held += BigInt(p.order.quote_lamports) + txFee();
      else held += txFee();
    }
    return state.cash_lamports - held;
  };
  const maxBuyLamports = (mint: Pubkey): bigint => {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return 0n;
    const cap = (curve.real_quote_lamports * BigInt(caps().max_buy_share_bps)) / BPS;
    const cashCap = freeCashLamports() - txFee();
    return cap < cashCap ? cap : cashCap;
  };
  const positionValueLamports = (mint: Pubkey): bigint | null => {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined) return null;
    const vt = BigInt(curve.virtual_token_reserves);
    if (vt === 0n) return null;
    return (pos.token_amount * BigInt(curve.virtual_quote_reserves)) / vt;
  };
  const totalPositionValueLamports = (): bigint => {
    let total = 0n;
    for (const mint of state.positions.keys()) total += positionValueLamports(mint) ?? 0n;
    return total;
  };
  const equityLamports = (): bigint => state.cash_lamports + totalPositionValueLamports();
  const fullState = state as unknown as BotState;
  fullState.committedPositionCount = committedPositionCount;
  fullState.freeCashLamports = freeCashLamports;
  fullState.txFeeLamports = txFee;
  fullState.maxBuyLamports = maxBuyLamports;
  fullState.positionValueLamports = positionValueLamports;
  fullState.totalPositionValueLamports = totalPositionValueLamports;
  fullState.equityLamports = equityLamports;

  let buffer = '';
  let lineNumber = 0;
  let helloSeen = false;
  let doneSeen = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const onData = (chunk: Buffer): void => {
    buffer += decoder.decode(chunk, { stream: true });
  };
  const onError = (err: Error): void => {
    throw err;
  };
  process.stdin.on('data', onData);
  process.stdin.on('error', onError);
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lineNumber += 1;
        if (Buffer.byteLength(line, 'utf8') > MAX_HARNESS_LINE_BYTES) {
          throw new OrderError(`harness line ${lineNumber} exceeds ${MAX_HARNESS_LINE_BYTES} bytes`);
        }
        return line;
      }
      const chunk = await new Promise<Buffer | null>((resolve) => {
        const onReadable = (): void => {
          const data = process.stdin.read() as Buffer | null;
          process.stdin.removeListener('readable', onReadable);
          resolve(data);
        };
        process.stdin.once('readable', onReadable);
        process.stdin.once('end', () => {
          process.stdin.removeListener('readable', onReadable);
          resolve(null);
        });
      });
      if (chunk === null) {
        const tail = buffer;
        buffer = '';
        if (tail.length > 0) {
          lineNumber += 1;
          if (Buffer.byteLength(tail, 'utf8') > MAX_HARNESS_LINE_BYTES) {
            throw new OrderError(`harness tail exceeds ${MAX_HARNESS_LINE_BYTES} bytes`);
          }
          return tail;
        }
        return null;
      }
      onData(chunk);
    }
  };

  const applyFills = (batch: BatchMessage): void => {
    for (const f of batch.fills) {
      state.pending.delete(f.client_id);
      if (f.status !== 'filled') continue;
      const filledQuote = BigInt(f.filled_quote_lamports);
      const filledTokens = BigInt(f.filled_token_amount);
      if (f.side === 'buy') {
        state.entriesCount += 1;
        state.totalBoughtLamports += filledQuote;
        const prev = state.positions.get(f.mint);
        const entrySlot = state.slot;
        if (prev === undefined) {
          state.positions.set(f.mint, {
            mint: f.mint,
            token_amount: filledTokens,
            cost_lamports: filledQuote,
            total_cost_lamports: filledQuote,
            realized_lamports: 0n,
            entry_slot: entrySlot,
          });
        } else {
          prev.token_amount += filledTokens;
          prev.cost_lamports += filledQuote;
          prev.total_cost_lamports += filledQuote;
        }
      } else {
        state.exitsCount += 1;
        state.totalSoldLamports += filledQuote;
        const prev = state.positions.get(f.mint);
        if (prev !== undefined) {
          const sold = filledTokens > prev.token_amount ? prev.token_amount : filledTokens;
          const costPart = prev.token_amount === 0n ? 0n : (prev.cost_lamports * sold) / prev.token_amount;
          prev.token_amount -= sold;
          prev.cost_lamports -= costPart;
          prev.realized_lamports += filledQuote;
          if (prev.token_amount === 0n) state.positions.delete(f.mint);
        }
      }
    }
  };

  const applyEvents = (batch: BatchMessage): void => {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!state.curves.has(e.mint)) {
          state.curves.set(
            e.mint,
            deriveCurve(e.mint, e.bonding_curve, e.creator, e.slot, false, '0', '0', '0', '0'),
          );
        }
      } else if (e.event === 'CreateEventV2') {
        if (!state.curves.has(e.mint)) {
          state.curves.set(
            e.mint,
            deriveCurve(e.mint, e.bonding_curve, e.creator, e.slot, false, '0', '0', '0', '0'),
          );
        }
      } else if (e.event === 'TradeEvent') {
        const c = state.curves.get(e.mint);
        if (c === undefined) {
          state.curves.set(
            e.mint,
            deriveCurve(
              e.mint,
              e.bonding_curve,
              e.event === 'TradeEvent' ? '11111111111111111111111111111111' : e.bonding_curve,
              null,
              false,
              e.virtual_token_reserves,
              e.virtual_quote_reserves,
              e.real_token_reserves,
              e.real_quote_reserves,
            ),
          );
        } else {
          const next = deriveCurve(
            e.mint,
            e.bonding_curve,
            c.creator,
            c.created_slot,
            c.complete,
            e.virtual_token_reserves,
            e.virtual_quote_reserves,
            e.real_token_reserves,
            e.real_quote_reserves,
          );
          state.curves.set(e.mint, next);
        }
      } else if (e.event === 'CompleteEvent' || e.event === 'CompletePumpAmmMigrationEvent') {
        const c = state.curves.get(e.mint);
        if (c !== undefined) state.curves.set(e.mint, { ...c, complete: true });
      }
    }
  };

  const submitOrders = (orders: OrderInput[], seq: number): void => {
    if (orders.length > caps().max_orders_per_batch) {
      fail(`too many orders: ${orders.length} exceeds hello.caps.max_orders_per_batch (${caps().max_orders_per_batch})`);
    }
    const seen = new Set<string>();
    const wire: OrderWire[] = [];
    for (let i = 0; i < orders.length; i += 1) {
      const o = orders[i];
      if (typeof o !== 'object' || o === null) fail(`order ${i} is not an object`);
      if (o.side !== 'buy' && o.side !== 'sell') fail(`order ${i} side is not buy or sell: ${JSON.stringify(o.side)}`);
      if (!isBase58(o.mint)) fail(`order ${i} mint is not a base58 address: ${JSON.stringify(o.mint)}`);
      const knownKeys = new Set(['side', 'mint', 'quote_lamports', 'token_amount', 'max_slippage_bps', 'client_id']);
      for (const key of Object.keys(o)) {
        if (!knownKeys.has(key)) fail(`order ${i} has an unknown key: ${key}`);
      }
      let clientId = o.client_id;
      if (clientId === undefined) {
        clientId = `c${nextClientId}`;
        nextClientId += 1;
      }
      if (typeof clientId !== 'string' || clientId.length === 0 || clientId.startsWith('_')) {
        fail(`order ${i} client_id is not a usable id: ${JSON.stringify(clientId)}`);
      }
      if (seen.has(clientId)) fail(`order ${i} client_id is a duplicate: ${clientId}`);
      seen.add(clientId);
      if (state.pending.has(clientId)) fail(`order ${i} client_id is already pending: ${clientId}`);
      let bps = o.max_slippage_bps;
      if (bps === undefined) bps = 10_000;
      if (typeof bps !== 'number' || !Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
        fail(`order ${i} max_slippage_bps is not an integer in 0..10000: ${JSON.stringify(bps)}`);
      }
      let quote = '0';
      let tokens = '0';
      if (o.side === 'buy') {
        if (o.quote_lamports === undefined) fail(`order ${i} is a buy without quote_lamports`);
        quote = toU64(o.quote_lamports, `order ${i} quote_lamports`);
        if (BigInt(quote) < BigInt(caps().min_buy_lamports)) {
          fail(`order ${i} quote_lamports ${quote} is below hello.caps.min_buy_lamports (${caps().min_buy_lamports})`);
        }
        if (o.token_amount !== undefined) fail(`order ${i} is a buy with token_amount`);
      } else {
        if (o.quote_lamports !== undefined) fail(`order ${i} is a sell with quote_lamports`);
        const pos = state.positions.get(o.mint);
        if (pos === undefined) fail(`order ${i} is a sell without an open position on ${o.mint}`);
        const maxSell = (pos.token_amount * BigInt(caps().max_sell_share_bps)) / BPS;
        if (o.token_amount === undefined) {
          tokens = pos.token_amount.toString(10);
        } else {
          tokens = toU64(o.token_amount, `order ${i} token_amount`);
          if (BigInt(tokens) <= 0n) fail(`order ${i} token_amount must be positive: ${tokens}`);
          if (BigInt(tokens) > maxSell) {
            fail(`order ${i} token_amount ${tokens} exceeds the ${caps().max_sell_share_bps} bps sell cap (${maxSell})`);
          }
        }
      }
      const w: OrderWire = { side: o.side, mint: o.mint, quote_lamports: quote, token_amount: tokens, max_slippage_bps: bps, client_id: clientId };
      wire.push(w);
      state.pending.set(clientId, { order: w, submitted_seq: seq });
    }
    const reply: ReplyMessage = { type: 'reply', seq, orders: wire };
    const line = JSON.stringify(reply);
    if (Buffer.byteLength(line, 'utf8') > MAX_BOT_LINE_BYTES) {
      for (const w of wire) state.pending.delete(w.client_id);
      fail(`reply line is ${Buffer.byteLength(line, 'utf8')} bytes, over the ${MAX_BOT_LINE_BYTES} byte limit`);
    }
    writeLine(reply);
  };

  for (;;) {
    const line = await nextLine();
    if (line === null) break;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (err) {
      throw new OrderError(`harness line ${lineNumber} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new OrderError(`harness line ${lineNumber} is not a JSON object`);
    }
    const type = (parsed as Record<string, unknown>)['type'];
    if (type === 'hello') {
      if (helloSeen) throw new OrderError('duplicate hello message');
      const h = parsed as HelloMessage;
      if (h.protocol !== PROTOCOL) throw new OrderError(`unsupported protocol: ${JSON.stringify(h.protocol)}`);
      state.hello = h;
      state.cash_lamports = BigInt(h.starting_capital_lamports);
      helloSeen = true;
      bot.onHello?.(fullState);
      continue;
    }
    if (type === 'batch') {
      if (!helloSeen) throw new OrderError('batch arrived before hello');
      checkBatch(parsed);
      const batch = parsed as BatchMessage;
      if (batch.seq !== state.batch + 1) {
        throw new OrderError(`batch seq out of order: got ${batch.seq}, expected ${state.batch + 1}`);
      }
      state.batch = batch.seq;
      state.slot = batch.slot;
      state.cash_lamports = BigInt(batch.cash_lamports);
      state.total_fees_lamports = BigInt(batch.total_fees_lamports);
      state.fills = batch.fills;
      state.events = batch.events;
      applyFills(batch);
      applyEvents(batch);
      const orders = bot.onBatch(fullState, batch) ?? [];
      if (!Array.isArray(orders)) throw new OrderError('onBatch did not return an array');
      submitOrders(orders, batch.seq);
      continue;
    }
    if (type === 'done') {
      if (!helloSeen) throw new OrderError('done arrived before hello');
      doneSeen = true;
      const done = parsed as DoneMessage;
      state.cash_lamports = BigInt(done.final_cash_lamports);
      state.total_fees_lamports = BigInt(done.total_fees_lamports);
      bot.onDone?.(fullState, done);
      break;
    }
    throw new OrderError(`unknown harness message type: ${JSON.stringify(type)}`);
  }
  process.stdin.removeListener('data', onData);
  process.stdin.removeListener('error', onError);
  if (!doneSeen) {
    console.error('runBot: stdin closed without a done message');
  }
}

function writeLine(payload: Outbound): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`, 'utf8');
}
