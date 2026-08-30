import { ActivityType, type Client } from 'discord.js';
import { logger } from './logger';
import type { PresenceConfig } from './config';

interface PriceInfo {
  price: number;
  changePct: number | null;
}

interface PriceEntry {
  usdPrice: number;
  decimals: number;
}

// Ekubo mainnet (chain 1) EKUBO token. The presence line is protocol-wide, so
// the only per-token lookup is the price of EKUBO itself.
const CHAIN_ID = 1;
const EKUBO_ADDRESS = '0x04c46e830bb56ce22735d5d8fc9cb90309317d0f';

/**
 * Fetch and parse JSON, failing fast rather than hanging the presence tick.
 */
async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  return response.json();
}

/**
 * Current EKUBO price and its movement over the trailing 24 hours.
 *
 * The live price comes from the token endpoint and the baseline from the oldest
 * bucket of the 24h history, so the percentage is genuinely "vs 24h ago" rather
 * than "vs the start of whichever bucket we happened to land in".
 */
async function fetchPrice(apiBase: string, timeoutMs: number): Promise<PriceInfo> {
  const tokenUrl = `${apiBase}/tokens/${CHAIN_ID}/${EKUBO_ADDRESS}`;
  const historyUrl =
    `${apiBase}/tokens/${CHAIN_ID}/${EKUBO_ADDRESS}/price-history` +
    '?interval=900&duration=86400';

  const [token, history] = await Promise.all([
    fetchJson(tokenUrl, timeoutMs),
    fetchJson(historyUrl, timeoutMs)
  ]);

  const price = token.usd_price;
  const buckets = Array.isArray(history.data) ? history.data : [];
  const baseline = buckets.length > 0 ? buckets[0].price : null;

  const changePct =
    baseline && price ? ((price - baseline) / baseline) * 100 : null;

  return { price, changePct };
}

/**
 * Build a `${chainId}:${tokenAddress}` -> {usdPrice, decimals} lookup.
 *
 * Addresses are keyed by their numeric value because the volume feed abbreviates
 * native ETH as "0x0" while the token list spells out the zero address; a plain
 * string compare would silently drop the single largest row.
 */
export function buildPriceMap(tokens: Array<Record<string, any>>): Map<string, PriceEntry> {
  const map = new Map<string, PriceEntry>();

  for (const token of tokens) {
    if (token.usd_price === null || token.usd_price === undefined) {
      continue;
    }
    const key = `${BigInt(token.chain_id)}:${BigInt(token.address)}`;
    map.set(key, { usdPrice: token.usd_price, decimals: token.decimals });
  }

  return map;
}

/**
 * Sum one day's rows into a USD total, skipping tokens with no known price.
 * `day` is `YYYY-MM-DD`.
 */
export function sumDayVolumeUsd(
  rows: Array<Record<string, any>>,
  priceMap: Map<string, PriceEntry>,
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
export function latestCompleteDay(rows: Array<Record<string, any>>): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const days = rows.map(row => row.date.slice(0, 10)).filter(day => day < today);

  return days.length > 0 ? days.sort().at(-1) : null;
}

/**
 * Protocol-wide swap volume in USD for the last complete UTC day, summed across
 * every chain. Verified against DefiLlama's reported 24h figure to within ~1.5%,
 * which is what rules out the usual both-sides-of-the-swap double count.
 */
async function fetchVolumeUsd(apiBase: string, timeoutMs: number): Promise<number | null> {
  const [overview, tokens] = await Promise.all([
    fetchJson(`${apiBase}/overview/volume`, timeoutMs),
    fetchJson(`${apiBase}/tokens`, timeoutMs)
  ]);

  const rows = overview.volumeByTokenByDate || [];
  const day = latestCompleteDay(rows);
  if (!day) {
    return null;
  }

  return sumDayVolumeUsd(rows, buildPriceMap(tokens), day);
}

/**
 * Compact USD, e.g. `$25.7M`.
 */
export function formatUsdCompact(value: number): string {
  if (value >= 1e9) {
    return `$${(value / 1e9).toFixed(1)}B`;
  }
  if (value >= 1e6) {
    return `$${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 1e3) {
    return `$${(value / 1e3).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

/**
 * Signed movement, e.g. `▲2.5%`.
 */
export function formatChange(changePct: number | null): string {
  if (changePct === null || !Number.isFinite(changePct)) {
    return '';
  }
  const arrow = changePct >= 0 ? '▲' : '▼';

  return ` ${arrow}${Math.abs(changePct).toFixed(1)}%`;
}

/**
 * Compose the status line, e.g. `EKUBO $0.4807 ▲2.5% · 24h vol $25.7M`.
 */
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
export async function updatePresence(client: Client, presenceConfig: PresenceConfig): Promise<void> {
  const { apiBase, timeoutMs } = presenceConfig;

  const [priceInfo, volumeUsd] = await Promise.all([
    fetchPrice(apiBase, timeoutMs),
    fetchVolumeUsd(apiBase, timeoutMs)
  ]);

  const status = formatStatus(priceInfo, volumeUsd);
  if (!status) {
    logger.warn('Presence: no data available, leaving previous status in place');
    return;
  }

  client.user?.setPresence({
    activities: [{ type: ActivityType.Custom, name: 'ekubo-stats', state: status }],
    status: 'online'
  });
  logger.info(`Presence updated: ${status}`);
}

/**
 * Run one presence tick, absorbing any failure.
 *
 * Moderation is the bot's actual job, so a flaky stats endpoint must never take
 * the process down or clear a status that was previously fine.
 */
async function safeUpdatePresence(client: Client, presenceConfig: PresenceConfig): Promise<void> {
  try {
    await updatePresence(client, presenceConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Presence update failed, keeping previous status: ${message}`);
  }
}

/**
 * Publish the summary now and on an interval for as long as the bot runs.
 *
 * The enabled check lives here rather than at the call site so that wiring this
 * into the ready handler adds no branch to it, keeping the complexity ratchet in
 * AGENTS.md happy.
 */
export function startPresence(
  client: Client,
  presenceConfig: PresenceConfig | undefined
): ReturnType<typeof setInterval> | null {
  if (!presenceConfig || !presenceConfig.enabled) {
    logger.info('Presence updates disabled');
    return null;
  }

  safeUpdatePresence(client, presenceConfig);

  const timer = setInterval(
    () => safeUpdatePresence(client, presenceConfig),
    presenceConfig.intervalMs
  );
  timer.unref?.();

  return timer;
}

