import { describe, expect, test } from 'bun:test';
import { getTokenLimitParam, isModernReasoningModel } from '../src/ai';

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

  test.each([
    'gpt-4o-mini',
    'gpt-4',
    'gpt-3.5-turbo',
    'gpt-4o'
  ])('treats %p as a classic model', model => {
    expect(isModernReasoningModel(model)).toBe(false);
  });

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
