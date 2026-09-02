import { Cause, Predicate, Schema } from 'effect';
import { flagFor } from './config';

/**
 * Human-readable text for an unknown thrown value.
 *
 * Every boundary in this bot talks to something that throws `unknown` — the
 * Discord REST client, the OpenAI SDK, `fetch` — so the one place that knows
 * how to render those lives here rather than repeated at each call site.
 */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A Discord REST/gateway call failed. `op` names the call, for the log line. */
export class DiscordError extends Schema.TaggedError<DiscordError>()('DiscordError', {
  op: Schema.String,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `${this.op}: ${describeCause(this.cause)}`;
  }
}

/** The OpenAI chat completion request failed or returned nothing usable. */
export class OpenAiError extends Schema.TaggedError<OpenAiError>()('OpenAiError', {
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `OpenAI request failed: ${describeCause(this.cause)}`;
  }
}

/** An Ekubo API request failed, timed out, or returned a non-2xx status. */
export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  url: Schema.String,
  cause: Schema.Defect()
}) {
  override get message(): string {
    return `GET ${this.url} failed: ${describeCause(this.cause)}`;
  }
}

/**
 * Discord's "Unknown Message" error code. Deleting a message that a human
 * moderator or automod already removed is a race we expect, not a failure.
 */
export const UNKNOWN_MESSAGE_CODE = 10008;

/** Returns true when Discord reports the target message no longer exists. */
export function isUnknownMessageError(error: unknown): boolean {
  return Predicate.hasProperty(error, 'code') && error.code === UNKNOWN_MESSAGE_CODE;
}

/**
 * Returns true when the gateway rejected the connection because a privileged
 * intent is not enabled for this application.
 *
 * The bot needs Message Content, which is privileged: it must be switched on
 * for the application in the Discord Developer Portal, and no amount of
 * redeploying fixes it from this side.
 */
export function isDisallowedIntentsError(error: unknown): boolean {
  return Predicate.hasProperty(error, 'code') && error.code === 'DisallowedIntents';
}

/** What to tell an operator staring at a bot that will not start. */
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

/**
 * Turn a startup failure into something an operator can act on.
 *
 * The two ways this bot fails to start are both fixed by a human somewhere
 * else — a missing environment variable, or a privileged intent that is not
 * switched on — so both get instructions instead of a stack trace. Anything
 * else falls through to the full cause, which is what you want for a genuine
 * bug.
 */
export function explainStartupFailure(cause: Cause.Cause<unknown>): string {
  const failed = cause.reasons.filter(Cause.isFailReason).map(reason => reason.error);

  if (
    failed.some(error => error instanceof DiscordError && isDisallowedIntentsError(error.cause))
  ) {
    return DISALLOWED_INTENTS_HELP;
  }

  // A ConfigError points at the setting it could not read as `at ["NAME"]`.
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
