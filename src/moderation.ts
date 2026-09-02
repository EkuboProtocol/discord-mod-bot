import { Effect, Option, Schema } from 'effect';
import type { AppConfigShape } from './config';

/**
 * The moderation decision core: every rule about *what should happen* lives
 * here as a total function over plain data, with no Discord or OpenAI types in
 * sight. That is what makes the severity ladder testable — previously it was
 * reachable only through a live `messageCreate` event.
 */

export const Severity = Schema.Literals(['high', 'medium', 'low']);
export type Severity = typeof Severity.Type;

/** A field the model may omit entirely; absent decodes to `null`. */
const nullableText = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null))
);

/**
 * The shape the model is asked to return.
 *
 * `severity` is a loose string rather than the `Severity` literal on purpose:
 * a model that invents a fourth severity should degrade to the mildest action,
 * not fail the whole decode and let the message stand.
 */
export const ModerationVerdict = Schema.Struct({
  isSpamOrScam: Schema.Boolean,
  severity: nullableText,
  reason: nullableText
});
export type ModerationVerdict = typeof ModerationVerdict.Type;

export const DEFAULT_REASON = 'Detected as spam/scam by moderation system';

/** The verdict used whenever the model call or its decode fails: take no action. */
export const CLEAN: ModerationVerdict = {
  isSpamOrScam: false,
  severity: null,
  reason: null
};

/**
 * Normalise the model's severity string.
 *
 * Absent means `medium`, which is the historical default; an unrecognised value
 * is reported as `unknown` so the caller can pick the conservative action
 * rather than guessing which end of the ladder it belongs on.
 */
export function severityOf(raw: string | null | undefined): Severity | 'unknown' {
  if (raw === null || raw === undefined || raw === '') {
    return 'medium';
  }
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : 'unknown';
}

/**
 * What to do about a flagged message.
 *
 * `BanThenTimeout` carries its own fallback because a ban can fail for reasons
 * that have nothing to do with the message — a role hierarchy that puts the
 * author above the bot, most often — and silently doing nothing in that case
 * would be the worst outcome of the three.
 */
export type Action =
  | { readonly _tag: 'BanThenTimeout'; readonly fallbackTimeoutMinutes: number | null }
  | { readonly _tag: 'Timeout'; readonly minutes: number }
  | { readonly _tag: 'DeleteOnly' };

export function actionFor(
  severity: Severity | 'unknown',
  timeoutDuration: number
): Action {
  const timeoutMinutes = timeoutDuration > 0 ? timeoutDuration : null;

  switch (severity) {
    case 'high':
      return { _tag: 'BanThenTimeout', fallbackTimeoutMinutes: timeoutMinutes };
    case 'medium':
      return timeoutMinutes === null
        ? { _tag: 'DeleteOnly' }
        : { _tag: 'Timeout', minutes: timeoutMinutes };
    default:
      // Low severity, and anything unrecognised: remove the message, leave the
      // account alone.
      return { _tag: 'DeleteOnly' };
  }
}

/** What actually happened, after Discord had its say. */
export type Outcome =
  | { readonly _tag: 'Banned' }
  | { readonly _tag: 'TimedOut'; readonly minutes: number }
  | { readonly _tag: 'DeletedOnly' };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export interface ChannelNoticeInput {
  readonly authorMention: string;
  readonly reason: string;
  readonly outcome: Outcome;
  /** Users the offending message tagged, excluding its author. */
  readonly mentionedUserIds: ReadonlyArray<string>;
}

/** The short, self-deleting notice posted in the channel the message came from. */
export function channelNotice(input: ChannelNoticeInput): string {
  const { authorMention, reason, outcome, mentionedUserIds } = input;

  let text =
    outcome._tag === 'Banned'
      ? `🚫 Banned user ${authorMention} for posting high-severity spam/scam. Reason: ${reason}`
      : `⚠️ Removed a message from ${authorMention} that violated server rules. Reason: ${reason}`;

  if (outcome._tag === 'TimedOut') {
    text += ` User has been timed out for ${plural(outcome.minutes, 'minute')}.`;
  }

  if (mentionedUserIds.length > 0) {
    const tagged = mentionedUserIds.map(id => `<@${id}>`).join(' ');
    const noun = mentionedUserIds.length === 1 ? 'user' : 'users';
    text += ` Heads up to tagged ${noun}: ${tagged}`;
  }

  return text;
}

export function actionTakenText(outcome: Outcome): string {
  switch (outcome._tag) {
    case 'Banned':
      return 'User was automatically banned (high-severity spam/scam)';
    case 'TimedOut':
      return `User timed out for ${plural(outcome.minutes, 'minute')}`;
    case 'DeletedOnly':
      return 'Message deleted (no timeout applied)';
  }
}

/** Discord rejects embed field values over 1024 characters. */
export function truncateForEmbed(content: string): string {
  return content.length > 1024 ? `${content.substring(0, 1021)}...` : content;
}

export function embedHeading(outcome: Outcome): { title: string; color: number } {
  switch (outcome._tag) {
    case 'Banned':
      return { title: 'Moderation Action: User Automatically Banned', color: 0x992d22 };
    case 'TimedOut':
      return { title: 'Moderation Action: Message Removed & User Timed Out', color: 0xe74c3c };
    case 'DeletedOnly':
      return { title: 'Moderation Action: Message Removed', color: 0xf1c40f };
  }
}

export interface ReportInput {
  readonly authorId: string;
  readonly authorTag: string;
  readonly channelId: string;
  readonly severity: Severity | 'unknown';
  readonly reason: string;
  readonly content: string;
  readonly outcome: Outcome;
  readonly at: Date;
}

/** The detailed embed sent to the notification channel. */
export function reportEmbed(input: ReportInput) {
  const { title, color } = embedHeading(input.outcome);

  return {
    title,
    color,
    description: 'A message has been removed for violating server rules.',
    fields: [
      {
        name: 'User',
        value: `<@${input.authorId}> (${input.authorTag}, ${input.authorId})`,
        inline: true
      },
      { name: 'Channel', value: `<#${input.channelId}> (${input.channelId})`, inline: true },
      {
        name: 'Severity',
        value: input.severity.charAt(0).toUpperCase() + input.severity.slice(1),
        inline: true
      },
      { name: 'Timestamp', value: input.at.toISOString(), inline: true },
      { name: 'Reason', value: input.reason },
      { name: 'Message Content', value: truncateForEmbed(input.content) },
      { name: 'Action Taken', value: actionTakenText(input.outcome) }
    ],
    timestamp: input.at.toISOString(),
    footer: { text: 'Discord Moderation Bot' }
  };
}

/** Everything the skip rules need to know about an incoming message. */
export interface MessageFacts {
  readonly authorIsBot: boolean;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly roleIds: ReadonlyArray<string>;
  readonly content: string;
}

export type SkipReason =
  | 'bot-author'
  | 'other-guild'
  | 'channel-not-moderated'
  | 'channel-excluded'
  | 'excluded-role'
  | 'ignored-phrase';

type SkipConfig = Pick<
  AppConfigShape,
  'serverId' | 'moderatedChannels' | 'excludedChannels' | 'excludedRoles' | 'ignoredPhrases'
>;

/**
 * Why this message should not reach the model, or `null` to analyse it.
 *
 * Returning a reason rather than a boolean is what lets the caller log *which*
 * rule fired without duplicating the rules at the log site.
 */
export function skipReason(facts: MessageFacts, config: SkipConfig): SkipReason | null {
  if (facts.authorIsBot) return 'bot-author';
  if (facts.guildId === null || facts.guildId !== config.serverId) return 'other-guild';

  const moderated = Option.getOrNull(config.moderatedChannels);
  if (moderated !== null && !moderated.includes(facts.channelId)) {
    return 'channel-not-moderated';
  }
  if (config.excludedChannels.includes(facts.channelId)) return 'channel-excluded';
  if (facts.roleIds.some(id => config.excludedRoles.includes(id))) return 'excluded-role';
  if (config.ignoredPhrases.includes(facts.content.trim().toLowerCase())) {
    return 'ignored-phrase';
  }

  return null;
}

/** A moderation button embedded in a report: `action:userId:guildId`. */
export const MODERATION_ACTIONS = ['ban', 'unban', 'delete'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export interface ButtonTarget {
  readonly action: ModerationAction;
  readonly userId: string;
  readonly guildId: string;
}

/**
 * Parse a button's custom ID, or `null` if it is not one of ours.
 *
 * The old code checked the prefix, split, and then indexed into the parts,
 * leaving `userId` and `guildId` typed as `string | undefined` and passed
 * straight to `guild.members.ban`. Validating once, here, is what makes the
 * three handlers below able to take plain `string`s.
 */
export function parseButtonTarget(customId: string): ButtonTarget | null {
  const [action, userId, guildId, ...rest] = customId.split(':');

  if (
    rest.length > 0 ||
    !action ||
    !userId ||
    !guildId ||
    !(MODERATION_ACTIONS as ReadonlyArray<string>).includes(action)
  ) {
    return null;
  }

  return { action: action as ModerationAction, userId, guildId };
}
