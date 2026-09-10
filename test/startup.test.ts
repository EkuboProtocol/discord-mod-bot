import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import OpenAI from 'openai';
import { buildRequest, createModerator } from '../src/ai';
import { CLEAN } from '../src/moderation';

const model = 'gpt-5.6-luna';
const input = { content: 'hello', previousMessages: [], meta: null };

function completion(content: string | null, finish_reason = 'stop') {
  return { choices: [{ finish_reason, message: { role: 'assistant', content } }] };
}

function fixture(body: unknown, status = 200) {
  const requests: unknown[] = [];
  const client = new OpenAI({
    apiKey: 'test-only-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  return { moderator: createModerator(client, model), requests };
}

describe('OpenAI startup check', () => {
  test('uses the configured model and production request builder with synthetic input', async () => {
    const { moderator, requests } = fixture(completion(JSON.stringify(CLEAN)));
    await Effect.runPromise(moderator.startupCheck);
    expect(requests).toEqual([buildRequest(model, {
      content: 'Hello everyone! Where can I find the documentation?',
      previousMessages: [],
      meta: { author: 'Startup check', roles: [] }
    })]);
  });

  test.each([
    ['API parameter error', { error: { message: 'Unsupported temperature', type: 'invalid_request_error' } }, 400],
    ['invalid JSON', completion('not JSON'), 200],
    ['invalid verdict', completion('{}'), 200],
    ['empty completion', completion(null), 200],
    ['truncated completion', completion(JSON.stringify(CLEAN), 'length'), 200],
    ['refused completion', completion(null, 'content_filter'), 200],
    ['missing choice', { choices: [] }, 200]
  ] as const)('fails startup on %s while live moderation still fails open', async (_name, body, status) => {
    const { moderator } = fixture(body, status);
    const exit = await Effect.runPromiseExit(moderator.startupCheck);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await Effect.runPromise(moderator.check(input))).toEqual(CLEAN);
  });
});
