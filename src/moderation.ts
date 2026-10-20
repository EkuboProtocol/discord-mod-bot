import { Option } from 'effect';
import type { AppConfigShape } from './config';

export type Severity = 'high' | 'medium' | 'low';
export type SeverityChoice = Severity | 'none';

/** Below this probability of spam/scam a message is left alone. */
export const SPAM_THRESHOLD = 0.8;
/** A `high` choice only bans when the model puts at least this much weight on it. */
export const BAN_THRESHOLD = 0.6;
/** The startup check refuses to run if a benign message scores at or above this. */
export const STARTUP_MAX_SPAM = 0.5;

/** Minimum Clairic confidence before a field is used as evidence. */
export const NUMBER_MIN_CONFIDENCE = 0.8;
export const TEXT_MIN_CONFIDENCE = 0.6;
export const PHRASE_MIN_CONFIDENCE = 0.7;
export const LIST_MIN_CONFIDENCE = 0.5;

export interface ClefScores {
  readonly pSpam: number;
  readonly choice: SeverityChoice;
  readonly probabilities: Readonly<Record<SeverityChoice, number>>;
}

export type Decision =
  | { readonly _tag: 'Clean' }
  | { readonly _tag: 'Act'; readonly severity: Severity };

export function decide(scores: ClefScores): Decision {
  if (!(scores.pSpam >= SPAM_THRESHOLD)) {
    return { _tag: 'Clean' };
  }

  switch (scores.choice) {
    case 'high':
      return {
        _tag: 'Act',
        severity: scores.probabilities.high >= BAN_THRESHOLD ? 'high' : 'medium'
      };
    case 'medium':
      return { _tag: 'Act', severity: 'medium' };
    default:
      // `none` while p(spam) is above the threshold: the two answers disagree,
      // so take the mildest action rather than none at all.
      return { _tag: 'Act', severity: 'low' };
  }
}

export interface ExtractedField<A> {
  readonly value: A | null;
  readonly confidence?: number | undefined;
}

export interface ClairicAnswers {
  readonly discord_invite?: ExtractedField<string> | undefined;
  readonly external_links?: ExtractedField<ReadonlyArray<string>> | undefined;
  readonly off_platform_handle?: ExtractedField<string> | undefined;
  readonly promised_amount_usd?: ExtractedField<number> | undefined;
  readonly cut_percent?: ExtractedField<number> | undefined;
  readonly impersonated_party?: ExtractedField<string> | undefined;
  readonly asks_for_dm?: ExtractedField<string> | undefined;
}

export interface Evidence {
  readonly discordInvites: ReadonlyArray<string>;
  readonly externalLinks: ReadonlyArray<string>;
  readonly offPlatformHandle: string | null;
  readonly contactPlatform: string | null;
  readonly promisedAmountUsd: number | null;
  readonly cutPercent: number | null;
  readonly impersonatedParty: string | null;
  readonly asksForDm: string | null;
}

export const NO_EVIDENCE: Evidence = {
  discordInvites: [],
  externalLinks: [],
  offPlatformHandle: null,
  contactPlatform: null,
  promisedAmountUsd: null,
  cutPercent: null,
  impersonatedParty: null,
  asksForDm: null
};

/**
 * Clairic already returns `value: null` once `p_null` passes its threshold;
 * this adds the confidence floor on top.
 */
export function gated<A>(field: ExtractedField<A> | undefined, minConfidence: number): A | null {
  if (!field || field.value === null || field.value === undefined) {
    return null;
  }
  return (field.confidence ?? 0) >= minConfidence ? field.value : null;
}

/**
 * Undo the usual obfuscation of links: a URL broken over quoted lines
 * (`<ht\n> tp\n> ://di\n> sco…`), backslashes for slashes, ideographic full
 * stops for dots.
 */
export function deobfuscate(content: string): string {
  return content
    .replace(/[ \t]*\r?\n[ \t]*(?:>[ \t]*)?/g, '')
    .replace(/\\/g, '/')
    .replace(/[\u3002\uFF61\uFF0E]/g, '.');
}

const INVITE = /(?:discord(?:app)?\.com\/+invite|discord\.gg)\/+([A-Za-z0-9-]{2,32})/gi;
const URL = /https?:\/\/+[^\s<>()*`"'|]+/gi;
const MENTION = /^<?@!?\d{15,21}>?$/;
const PLATFORMS = ['Telegram', 'WhatsApp', 'Signal', 'WeChat'] as const;

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map(v => v.trim()).filter(v => v.length > 0))];
}

export function findInvites(content: string): string[] {
  return unique([...deobfuscate(content).matchAll(INVITE)].map(m => m[1]));
}

export function findLinks(content: string): string[] {
  return unique(
    [...deobfuscate(content).matchAll(URL)]
      .map(m => m[0])
      .filter(url => !/discord(?:app)?\.com\/+invite|discord\.gg/i.test(url))
  );
}

export function findContactPlatform(content: string): string | null {
  return PLATFORMS.find(name => new RegExp(`\\b${name}\\b`, 'i').test(content)) ?? null;
}

function handleOf(answers: ClairicAnswers): string | null {
  const handle = gated(answers.off_platform_handle, TEXT_MIN_CONFIDENCE);
  // A Discord mention is not an off-platform contact, and a span inside an
  // invite link is already reported as the invite.
  return handle === null || MENTION.test(handle.trim()) || /discord/i.test(handle) ? null : handle;
}

/**
 * The deterministic checks are the primary source for links; Clairic is a
 * supplement, used only where it clears its confidence floor.
 */
export function gateEvidence(answers: ClairicAnswers, content: string): Evidence {
  const invite = gated(answers.discord_invite, TEXT_MIN_CONFIDENCE);
  const links = gated(answers.external_links, LIST_MIN_CONFIDENCE) ?? [];

  return {
    discordInvites: unique([...findInvites(content), ...(invite === null ? [] : [invite])]),
    externalLinks: unique([...findLinks(content), ...links]),
    offPlatformHandle: handleOf(answers),
    contactPlatform: findContactPlatform(content),
    promisedAmountUsd: gated(answers.promised_amount_usd, NUMBER_MIN_CONFIDENCE),
    cutPercent: gated(answers.cut_percent, NUMBER_MIN_CONFIDENCE),
    impersonatedParty: gated(answers.impersonated_party, PHRASE_MIN_CONFIDENCE),
    asksForDm: gated(answers.asks_for_dm, PHRASE_MIN_CONFIDENCE)
  };
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

function contactPhrase(evidence: Evidence): string | null {
  if (evidence.contactPlatform !== null) {
    return `directs to ${evidence.contactPlatform}`;
  }
  return evidence.offPlatformHandle === null ? null : 'directs to an off-platform contact';
}

/**
 * Safe to post publicly: it names what the message did but never repeats a
 * link, invite code, handle or quoted phrase from it. Impersonation is left to
 * the moderator report, because Clairic's confidence does not separate a real
 * claim to be staff from a passing mention of some other party.
 */
export function evidenceSummary(evidence: Evidence): string[] {
  const parts: Array<string | null> = [
    evidence.promisedAmountUsd === null
      ? null
      : `promises ${usd.format(evidence.promisedAmountUsd)}`,
    evidence.cutPercent === null ? null : `asks for ${evidence.cutPercent}% of profits`,
    evidence.discordInvites.length > 0 ? 'links to another Discord server' : null,
    evidence.externalLinks.length > 0 ? 'links to an external site' : null,
    contactPhrase(evidence),
    evidence.asksForDm === null ? null : 'asks users to reach out privately'
  ];
  return parts.filter((part): part is string => part !== null);
}

const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function templateReason(severity: Severity, pSpam: number, evidence: Evidence): string {
  const head = `${SEVERITY_LABEL[severity]}-severity spam/scam (p=${pSpam.toFixed(2)})`;
  const parts = evidenceSummary(evidence);
  return parts.length === 0 ? head : `${head}: ${parts.join('; ')}`;
}

export type ModerationVerdict =
  | { readonly _tag: 'Clean' }
  | {
      readonly _tag: 'Flagged';
      readonly severity: Severity;
      readonly scores: ClefScores;
      readonly evidence: Evidence;
      readonly reason: string;
    };

export const CLEAN: ModerationVerdict = { _tag: 'Clean' };

export function flaggedVerdict(
  severity: Severity,
  scores: ClefScores,
  evidence: Evidence
): ModerationVerdict {
  return {
    _tag: 'Flagged',
    severity,
    scores,
    evidence,
    reason: templateReason(severity, scores.pSpam, evidence)
  };
}

export type Action =
  | { readonly _tag: 'BanThenTimeout'; readonly fallbackTimeoutMinutes: number | null }
  | { readonly _tag: 'Timeout'; readonly minutes: number }
  | { readonly _tag: 'DeleteOnly' };

export function actionFor(severity: Severity, timeoutDuration: number): Action {
  const timeoutMinutes = timeoutDuration > 0 ? timeoutDuration : null;

  switch (severity) {
    case 'high':
      return { _tag: 'BanThenTimeout', fallbackTimeoutMinutes: timeoutMinutes };
    case 'medium':
      return timeoutMinutes === null
        ? { _tag: 'DeleteOnly' }
        : { _tag: 'Timeout', minutes: timeoutMinutes };
    case 'low':
      return { _tag: 'DeleteOnly' };
  }
}

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
  readonly mentionedUserIds: ReadonlyArray<string>;
}

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
  readonly verdict: Extract<ModerationVerdict, { _tag: 'Flagged' }>;
  readonly content: string;
  readonly outcome: Outcome;
  readonly at: Date;
}

/** Inline code that a hostile value cannot break out of, reflow, or overflow. */
export function codeSpan(value: string): string {
  const flat = value.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return `\`${flat.length > 200 ? `${flat.slice(0, 197)}...` : flat}\``;
}

/** Moderator-only: the typed evidence, values shown verbatim as code. */
export function evidenceLines(evidence: Evidence): string[] {
  const entries: Array<[string, string | number | ReadonlyArray<string> | null]> = [
    ['discord_invite', evidence.discordInvites],
    ['external_links', evidence.externalLinks],
    ['off_platform_handle', evidence.offPlatformHandle],
    ['contact_platform', evidence.contactPlatform],
    ['promised_amount_usd', evidence.promisedAmountUsd],
    ['cut_percent', evidence.cutPercent],
    ['impersonated_party', evidence.impersonatedParty],
    ['asks_for_dm', evidence.asksForDm]
  ];

  return entries.flatMap(([name, value]) => {
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      return [];
    }
    const values: ReadonlyArray<string | number> = Array.isArray(value) ? value : [value];
    return [`${name}: ${values.map(v => codeSpan(String(v))).join(', ')}`];
  });
}

export function scoresText(scores: ClefScores): string {
  const { probabilities: p } = scores;
  return (
    `p(spam) ${scores.pSpam.toFixed(3)} · choice ${scores.choice} · ` +
    `high ${p.high.toFixed(2)} / medium ${p.medium.toFixed(2)} / ` +
    `low ${p.low.toFixed(2)} / none ${p.none.toFixed(2)}`
  );
}

export function reportEmbed(input: ReportInput) {
  const { title, color } = embedHeading(input.outcome);
  const { verdict } = input;
  const evidence = evidenceLines(verdict.evidence);

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
      { name: 'Severity', value: SEVERITY_LABEL[verdict.severity], inline: true },
      { name: 'Timestamp', value: input.at.toISOString(), inline: true },
      { name: 'Reason', value: verdict.reason },
      { name: 'Scores', value: scoresText(verdict.scores) },
      ...(evidence.length === 0
        ? []
        : [{ name: 'Evidence', value: truncateForEmbed(evidence.join('\n')) }]),
      { name: 'Message Content', value: truncateForEmbed(input.content) },
      { name: 'Action Taken', value: actionTakenText(input.outcome) }
    ],
    timestamp: input.at.toISOString(),
    footer: { text: 'Discord Moderation Bot' }
  };
}

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

export const MODERATION_ACTIONS = ['ban', 'unban', 'delete'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export interface ButtonTarget {
  readonly action: ModerationAction;
  readonly userId: string;
  readonly guildId: string;
}

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
