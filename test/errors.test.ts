import { describe, expect, test } from 'bun:test';
import { Cause, Config, Effect, Exit } from 'effect';
import {
  DiscordError,
  explainStartupFailure,
  isDisallowedIntentsError,
  isUnknownMessageError
} from '../src/errors';

/** The cause a failed startup effect actually produces, not a hand-built one. */
function causeOf<E>(error: E): Cause.Cause<E> {
  const exit = Effect.runSyncExit(Effect.fail(error));
  if (!Exit.isFailure(exit)) throw new Error('expected a failure');
  return exit.cause;
}

describe('isDisallowedIntentsError', () => {
  test('recognises the gateway rejecting a privileged intent', () => {
    // discord.js surfaces gateway close 4014 as this error code.
    expect(isDisallowedIntentsError({ code: 'DisallowedIntents' })).toBe(true);
  });

  test('does not match an ordinary bad token', () => {
    expect(isDisallowedIntentsError({ code: 'TokenInvalid' })).toBe(false);
  });

  test('tolerates non-object throws', () => {
    expect(isDisallowedIntentsError(null)).toBe(false);
    expect(isDisallowedIntentsError('DisallowedIntents')).toBe(false);
  });

  test('is not confused with the unknown-message code', () => {
    expect(isUnknownMessageError({ code: 'DisallowedIntents' })).toBe(false);
    expect(isDisallowedIntentsError({ code: 10008 })).toBe(false);
  });
});

describe('explainStartupFailure', () => {
  test('a missing intent gets instructions, not a stack trace', () => {
    // This is what the bot prints on every restart until Message Content is
    // enabled in the Developer Portal, so it has to say exactly that.
    const cause = causeOf(
      new DiscordError({ op: 'log in to Discord', cause: { code: 'DisallowedIntents' } })
    );
    const text = explainStartupFailure(cause);

    expect(text).toContain('MESSAGE CONTENT');
    expect(text).toContain('discord.com/developers/applications');
    expect(text).not.toContain('DiscordError');
    expect(text).not.toContain('.ts:');
  });

  test('a missing setting names both ways to supply it', async () => {
    // Not DISCORD_TOKEN: test/setup.ts puts that in the environment.
    const exit = await Effect.runPromiseExit(Config.string('WELCOME_CHANNEL_ID'));
    const text = Exit.isFailure(exit) ? explainStartupFailure(exit.cause) : '';

    expect(text).toBe(
      'WELCOME_CHANNEL_ID is required. Set it via the WELCOME_CHANNEL_ID env variable ' +
        'or the --welcome-channel flag.'
    );
  });

  test('a setting with no flag mentions only the environment variable', async () => {
    const exit = await Effect.runPromiseExit(Config.string('PRESENCE_INTERVAL_MS'));
    const text = Exit.isFailure(exit) ? explainStartupFailure(exit.cause) : '';

    expect(text).toBe(
      'PRESENCE_INTERVAL_MS is required. Set it via the PRESENCE_INTERVAL_MS env variable.'
    );
  });

  test('an unrecognised failure falls through to the full cause', () => {
    // A genuine bug should not be reduced to a friendly sentence.
    const cause = causeOf(new DiscordError({ op: 'log in to Discord', cause: 'boom' }));

    expect(explainStartupFailure(cause)).toContain('log in to Discord');
  });
});
