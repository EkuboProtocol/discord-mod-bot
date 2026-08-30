import { describe, expect, test } from 'bun:test';
import {
  buildPriceMap,
  formatChange,
  formatStatus,
  formatUsdCompact,
  latestCompleteDay,
  sumDayVolumeUsd
} from '../src/presence';

describe('buildPriceMap', () => {
  test('keys addresses by numeric value, so "0x0" and the padded zero address collide', () => {
    // This is the whole reason the key is built with BigInt. The volume feed
    // abbreviates native ETH as "0x0" while the token list spells the zero
    // address out in full; a string compare would drop the largest row.
    const map = buildPriceMap([
      { chain_id: 1, address: '0x0000000000000000000000000000000000000000', usd_price: 3000, decimals: 18 }
    ]);

    expect(map.get('1:0')).toEqual({ usdPrice: 3000, decimals: 18 });
  });

  test('treats equivalent chain id encodings as the same key', () => {
    const map = buildPriceMap([
      { chain_id: '1', address: '0x1', usd_price: 5, decimals: 6 }
    ]);

    expect(map.get('1:1')).toEqual({ usdPrice: 5, decimals: 6 });
  });

  test('skips tokens with no price rather than storing null', () => {
    const map = buildPriceMap([
      { chain_id: 1, address: '0x1', usd_price: null, decimals: 18 },
      { chain_id: 1, address: '0x2', usd_price: undefined, decimals: 18 },
      { chain_id: 1, address: '0x3', usd_price: 2, decimals: 18 }
    ]);

    expect(map.size).toBe(1);
    expect(map.has('1:3')).toBe(true);
  });

  test('keeps a zero price, which is a real value and not a missing one', () => {
    const map = buildPriceMap([
      { chain_id: 1, address: '0x1', usd_price: 0, decimals: 18 }
    ]);

    expect(map.get('1:1')?.usdPrice).toBe(0);
  });
});

describe('sumDayVolumeUsd', () => {
  const priceMap = new Map([
    ['1:1', { usdPrice: 2, decimals: 18 }],
    ['1:2', { usdPrice: 1, decimals: 6 }]
  ]);

  test('scales each row by its own decimals before pricing it', () => {
    const rows = [
      { date: '2026-08-29', chain_id: 1, token: '0x1', volume: '1000000000000000000' }, // 1.0 @ $2
      { date: '2026-08-29', chain_id: 1, token: '0x2', volume: '5000000' } //             5.0 @ $1
    ];

    expect(sumDayVolumeUsd(rows, priceMap, '2026-08-29')).toBe(7);
  });

  test('ignores rows from other days', () => {
    const rows = [
      { date: '2026-08-29', chain_id: 1, token: '0x2', volume: '1000000' },
      { date: '2026-08-28', chain_id: 1, token: '0x2', volume: '9000000' }
    ];

    expect(sumDayVolumeUsd(rows, priceMap, '2026-08-29')).toBe(1);
  });

  test('matches on the date prefix of a full timestamp', () => {
    const rows = [
      { date: '2026-08-29T00:00:00Z', chain_id: 1, token: '0x2', volume: '3000000' }
    ];

    expect(sumDayVolumeUsd(rows, priceMap, '2026-08-29')).toBe(3);
  });

  test('skips tokens missing from the price map instead of counting them as zero-priced', () => {
    const rows = [
      { date: '2026-08-29', chain_id: 1, token: '0x2', volume: '1000000' },
      { date: '2026-08-29', chain_id: 99, token: '0xdead', volume: '999999999' }
    ];

    expect(sumDayVolumeUsd(rows, priceMap, '2026-08-29')).toBe(1);
  });

  test('is zero when nothing matches', () => {
    expect(sumDayVolumeUsd([], priceMap, '2026-08-29')).toBe(0);
  });
});

describe('latestCompleteDay', () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

  test('excludes the current UTC day, whose bucket is still partial', () => {
    // Publishing the running day would read as a sudden collapse in volume.
    const rows = [{ date: twoDaysAgo }, { date: yesterday }, { date: today }];

    expect(latestCompleteDay(rows)).toBe(yesterday);
  });

  test('picks the newest complete day regardless of row order', () => {
    const rows = [{ date: yesterday }, { date: twoDaysAgo }];

    expect(latestCompleteDay(rows)).toBe(yesterday);
  });

  test('returns null when only the current day is present', () => {
    expect(latestCompleteDay([{ date: today }])).toBeNull();
  });

  test('returns null for no rows at all', () => {
    expect(latestCompleteDay([])).toBeNull();
  });
});

describe('formatUsdCompact', () => {
  test.each([
    [2_500_000_000, '$2.5B'],
    [1_000_000_000, '$1.0B'],
    [25_700_000, '$25.7M'],
    [1_000_000, '$1.0M'],
    [999_999, '$1000.0K'],
    [1_000, '$1.0K'],
    [999, '$999'],
    [0, '$0']
  ])('formats %p as %p', (value, expected) => {
    expect(formatUsdCompact(value)).toBe(expected);
  });
});

describe('formatChange', () => {
  test('marks a rise with an up arrow', () => {
    expect(formatChange(2.54)).toBe(' ▲2.5%');
  });

  test('marks a fall with a down arrow and drops the minus sign', () => {
    expect(formatChange(-2.54)).toBe(' ▼2.5%');
  });

  test('treats exactly zero as a rise rather than a fall', () => {
    expect(formatChange(0)).toBe(' ▲0.0%');
  });

  test('renders nothing when there is no baseline to compare against', () => {
    expect(formatChange(null)).toBe('');
  });

  test('renders nothing for a non-finite change, e.g. a zero baseline', () => {
    expect(formatChange(Infinity)).toBe('');
    expect(formatChange(NaN)).toBe('');
  });
});

describe('formatStatus', () => {
  test('joins both halves with a separator', () => {
    expect(formatStatus({ price: 0.4807, changePct: 1.7 }, 25_700_000)).toBe(
      'EKUBO $0.4807 ▲1.7% · 24h vol $25.7M'
    );
  });

  test('omits the movement when there is no baseline', () => {
    expect(formatStatus({ price: 0.4807, changePct: null }, 25_700_000)).toBe(
      'EKUBO $0.4807 · 24h vol $25.7M'
    );
  });

  test('publishes price alone when volume is unavailable', () => {
    expect(formatStatus({ price: 0.4807, changePct: null }, null)).toBe('EKUBO $0.4807');
  });

  test('publishes volume alone when price is unavailable', () => {
    expect(formatStatus(null, 25_700_000)).toBe('24h vol $25.7M');
  });

  test('is empty when neither half is available, which is the signal to keep the previous status', () => {
    expect(formatStatus(null, null)).toBe('');
  });

  test('drops a non-finite price rather than rendering "$NaN"', () => {
    expect(formatStatus({ price: NaN, changePct: null }, 25_700_000)).toBe('24h vol $25.7M');
  });
});
