import { describe, expect, test } from 'bun:test';
import { Option, Schema } from 'effect';
import {
  actionFor,
  actionTakenText,
  channelNotice,
  embedHeading,
  ModerationVerdict,
  parseButtonTarget,
  reportEmbed,
  severityOf,
  skipReason,
  truncateForEmbed,
  type Outcome
} from '../src/moderation';

const decode = Schema.decodeUnknownResult(ModerationVerdict);

describe('ModerationVerdict', () => {
  test('fills in the nulls the model is allowed to omit', () => {
    const result = decode({ isSpamOrScam: false });

    expect(result._tag).toBe('Success');
    expect(result._tag === 'Success' && result.success).toEqual({
      isSpamOrScam: false,
      severity: null,
      reason: null
    });
  });

  test('accepts a full verdict', () => {
    const result = decode({ isSpamOrScam: true, severity: 'high', reason: 'phishing link' });

    expect(result._tag === 'Success' && result.success.severity).toBe('high');
  });

  test('rejects a verdict with no verdict in it', () => {
    // A decode failure is what makes the caller fall back to "not spam", so
    // this must fail rather than coerce.
    expect(decode({ severity: 'high' })._tag).toBe('Failure');
    expect(decode({ isSpamOrScam: 'yes' })._tag).toBe('Failure');
    expect(decode('nope')._tag).toBe('Failure');
  });
});

describe('severityOf', () => {
  test.each(['high', 'medium', 'low'] as const)('passes %p through', raw => {
    expect(severityOf(raw)).toBe(raw);
  });

  test('treats an absent severity as medium, the historical default', () => {
    expect(severityOf(null)).toBe('medium');
    expect(severityOf(undefined)).toBe('medium');
    expect(severityOf('')).toBe('medium');
  });

  test('reports a severity it does not recognise rather than guessing', () => {
    expect(severityOf('critical')).toBe('unknown');
    expect(severityOf('HIGH')).toBe('unknown');
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
    // The README documents 0 as "disable timeouts", so it must not become a
    // zero-minute timeout call.
    expect(actionFor('medium', 0)).toEqual({ _tag: 'DeleteOnly' });
  });

  test('low severity never punishes the account', () => {
    expect(actionFor('low', 5)).toEqual({ _tag: 'DeleteOnly' });
  });

  test('an unrecognised severity takes the mildest action, not the harshest', () => {
    // A model that invents a severity must not be able to talk the bot into a
    // ban it did not ask for.
    expect(actionFor('unknown', 5)).toEqual({ _tag: 'DeleteOnly' });
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

    expect(text).toBe('⚠️ Removed a message from <@1> that violated server rules. Reason: phishing');
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
  const input = {
    authorId: '1',
    authorTag: 'spammer#0',
    channelId: '2',
    severity: 'high' as const,
    reason: 'phishing',
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
  });

  test('keeps message content inside Discord\'s 1024-character field limit', () => {
    // Over the limit the whole embed is rejected and the audit trail is lost.
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
    // `None` means every channel; `Some([])` means none of them.
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
    expect(skipReason({ ...facts, channelId: 'other' }, allowList)).toBe(
      'channel-not-moderated'
    );
  });

  test('excluded channels win over the allow-list', () => {
    expect(skipReason({ ...facts, channelId: 'excluded' }, config)).toBe('channel-excluded');
  });

  test('a single excluded role exempts the author', () => {
    expect(skipReason({ ...facts, roleIds: ['member', 'staff'] }, config)).toBe('excluded-role');
  });

  test('ignored phrases are matched case- and whitespace-insensitively', () => {
    expect(skipReason({ ...facts, content: '  GM  ' }, config)).toBe('ignored-phrase');
    // Only the whole message, not a substring of it.
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
    // The old code split and indexed, handing `undefined` to guild.members.ban.
    expect(parseButtonTarget('ban:123')).toBeNull();
    expect(parseButtonTarget('ban::456')).toBeNull();
    expect(parseButtonTarget('ban:123:456:789')).toBeNull();
  });
});
