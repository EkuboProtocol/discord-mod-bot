export function clefBody(pSpam: number, choice: string, pHigh: number) {
  const rest = Number(((1 - pHigh) / 3).toFixed(2));

  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      model: 'clef',
      answers: {
        spam_or_scam: { type: 'noul', noul: pSpam },
        severity: {
          type: 'choice',
          choice,
          probabilities: { high: pHigh, medium: rest, low: rest, none: rest },
          confidence: 0.5
        }
      },
      usage: { input_tokens: 500, output_tokens: 0 }
    }
  };
}

export function clairicBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      model: 'clairic',
      answers: {
        discord_invite: { type: 'text', p_null: 0.99, confidence: 0.5, value: null },
        external_links: { type: 'list', value: ['Telegram'], spans: [[0, 8]], confidence: 0.03 },
        off_platform_handle: { type: 'text', p_null: 0.01, confidence: 0.95, value: '@scammer' },
        promised_amount_usd: { type: 'number', p_null: 0.01, confidence: 0.97, value: 5000 },
        cut_percent: { type: 'number', p_null: 0, confidence: 1, value: 20 },
        impersonated_party: { type: 'text', p_null: 0.9, confidence: 0.3, value: null },
        asks_for_dm: { type: 'text', p_null: 0.01, confidence: 0.3, value: 'hit me up' },
        ...overrides
      },
      truncated: false,
      usage: { input_tokens: 1500, output_tokens: 0 }
    }
  };
}
