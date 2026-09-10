import { Duration, Effect, Schedule, Schema } from 'effect';
import { ActivityType, type Client } from 'discord.js';
import type { PresenceConfig } from './config';
import { ApiError } from './errors';

/** Token prices are chain-specific; volume, TVL and fees cover all chains. */
const CHAIN_ID = 1;
const EKUBO_ADDRESS = '0x04c46e830bb56ce22735d5d8fc9cb90309317d0f';
const STONX_CHAIN_ID = 4663;
const STONX_ADDRESS = '0x570c5aa79c798e7a418412cc8399ae5bcce570c5';

export interface PriceInfo {
  readonly price: number;
  readonly changePct: number | null;
}

interface PriceEntry {
  readonly usdPrice: number;
  readonly decimals: number;
}

/**
 * The API's own encoding, taken at face value only after decoding.
 *
 * `chain_id` is a union because the feeds disagree about whether chain IDs are
 * numbers or strings; both are normalised to a `BigInt` in the key below, so
 * the union stops here rather than leaking into the aggregation.
 */
const ChainId = Schema.Union([Schema.Number, Schema.String]);

const TokenRow = Schema.Struct({
  chain_id: ChainId,
  address: Schema.String,
  usd_price: Schema.optional(Schema.NullOr(Schema.Number)),
  decimals: Schema.Number
});
export type TokenRow = typeof TokenRow.Type;

const VolumeRow = Schema.Struct({
  date: Schema.String,
  chain_id: ChainId,
  token: Schema.String,
  volume: Schema.Union([Schema.String, Schema.Number])
});
export type VolumeRow = typeof VolumeRow.Type;

const TokenResponse = Schema.Struct({ usd_price: Schema.NullOr(Schema.Number) });

const PriceHistoryResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ price: Schema.Number })).pipe(
    Schema.withDecodingDefault(Effect.succeed([]))
  )
});

const TokensResponse = Schema.Array(TokenRow);

const VolumeOverviewResponse = Schema.Struct({
  volumeByTokenByDate: Schema.Array(Schema.Struct({ ...VolumeRow.fields, fees: Schema.Union([Schema.String, Schema.Number]) })).pipe(Schema.withDecodingDefault(Effect.succeed([])))
});

const TvlOverviewResponse = Schema.Struct({
  tvlByToken: Schema.Array(Schema.Struct({
    chain_id: ChainId,
    token: Schema.String,
    balance: Schema.Union([Schema.String, Schema.Number])
  }))
});

/**
 * Fetch and decode JSON, failing fast rather than hanging the presence tick.
 *
 * Decoding rather than casting is the point: a field the API renames turns into
 * a logged `ApiError` and the previous status stays up, instead of `undefined`
 * quietly propagating into the status line as `$NaN`.
 */
function fetchJson<A, I>(
  url: string,
  schema: Schema.Codec<A, I>,
  timeoutMs: number
): Effect.Effect<A, ApiError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: signal => fetch(url, { signal }),
      catch: cause => new ApiError({ url, cause })
    });

    if (!response.ok) {
      return yield* new ApiError({ url, cause: new Error(`status ${response.status}`) });
    }

    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: cause => new ApiError({ url, cause })
    });

    return yield* Schema.decodeUnknownEffect(schema)(body);
  }).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchCause(cause => new ApiError({ url, cause }))
  );
}

/**
 * Current token price and its movement over the trailing 24 hours.
 *
 * The live price comes from the token endpoint and the baseline from the oldest
 * bucket of the 24h history, so the percentage is genuinely "vs 24h ago" rather
 * than "vs the start of whichever bucket we happened to land in".
 */
function fetchPrice(
  apiBase: string,
  timeoutMs: number,
  chainId = CHAIN_ID,
  address = EKUBO_ADDRESS
): Effect.Effect<PriceInfo | null, ApiError> {
  const tokenUrl = `${apiBase}/tokens/${chainId}/${address}`;
  const historyUrl =
    `${apiBase}/tokens/${chainId}/${address}/price-history` +
    '?interval=900&duration=86400';

  return Effect.gen(function* () {
    const [token, history] = yield* Effect.all(
      [
        fetchJson(tokenUrl, TokenResponse, timeoutMs),
        fetchJson(historyUrl, PriceHistoryResponse, timeoutMs)
      ],
      { concurrency: 'unbounded' }
    );

    const price = token.usd_price;
    if (price === null) {
      return null;
    }

    const baseline = history.data.length > 0 ? history.data[0]!.price : null;
    const changePct = baseline ? ((price - baseline) / baseline) * 100 : null;

    return { price, changePct };
  });
}

/**
 * Build a `${chainId}:${tokenAddress}` -> {usdPrice, decimals} lookup.
 *
 * Addresses are keyed by their numeric value because the volume feed abbreviates
 * native ETH as "0x0" while the token list spells out the zero address; a plain
 * string compare would silently drop the single largest row.
 */
export function buildPriceMap(tokens: ReadonlyArray<TokenRow>): Map<string, PriceEntry> {
  const map = new Map<string, PriceEntry>();

  for (const token of tokens) {
    if (token.usd_price === null || token.usd_price === undefined) {
      continue;
    }
    map.set(`${BigInt(token.chain_id)}:${BigInt(token.address)}`, {
      usdPrice: token.usd_price,
      decimals: token.decimals
    });
  }

  return map;
}

/**
 * Sum one day's rows into a USD total, skipping tokens with no known price.
 * `day` is `YYYY-MM-DD`.
 */
export function sumDayVolumeUsd(
  rows: ReadonlyArray<VolumeRow>,
  priceMap: ReadonlyMap<string, PriceEntry>,
  day: string
): number {
  let total = 0;

  for (const row of rows) {
    if (row.date.slice(0, 10) !== day) {
      continue;
    }
    const entry = priceMap.get(`${BigInt(row.chain_id)}:${BigInt(row.token)}`);
    if (!entry) {
      continue;
    }
    total += (Number(row.volume) / 10 ** entry.decimals) * entry.usdPrice;
  }

  return total;
}

/**
 * The most recent day that is actually over, in UTC.
 *
 * The feed always carries a bucket for the current day, which is partial and
 * would read as a sudden collapse in volume if we published it.
 */
export function latestCompleteDay(
  rows: ReadonlyArray<{ readonly date: string }>
): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const days = rows.map(row => row.date.slice(0, 10)).filter(day => day < today);

  return days.length > 0 ? (days.sort().at(-1) ?? null) : null;
}

/** A failed endpoint omits its stats without blocking the rest of the rotation. */
function optionalStat<A>(effect: Effect.Effect<A, ApiError>): Effect.Effect<A | null> {
  return effect.pipe(Effect.catch(error =>
    Effect.logWarning(`Presence data unavailable: ${error.message}`).pipe(Effect.as(null))
  ));
}

export const fetchStatuses = Effect.fn('fetchStatuses')(function* (
  { apiBase, timeoutMs }: PresenceConfig
) {
  const [price, stonx, overview, tvl, tokens] = yield* Effect.all([
    optionalStat(fetchPrice(apiBase, timeoutMs)),
    optionalStat(fetchPrice(apiBase, timeoutMs, STONX_CHAIN_ID, STONX_ADDRESS)),
    optionalStat(fetchJson(`${apiBase}/overview/volume`, VolumeOverviewResponse, timeoutMs)),
    optionalStat(fetchJson(`${apiBase}/overview/tvl`, TvlOverviewResponse, timeoutMs)),
    optionalStat(fetchJson(`${apiBase}/tokens`, TokensResponse, timeoutMs))
  ], { concurrency: 'unbounded' });
  const priceMap = buildPriceMap(tokens ?? []);
  const rows = overview?.volumeByTokenByDate ?? [];
  const day = latestCompleteDay(rows);
  const canPriceDay = day !== null && tokens !== null;
  const volume = canPriceDay ? sumDayVolumeUsd(rows, priceMap, day) : null;
  const fees = canPriceDay ? sumDayVolumeUsd(
    rows.map(row => ({ ...row, volume: row.fees })), priceMap, day
  ) : null;
  const tvlUsd = tvl && tokens ? sumDayVolumeUsd(
    tvl.tvlByToken.map(row => ({ ...row, date: '', volume: row.balance })), priceMap, ''
  ) : null;
  return formatStatuses(price, volume, tvlUsd, fees, stonx);
});

/** Compact USD, e.g. `$25.7M`. */
export function formatUsdCompact(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

/** Signed movement, e.g. `▲2.5%`. */
export function formatChange(changePct: number | null): string {
  if (changePct === null || !Number.isFinite(changePct)) {
    return '';
  }
  const arrow = changePct >= 0 ? '▲' : '▼';

  return ` ${arrow}${Math.abs(changePct).toFixed(1)}%`;
}

/** One short stat per status so the value stays visible on narrow screens. */
export function formatStatuses(
  price: PriceInfo | null,
  volume: number | null,
  tvl: number | null,
  fees: number | null,
  stonx: PriceInfo | null
): string[] {
  return [
    formatPrice('EKUBO', price),
    formatMetric('24h vol', volume),
    formatMetric('TVL', tvl),
    formatMetric('24h fees', fees),
    formatPrice('STONX', stonx)
  ].filter(status => status !== '');
}

function formatPrice(symbol: string, info: PriceInfo | null): string {
  return info && Number.isFinite(info.price)
    ? `${symbol} $${info.price.toFixed(4)}${formatChange(info.changePct)}`
    : '';
}

function formatMetric(label: string, value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${label} ${formatUsdCompact(value)}` : '';
}

/** Independent scoped loops keep rotation smooth even while API requests are slow. */
export function presenceLoop(client: Client, config: PresenceConfig): Effect.Effect<void> {
  if (!config.enabled) return Effect.logInfo('Presence updates disabled');

  return Effect.suspend(() => {
    let statuses: string[] = [];
    let index = 0;
    const refresh = fetchStatuses(config).pipe(
      Effect.tap(next => Effect.sync(() => {
        if (next.length > 0) statuses = next;
      })),
      Effect.catchCause(cause => Effect.logWarning('Presence refresh failed', cause)),
      Effect.repeat(Schedule.spaced(Duration.millis(config.intervalMs)))
    );
    const rotate = Effect.sync(() => {
      if (statuses.length === 0 || !client.user) return;
      const status = statuses[index % statuses.length]!;
      client.user.setPresence({
        activities: [{ type: ActivityType.Custom, name: 'ekubo-stats', state: status }],
        status: 'online'
      });
      index = (index + 1) % statuses.length;
    }).pipe(
      Effect.catchCause(cause => Effect.logWarning('Presence update failed', cause)),
      Effect.repeat(Schedule.spaced(Duration.millis(Math.max(5_000, config.rotationMs))))
    );
    return Effect.all([refresh, rotate], { concurrency: 'unbounded' }).pipe(Effect.asVoid);
  });
}
