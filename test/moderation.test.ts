import { describe, expect, test } from 'bun:test';
import { Option } from 'effect';
import {
  actionFor,
  actionTakenText,
  BAN_THRESHOLD,
  channelNotice,
  codeSpan,
  decide,
  deobfuscate,
  embedHeading,
  evidenceLines,
  findContactPlatform,
  findInvites,
  findLinks,
  flaggedVerdict,
  gated,
  gateEvidence,
  NO_EVIDENCE,
  parseButtonTarget,
  reportEmbed,
  skipReason,
  SPAM_THRESHOLD,
  templateReason,
  truncateForEmbed,
  type ClefScores,
  type Evidence,
  type Outcome,
  type SeverityChoice
} from '../src/moderation';

function scores(pSpam: number, choice: SeverityChoice, pHigh = 0.9): ClefScores {
  const rest = (1 - pHigh) / 3;
  return { pSpam, choice, probabilities: { high: pHigh, medium: rest, low: rest, none: rest } };
}

describe('decide', () => {
  test('the measured constants', () => {
    expect(SPAM_THRESHOLD).toBe(0.8);
    expect(BAN_THRESHOLD).toBe(0.6);
  });

  test('below the spam threshold nothing happens, whatever the severity says', () => {
    expect(decide(scores(0.79, 'high', 0.99))).toEqual({ _tag: 'Clean' });
    expect(decide(scores(0, 'none'))).toEqual({ _tag: 'Clean' });
  });

  test('a probability that is not a number is not spam', () => {
    expect(decide(scores(Number.NaN, 'high'))).toEqual({ _tag: 'Clean' });
  });

  test('at the threshold a confident high bans', () => {
    expect(decide(scores(0.8, 'high', 0.6))).toEqual({ _tag: 'Act', severity: 'high' });
  });

  test('a high choice without p(high) >= 0.6 degrades to a timeout', () => {
    expect(decide(scores(0.99, 'high', 0.59))).toEqual({ _tag: 'Act', severity: 'medium' });
  });

  test.each(['medium', 'low'] as const)('%s maps straight through', choice => {
    expect(decide(scores(0.95, choice, 0.1))).toEqual({ _tag: 'Act', severity: choice });
  });

  test('none while p(spam) is above the threshold takes the mildest action', () => {
    expect(decide(scores(0.9, 'none', 0.1))).toEqual({ _tag: 'Act', severity: 'low' });
  });
});

describe('gated', () => {
  test('uses a value that clears the confidence floor', () => {
    expect(gated({ value: 5000, confidence: 0.9 }, 0.8)).toBe(5000);
  });

  test('drops a low-confidence value', () => {
    expect(gated({ value: 5000, confidence: 0.7 }, 0.8)).toBeNull();
    expect(gated({ value: 5000 }, 0.8)).toBeNull();
  });

  test('a null value (p_null above threshold) is never used', () => {
    expect(gated({ value: null, confidence: 1 }, 0.8)).toBeNull();
    expect(gated(undefined, 0.8)).toBeNull();
  });
});

describe('deterministic checks', () => {
  const mangled =
    '**Please continue here** :point_down: \n> **><ht\n> tp\n> \n> ://di\n> sco\n> ' +
    'rdapp\u3002\n> com\\invite\\QEBEfsrMx>>** <@442409344458555402>';

  test('rejoins a link broken across quoted lines', () => {
    expect(deobfuscate(mangled)).toContain('<http://discordapp.com/invite/QEBEfsrMx>');
  });

  test('finds invites, plain or obfuscated', () => {
    expect(findInvites(mangled)).toEqual(['QEBEfsrMx']);
    expect(findInvites('join discord.gg/abc123 now')).toEqual(['abc123']);
    expect(findInvites('no invite here')).toEqual([]);
  });

  test('finds links but leaves invites to the invite check', () => {
    expect(findLinks('see <h\ntt\nps://\nt.co/UDq1HgHSBA>')).toEqual(['https://t.co/UDq1HgHSBA']);
    expect(findLinks(mangled)).toEqual([]);
  });

  test('names the off-platform app a message points to', () => {
    expect(findContactPlatform('ask me via Telegram username')).toBe('Telegram');
    expect(findContactPlatform('message me on whatsapp')).toBe('WhatsApp');
    expect(findContactPlatform('how do I swap')).toBeNull();
  });
});

describe('gateEvidence', () => {
  test('keeps confident numbers and drops unsure phrases', () => {
    const evidence = gateEvidence(
      {
        promised_amount_usd: { value: 60000, confidence: 0.91 },
        cut_percent: { value: 10, confidence: 1 },
        asks_for_dm: { value: 'Panel', confidence: 0.09 },
        impersonated_party: { value: 'the te_am', confidence: 0.8 }
      },
      'text'
    );

    expect(evidence).toMatchObject({
      promisedAmountUsd: 60000,
      cutPercent: 10,
      asksForDm: null,
      impersonatedParty: 'the te_am'
    });
  });

  test('a Discord mention is not an off-platform handle', () => {
    const evidence = gateEvidence(
      { off_platform_handle: { value: '@182530156563398658', confidence: 0.63 } },
      'text'
    );

    expect(evidence.offPlatformHandle).toBeNull();
  });

  test('the regex finds the invite even when Clairic is unsure of it', () => {
    const evidence = gateEvidence(
      { discord_invite: { value: 'abc123', confidence: 0.3 } },
      'go to discord.gg/abc123'
    );

    expect(evidence.discordInvites).toEqual(['abc123']);
  });

  test('ignores the near-zero confidence Clairic gives link lists', () => {
    const evidence = gateEvidence(
      { external_links: { value: ['Telegram', 'The'], confidence: 0.03 } },
      'text'
    );

    expect(evidence.externalLinks).toEqual([]);
  });

  test('nothing extracted is nothing reported', () => {
    expect(gateEvidence({}, 'plain text')).toEqual(NO_EVIDENCE);
  });
});

const fullEvidence: Evidence = {
  discordInvites: ['QEBEfsrMx'],
  externalLinks: ['https://evil.example/claim'],
  offPlatformHandle: '@scammer',
  contactPlatform: 'Telegram',
  promisedAmountUsd: 5000,
  cutPercent: 20,
  impersonatedParty: 'Ekubo Support',
  asksForDm: 'send me a DM'
};

describe('templateReason', () => {
  test('severity and probability alone when there is no evidence', () => {
    expect(templateReason('medium', 0.874, NO_EVIDENCE)).toBe('Medium-severity spam/scam (p=0.87)');
  });

  test('lists the evidence in a fixed order', () => {
    expect(templateReason('high', 0.97, fullEvidence)).toBe(
      'High-severity spam/scam (p=0.97): promises $5,000; asks for 20% of profits; ' +
        'links to another Discord server; links to an external site; directs to Telegram; ' +
        'asks users to reach out privately'
    );
  });

  test('describes an unnamed contact without repeating it', () => {
    const reason = templateReason('high', 0.9, {
      ...NO_EVIDENCE,
      offPlatformHandle: '@scammer'
    });

    expect(reason).toEndWith('directs to an off-platform contact');
  });

  test('never echoes a URL, invite code, handle or quoted phrase', () => {
    const reason = templateReason('high', 0.97, fullEvidence);

    for (const secret of ['QEBEfsrMx', 'evil.example', '@scammer', 'Ekubo Support', 'DM']) {
      expect(reason).not.toContain(secret);
    }
  });
});

describe('evidenceLines', () => {
  test('shows typed values verbatim, in code', () => {
    expect(evidenceLines(fullEvidence)).toContain('discord_invite: `QEBEfsrMx`');
    expect(evidenceLines(fullEvidence)).toContain('promised_amount_usd: `5000`');
  });

  test('omits what was not found', () => {
    expect(evidenceLines(NO_EVIDENCE)).toEqual([]);
  });

  test('a hostile value cannot break out of its code span', () => {
    expect(codeSpan('a`b\n@everyone')).toBe("`a'b @everyone`");
    expect(codeSpan('x'.repeat(500))).toHaveLength(202);
  });
});

describe('actionFor', () => {
  test('high severity bans, keeping the timeout as a fallback', () => {
    expect(actionFor('high', 5)).toEqual({
      _tag: 'BanThenTimeout',
      fallbackTimeoutMinutes: 5
    });
  });

  test('high severity still bans when timeouts are disabled, with no fallback', () => {
    expect(actionFor('high', 0)).toEqual({
      _tag: 'BanThenTimeout',
      fallbackTimeoutMinutes: null
    });
  });

  test('medium severity times the user out', () => {
    expect(actionFor('medium', 5)).toEqual({ _tag: 'Timeout', minutes: 5 });
  });

  test('TIMEOUT_DURATION=0 downgrades a medium result to a plain delete', () => {
    expect(actionFor('medium', 0)).toEqual({ _tag: 'DeleteOnly' });
  });

  test('low severity never punishes the account', () => {
    expect(actionFor('low', 5)).toEqual({ _tag: 'DeleteOnly' });
  });
});

describe('channelNotice', () => {
  const base = { authorMention: '<@1>', reason: 'phishing', mentionedUserIds: [] };

  test('announces a ban', () => {
    expect(channelNotice({ ...base, outcome: { _tag: 'Banned' } })).toBe(
      '🚫 Banned user <@1> for posting high-severity spam/scam. Reason: phishing'
    );
  });

  test('announces a timeout with a correctly pluralised duration', () => {
    expect(channelNotice({ ...base, outcome: { _tag: 'TimedOut', minutes: 1 } })).toContain(
      'timed out for 1 minute.'
    );
    expect(channelNotice({ ...base, outcome: { _tag: 'TimedOut', minutes: 5 } })).toContain(
      'timed out for 5 minutes.'
    );
  });

  test('a delete-only removal mentions no punishment', () => {
    const text = channelNotice({ ...base, outcome: { _tag: 'DeletedOnly' } });

    expect(text).toBe(
      '⚠️ Removed a message from <@1> that violated server rules. Reason: phishing'
    );
    expect(text).not.toContain('timed out');
  });

  test('warns the users the scam message tagged', () => {
    const text = channelNotice({
      ...base,
      outcome: { _tag: 'DeletedOnly' },
      mentionedUserIds: ['7', '8']
    });

    expect(text).toEndWith('Heads up to tagged users: <@7> <@8>');
  });
});

describe('reportEmbed', () => {
  const at = new Date('2026-09-01T12:00:00.000Z');
  const verdict = flaggedVerdict('high', scores(0.97, 'high', 0.91), fullEvidence);
  if (verdict._tag !== 'Flagged') throw new Error('expected a flagged verdict');
  const input = {
    authorId: '1',
    authorTag: 'spammer#0',
    channelId: '2',
    verdict,
    content: 'click here',
    at
  };

  test('colours and titles itself by what actually happened', () => {
    expect(embedHeading({ _tag: 'Banned' }).color).toBe(0x992d22);
    expect(embedHeading({ _tag: 'TimedOut', minutes: 5 }).color).toBe(0xe74c3c);
    expect(embedHeading({ _tag: 'DeletedOnly' }).color).toBe(0xf1c40f);
  });

  test.each([
    [{ _tag: 'Banned' } as Outcome, 'User was automatically banned (high-severity spam/scam)'],
    [{ _tag: 'TimedOut', minutes: 5 } as Outcome, 'User timed out for 5 minutes'],
    [{ _tag: 'DeletedOnly' } as Outcome, 'Message deleted (no timeout applied)']
  ])('records the action taken', (outcome, expected) => {
    expect(actionTakenText(outcome)).toBe(expected);
  });

  test('renders every field Discord will be asked to display', () => {
    const embed = reportEmbed({ ...input, outcome: { _tag: 'Banned' } });
    const byName = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));

    expect(byName.User).toBe('<@1> (spammer#0, 1)');
    expect(byName.Channel).toBe('<#2> (2)');
    expect(byName.Severity).toBe('High');
    expect(byName.Timestamp).toBe('2026-09-01T12:00:00.000Z');
    expect(byName.Reason).toStartWith('High-severity spam/scam (p=0.97)');
    expect(byName.Scores).toContain('p(spam) 0.970');
    expect(byName.Evidence).toContain('off_platform_handle: `@scammer`');
  });

  test('leaves out the evidence field when there is none', () => {
    const bare = flaggedVerdict('low', scores(0.85, 'low', 0.1), NO_EVIDENCE);
    if (bare._tag !== 'Flagged') throw new Error('expected a flagged verdict');
    const embed = reportEmbed({ ...input, verdict: bare, outcome: { _tag: 'DeletedOnly' } });

    expect(embed.fields.map(f => f.name)).not.toContain('Evidence');
  });

  test("keeps message content inside Discord's 1024-character field limit", () => {
    const long = 'x'.repeat(5000);

    expect(truncateForEmbed(long)).toHaveLength(1024);
    expect(truncateForEmbed(long)).toEndWith('...');
    expect(truncateForEmbed('short')).toBe('short');
  });
});

describe('skipReason', () => {
  const config = {
    serverId: 'guild-1',
    moderatedChannels: Option.none<ReadonlyArray<string>>(),
    excludedChannels: ['excluded'],
    excludedRoles: ['staff'],
    ignoredPhrases: ['gm']
  };

  const facts = {
    authorIsBot: false,
    guildId: 'guild-1',
    channelId: 'general',
    roleIds: ['member'],
    content: 'hello'
  };

  test('moderates an ordinary message', () => {
    expect(skipReason(facts, config)).toBeNull();
  });

  test('never moderates another bot, which is how feedback loops start', () => {
    expect(skipReason({ ...facts, authorIsBot: true }, config)).toBe('bot-author');
  });

  test('ignores other servers and direct messages', () => {
    expect(skipReason({ ...facts, guildId: 'guild-2' }, config)).toBe('other-guild');
    expect(skipReason({ ...facts, guildId: null }, config)).toBe('other-guild');
  });

  test('an empty allow-list is not the same as no allow-list', () => {
    const allowNothing = { ...config, moderatedChannels: Option.some<ReadonlyArray<string>>([]) };

    expect(skipReason(facts, allowNothing)).toBe('channel-not-moderated');
    expect(skipReason(facts, config)).toBeNull();
  });

  test('honours an explicit allow-list', () => {
    const allowList = {
      ...config,
      moderatedChannels: Option.some<ReadonlyArray<string>>(['general'])
    };

    expect(skipReason(facts, allowList)).toBeNull();
    expect(skipReason({ ...facts, channelId: 'other' }, allowList)).toBe('channel-not-moderated');
  });

  test('excluded channels win over the allow-list', () => {
    expect(skipReason({ ...facts, channelId: 'excluded' }, config)).toBe('channel-excluded');
  });

  test('a single excluded role exempts the author', () => {
    expect(skipReason({ ...facts, roleIds: ['member', 'staff'] }, config)).toBe('excluded-role');
  });

  test('ignored phrases are matched case- and whitespace-insensitively', () => {
    expect(skipReason({ ...facts, content: '  GM  ' }, config)).toBe('ignored-phrase');
    expect(skipReason({ ...facts, content: 'gm everyone' }, config)).toBeNull();
  });
});

describe('parseButtonTarget', () => {
  test('reads a well-formed moderation button', () => {
    expect(parseButtonTarget('ban:123:456')).toEqual({
      action: 'ban',
      userId: '123',
      guildId: '456'
    });
  });

  test.each(['unban', 'delete'])('recognises the %p action', action => {
    expect(parseButtonTarget(`${action}:1:2`)?.action).toBe(action);
  });

  test('rejects buttons that are not ours', () => {
    expect(parseButtonTarget('kick:1:2')).toBeNull();
    expect(parseButtonTarget('some-other-feature')).toBeNull();
  });

  test('rejects truncated or overlong IDs rather than passing undefined onward', () => {
    expect(parseButtonTarget('ban:123')).toBeNull();
    expect(parseButtonTarget('ban::456')).toBeNull();
    expect(parseButtonTarget('ban:123:456:789')).toBeNull();
  });
});
