import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Redacted } from 'effect';
import { clefRequest, createModerator, STARTUP_INPUT, type Fetch } from '../src/ai';
import { CLEAN } from '../src/moderation';
import { clairicBody, clefBody } from './fixtures';

const input = { content: 'hello', previousMessages: [], meta: null };

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fixture(...replies: Array<{ body: unknown; status?: number } | Error>) {
  const requests: Recorded[] = [];
  let next = 0;
  const fetch: Fetch = (url, init) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body))
    });
    const reply = replies[Math.min(next++, replies.length - 1)];
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  };

  const moderator = createModerator({
    accountId: 'acct',
    apiToken: Redacted.make('test-only-token'),
    fetch
  });
  return { moderator, requests };
}

describe('startup check', () => {
  test('asks Clef about the benign startup message with the production request', async () => {
    const { moderator, requests } = fixture({ body: clefBody(0.05, 'none', 0.02) });
    await Effect.runPromise(moderator.startupCheck);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toEndWith('/accounts/acct/ai/run/@cf/cloudflare/clef');
    expect(requests[0].headers.authorization).toBe('Bearer test-only-token');
    expect(requests[0].body).toEqual(clefRequest(STARTUP_INPUT));
  });

  test.each([
    ['a benign message scored as spam', { body: clefBody(0.6, 'low', 0.1) }],
    [
      'an authentication error',
      { body: { success: false, errors: [{ code: 10000 }] }, status: 401 }
    ],
    ['success: false', { body: { ...clefBody(0.05, 'none', 0.02), success: false } }],
    ['a malformed body', { body: 'not JSON' }],
    ['a body that does not decode', { body: { success: true, result: { answers: {} } } }],
    ['a network error', new Error('ECONNRESET')]
  ] as const)('fails on %s while live moderation still fails open', async (_name, reply) => {
    const { moderator } = fixture(reply);
    const exit = await Effect.runPromiseExit(moderator.startupCheck);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await Effect.runPromise(moderator.check(input))).toEqual(CLEAN);
  });
});

describe('check', () => {
  test('a clean message costs one Clef call and no Clairic call', async () => {
    const { moderator, requests } = fixture({ body: clefBody(0.79, 'high', 0.9) });

    expect(await Effect.runPromise(moderator.check(input))).toEqual(CLEAN);
    expect(requests).toHaveLength(1);
  });

  test('a flagged message gets Clairic evidence and a templated reason', async () => {
    const { moderator, requests } = fixture(
      { body: clefBody(0.97, 'high', 0.91) },
      { body: clairicBody() }
    );
    const verdict = await Effect.runPromise(
      moderator.check({ ...input, content: 'earn $5000, pay me 20%, Telegram @scammer' })
    );

    expect(requests.map(r => r.url.split('/').at(-1))).toEqual(['clef', 'clairic']);
    expect(verdict).toMatchObject({
      _tag: 'Flagged',
      severity: 'high',
      reason:
        'High-severity spam/scam (p=0.97): promises $5,000; asks for 20% of profits; ' +
        'directs to Telegram',
      evidence: { offPlatformHandle: '@scammer', asksForDm: null }
    });
  });

  test('still acts on Clef when Clairic fails', async () => {
    const { moderator } = fixture(
      { body: clefBody(0.97, 'medium', 0.1) },
      { body: { success: false }, status: 500 }
    );

    expect(await Effect.runPromise(moderator.check(input))).toMatchObject({
      _tag: 'Flagged',
      severity: 'medium',
      reason: 'Medium-severity spam/scam (p=0.97)'
    });
  });
});
