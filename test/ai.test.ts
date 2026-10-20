import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import {
  buildState,
  clairicRequest,
  clefRequest,
  decodeClairic,
  decodeClef,
  FIELDS,
  formatRolesForDisplay,
  modelUrl,
  PREAMBLE,
  QUESTIONS,
  toScores
} from '../src/ai';
import { clairicBody, clefBody } from './fixtures';

describe('formatRolesForDisplay', () => {
  test('states that a member has no roles rather than leaving it blank', () => {
    expect(formatRolesForDisplay([])).toBe('None');
    expect(formatRolesForDisplay(null)).toBe('None');
    expect(formatRolesForDisplay(undefined)).toBe('None');
  });

  test('joins real roles', () => {
    expect(formatRolesForDisplay(['Mod', 'Core'])).toBe('Mod, Core');
  });
});

describe('buildState', () => {
  const input = {
    content: 'click here',
    previousMessages: [],
    meta: { author: 'spammer#0', roles: ['Member'] }
  };

  test('opens with the measured preamble and ends with the message under analysis', () => {
    expect(buildState(input)).toBe(
      `${PREAMBLE}\n\nAuthor: spammer#0\nRoles: Member\nMessage: click here`
    );
  });

  test('sends the bare message when nothing is known about the author', () => {
    expect(buildState({ ...input, meta: null })).toBe(`${PREAMBLE}\n\nMessage: click here`);
  });

  test('puts channel history before the message and marks which one is evaluated', () => {
    const state = buildState({
      ...input,
      previousMessages: [
        { author: 'alice', roles: ['Mod'], content: 'hi' },
        { author: 'bob', roles: [], content: 'hey' }
      ]
    });

    expect(state).toStartWith(PREAMBLE);
    expect(state).toContain('[alice | Roles: Mod]: hi\n[bob | Roles: None]: hey');
    expect(state.indexOf('[bob')).toBeLessThan(state.indexOf('New message to evaluate:'));
    expect(state).toEndWith('Author: spammer#0\nRoles: Member\nMessage: click here');
  });
});

describe('requests', () => {
  const input = { content: 'click here', previousMessages: [], meta: null };

  test('Clef gets the measured questions', () => {
    expect(clefRequest(input)).toEqual({
      model: 'clef',
      state: buildState(input),
      questions: QUESTIONS
    });
    expect(Object.keys(QUESTIONS.severity.criteria)).toEqual(['high', 'medium', 'low', 'none']);
  });

  test('Clairic reads the raw message, without the preamble', () => {
    expect(clairicRequest('hello')).toEqual({ model: 'clairic', state: 'hello', fields: FIELDS });
  });

  test('calls the per-model Workers AI endpoint', () => {
    expect(modelUrl('abc', 'clef')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef'
    );
  });
});

const decodes = <A>(effect: Effect.Effect<A, unknown>) =>
  Exit.isSuccess(Effect.runSyncExit(effect));

describe('decodeClef', () => {
  test('reads the probabilities out of the result envelope', () => {
    const response = Effect.runSync(decodeClef(clefBody(0.97, 'high', 0.91)));

    expect(toScores(response)).toEqual({
      pSpam: 0.97,
      choice: 'high',
      probabilities: { high: 0.91, medium: 0.03, low: 0.03, none: 0.03 }
    });
  });

  test.each([
    ['success: false', { ...clefBody(0.97, 'high', 0.91), success: false }],
    ['no envelope', clefBody(0.97, 'high', 0.91).result],
    ['missing question', { success: true, result: { answers: { severity: {} } } }],
    ['probability out of range', clefBody(1.5, 'high', 0.91)],
    ['unknown choice', clefBody(0.97, 'critical', 0.91)],
    ['not an object', 'Internal Server Error'],
    ['null', null]
  ])('rejects %s', (_name, body) => {
    expect(decodes(decodeClef(body))).toBe(false);
  });
});

describe('decodeClairic', () => {
  test('accepts a full answer set', () => {
    expect(decodes(decodeClairic(clairicBody()))).toBe(true);
  });

  test('tolerates fields Clairic left out', () => {
    expect(decodes(decodeClairic({ success: true, result: { answers: {} } }))).toBe(true);
  });

  test('rejects a mistyped value', () => {
    const body = clairicBody({ cut_percent: { value: 'ten', confidence: 1 } });

    expect(decodes(decodeClairic(body))).toBe(false);
  });
});
