import { Duration, Effect, Schedule, Schema } from 'effect';
import { ActivityType, type Client } from 'discord.js';
import type { PresenceConfig } from './config';
import { ApiError } from './errors';

/**
 * Ekubo mainnet (chain 1) EKUBO token. The presence line is protocol-wide, so
 * the only per-token lookup is the price of EKUBO itself.
 */
const CHAIN_ID = 1;
const EKUBO_ADDRESS = '0x04c46e830bb56ce22735d5d8fc9cb90309317d0f';

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
  volumeByTokenByDate: Schema.Array(VolumeRow).pipe(Schema.withDecodingDefault(Effect.succeed([])))
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
 * Current EKUBO price and its movement over the trailing 24 hours.
 *
 * The live price comes from the token endpoint and the baseline from the oldest
 * bucket of the 24h history, so the percentage is genuinely "vs 24h ago" rather
 * than "vs the start of whichever bucket we happened to land in".
 */
function fetchPrice(
  apiBase: string,
  timeoutMs: number
): Effect.Effect<PriceInfo | null, ApiError> {
  const tokenUrl = `${apiBase}/tokens/${CHAIN_ID}/${EKUBO_ADDRESS}`;
  const historyUrl =
    `${apiBase}/tokens/${CHAIN_ID}/${EKUBO_ADDRESS}/price-history` +
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

/**
 * Protocol-wide swap volume in USD for the last complete UTC day, summed across
 * every chain. Verified against DefiLlama's reported 24h figure to within ~1.5%,
 * which is what rules out the usual both-sides-of-the-swap double count.
 */
function fetchVolumeUsd(
  apiBase: string,
  timeoutMs: number
): Effect.Effect<number | null, ApiError> {
  return Effect.gen(function* () {
    const [overview, tokens] = yield* Effect.all(
      [
        fetchJson(`${apiBase}/overview/volume`, VolumeOverviewResponse, timeoutMs),
        fetchJson(`${apiBase}/tokens`, TokensResponse, timeoutMs)
      ],
      { concurrency: 'unbounded' }
    );

    const rows = overview.volumeByTokenByDate;
    const day = latestCompleteDay(rows);

    return day === null ? null : sumDayVolumeUsd(rows, buildPriceMap(tokens), day);
  });
}

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

/** Compose the status line, e.g. `EKUBO $0.4807 ▲2.5% · 24h vol $25.7M`. */
export function formatStatus(priceInfo: PriceInfo | null, volumeUsd: number | null): string {
  const parts: string[] = [];

  if (priceInfo && Number.isFinite(priceInfo.price)) {
    parts.push(`EKUBO $${priceInfo.price.toFixed(4)}${formatChange(priceInfo.changePct)}`);
  }
  if (volumeUsd !== null && Number.isFinite(volumeUsd)) {
    parts.push(`24h vol ${formatUsdCompact(volumeUsd)}`);
  }

  return parts.join(' · ');
}

/**
 * Fetch both halves of the summary and publish them as the bot's status.
 *
 * Bots cannot use Rich Presence (that is a local-IPC feature of the desktop
 * client); the gateway equivalent is a custom activity, which is what this sets.
 */
export function updatePresence(
  client: Client,
  presenceConfig: PresenceConfig
): Effect.Effect<void, ApiError> {
  const { apiBase, timeoutMs } = presenceConfig;

  return Effect.gen(function* () {
    const [priceInfo, volumeUsd] = yield* Effect.all(
      [fetchPrice(apiBase, timeoutMs), fetchVolumeUsd(apiBase, timeoutMs)],
      { concurrency: 'unbounded' }
    );

    const status = formatStatus(priceInfo, volumeUsd);
    if (!status) {
      yield* Effect.logWarning('Presence: no data available, leaving previous status in place');
      return;
    }

    client.user?.setPresence({
      activities: [{ type: ActivityType.Custom, name: 'ekubo-stats', state: status }],
      status: 'online'
    });
    yield* Effect.logInfo(`Presence updated: ${status}`);
  });
}

/**
 * Publish the summary now and on an interval for as long as the bot runs.
 *
 * Moderation is the bot's actual job, so every failure is absorbed here: a
 * flaky stats endpoint must never take the process down or clear a status that
 * was previously fine. The loop is a fiber rather than a `setInterval`, so it
 * is interrupted with the rest of the app on shutdown instead of needing an
 * `unref` to avoid pinning the process open.
 */
export function presenceLoop(
  client: Client,
  presenceConfig: PresenceConfig
): Effect.Effect<void> {
  if (!presenceConfig.enabled) {
    return Effect.logInfo('Presence updates disabled');
  }

  return updatePresence(client, presenceConfig).pipe(
    Effect.catch(error =>
      Effect.logWarning(`Presence update failed, keeping previous status: ${error.message}`)
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(presenceConfig.intervalMs))),
    Effect.asVoid
  );
}
