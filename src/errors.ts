import { Cause, Predicate, Schema } from 'effect';
import { flagFor } from './config';

export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class DiscordError extends Schema.TaggedError<DiscordError>()('DiscordError', {
  op: Schema.String,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `${this.op}: ${describeCause(this.cause)}`;
  }
}

export class WorkersAiError extends Schema.TaggedError<WorkersAiError>()('WorkersAiError', {
  model: Schema.String,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `Workers AI ${this.model} request failed: ${describeCause(this.cause)}`;
  }
}

export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  url: Schema.String,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `GET ${this.url} failed: ${describeCause(this.cause)}`;
  }
}

export const UNKNOWN_MESSAGE_CODE = 10008;

export function isUnknownMessageError(error: unknown): boolean {
  return Predicate.hasProperty(error, 'code') && error.code === UNKNOWN_MESSAGE_CODE;
}

export function isDisallowedIntentsError(error: unknown): boolean {
  return Predicate.hasProperty(error, 'code') && error.code === 'DisallowedIntents';
}

export const DISALLOWED_INTENTS_HELP = [
  'Discord refused the connection: a privileged intent is not enabled for this application.',
  '',
  'This bot requires the MESSAGE CONTENT intent — without the text of a message',
  'there is nothing to moderate.',
  '',
  'Enable it at https://discord.com/developers/applications → your application →',
  'Bot → Privileged Gateway Intents → Message Content Intent, then restart.',
  'The token itself does not need to be regenerated.'
].join('\n');

export function explainStartupFailure(cause: Cause.Cause<unknown>): string {
  const failed = cause.reasons.filter(Cause.isFailReason).map(reason => reason.error);

  if (
    failed.some(error => error instanceof DiscordError && isDisallowedIntentsError(error.cause))
  ) {
    return DISALLOWED_INTENTS_HELP;
  }

  const missing = [
    ...new Set([...Cause.pretty(cause).matchAll(/at \["([A-Z0-9_]+)"\]/g)].map(m => m[1]!))
  ];

  if (missing.length === 0) {
    return Cause.pretty(cause);
  }

  return missing
    .map(name => {
      const flag = flagFor(name);
      return `${name} is required. Set it via the ${name} env variable${
        flag ? ` or the ${flag} flag` : ''
      }.`;
    })
    .join('\n');
}
