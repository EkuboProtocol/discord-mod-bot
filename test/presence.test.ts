import { describe, expect, test } from 'bun:test';
import {
  buildPriceMap,
  formatChange,
  formatStatuses,
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

describe('formatStatuses', () => {
  test('rotates one stat per line, including Robinhood Chain STONX', () => {
    expect(formatStatuses({ price: 0.4807, changePct: 1.7 }, 25_700_000,
      12_000_000, 45_000, { price: 1.0282, changePct: -2.5 })).toEqual([
      'EKUBO $0.4807 ▲1.7%', '24h vol $25.7M', 'TVL $12.0M',
      '24h fees $45.0K', 'STONX $1.0282 ▼2.5%'
    ]);
  });

  test('omits unavailable and non-finite stats but retains zero', () => {
    expect(formatStatuses(null, 0, NaN, Infinity, { price: NaN, changePct: null }))
      .toEqual(['24h vol $0']);
    expect(formatStatuses(null, null, null, null, null)).toEqual([]);
  });
});

describe('fetchStatuses', () => {
  test('uses protocol TVL directly, prices fees, and survives a failed STONX endpoint', async () => {
    const { Effect } = await import('effect');
    const { fetchStatuses } = await import('../src/presence');
    const originalFetch = globalThis.fetch;
    const day = new Date(Date.now() - 86400000).toISOString();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/4663/')) return new Response('', { status: 503 });
      let body: unknown;
      if (url.endsWith('/overview/volume')) {
        body = { volumeByTokenByDate: [
          { chain_id: '0x1', token: '0x1', date: day, volume: '10000000', fees: '100000' }
        ] };
      } else if (url === 'https://api.llama.fi/tvl/ekubo') {
        body = 28_262_202.66;
      } else if (url.endsWith('/tokens')) {
        body = [{ chain_id: 1, address: '0x01', decimals: 6, usd_price: 2 }];
      } else if (url.includes('price-history')) {
        body = { data: [{ price: 1 }] };
      } else {
        body = { usd_price: 2 };
      }
      return Response.json(body);
    }) as typeof fetch;
    try {
      const statuses = await Effect.runPromise(fetchStatuses({
        enabled: true, apiBase: 'https://example.test', timeoutMs: 1000,
        intervalMs: 300000, rotationMs: 5000
      }));
      expect(statuses).toEqual([
        'EKUBO $2.0000 ▲100.0%', '24h vol $20', 'TVL $28.3M', '24h fees $0'
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
