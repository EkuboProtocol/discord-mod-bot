import { describe, expect, test } from 'bun:test';
import {
  buildRequest,
  formatRolesForDisplay,
  getTokenLimitParam,
  isModernReasoningModel,
  SYSTEM_PROMPT
} from '../src/ai';

// Getting this wrong is not a soft failure: OpenAI rejects `max_tokens` for the
// reasoning models and `max_completion_tokens` for the older ones, so the whole
// moderation call errors out and checkMessage falls back to "not spam".
describe('isModernReasoningModel', () => {
  test.each([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5.4-mini', // the model the deployed bot actually runs
    'GPT-5-MINI', // the check is case-insensitive
    'o1',
    'o1-preview',
    'o3-mini',
    'o4'
  ])('treats %p as a reasoning model', model => {
    expect(isModernReasoningModel(model)).toBe(true);
  });

  test.each(['gpt-4o-mini', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4o'])(
    'treats %p as a classic model',
    model => {
      expect(isModernReasoningModel(model)).toBe(false);
    }
  );

  test('does not mistake a plain "o"-prefixed name for the o-series', () => {
    // The pattern requires a digit right after the "o".
    expect(isModernReasoningModel('omni-moderation-latest')).toBe(false);
  });
});

describe('getTokenLimitParam', () => {
  test('reasoning models get max_completion_tokens', () => {
    expect(getTokenLimitParam('gpt-5.4-mini', 200)).toEqual({ max_completion_tokens: 200 });
  });

  test('classic models get max_tokens', () => {
    expect(getTokenLimitParam('gpt-4o-mini', 200)).toEqual({ max_tokens: 200 });
  });

  test('emits exactly one key, never both', () => {
    expect(Object.keys(getTokenLimitParam('gpt-5', 200))).toHaveLength(1);
    expect(Object.keys(getTokenLimitParam('gpt-4', 200))).toHaveLength(1);
  });
});

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

describe('buildRequest', () => {
  const input = {
    content: 'click here',
    previousMessages: [],
    meta: { author: 'spammer#0', roles: ['Member'] }
  };

  test('uses the developer role and the completion-token limit for reasoning models', () => {
    const request = buildRequest('gpt-5-mini', input);

    expect(request.messages[0]).toEqual({ role: 'developer', content: SYSTEM_PROMPT });
    expect(request).toMatchObject({ max_completion_tokens: 200 });
  });

  test('uses the system role and the plain token limit for classic models', () => {
    const request = buildRequest('gpt-4o-mini', input);

    expect(request.messages[0]?.role).toBe('system');
    expect(request).toMatchObject({ max_tokens: 200 });
  });

  test('always asks for JSON, since the reply is parsed as a verdict', () => {
    expect(buildRequest('gpt-4o-mini', input).response_format).toEqual({ type: 'json_object' });
  });

  test('labels the message under analysis with its author and roles', () => {
    const request = buildRequest('gpt-4o-mini', input);

    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Author: spammer#0\nRoles: Member\nMessage: click here'
    });
  });

  test('sends the bare message when nothing is known about the author', () => {
    const request = buildRequest('gpt-4o-mini', { ...input, meta: null });

    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'click here' });
  });

  test('omits the context turn entirely when there is no history', () => {
    expect(buildRequest('gpt-4o-mini', input).messages).toHaveLength(2);
  });

  test('puts channel history in its own turn, before the message under analysis', () => {
    const request = buildRequest('gpt-4o-mini', {
      ...input,
      previousMessages: [
        { author: 'alice', roles: ['Mod'], content: 'hi' },
        { author: 'bob', roles: [], content: 'hey' }
      ]
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[1]?.content).toContain('[alice | Roles: Mod]: hi');
    // A member with no roles is stated as "None", never left blank, so the
    // model cannot read the line as a truncated one.
    expect(request.messages[1]?.content).toContain('[bob | Roles: None]: hey');
  });
});
