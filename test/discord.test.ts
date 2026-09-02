import { describe, expect, test } from 'bun:test';
import { Cause, Effect, Exit, Layer, References } from 'effect';
import type { GuildMember, Message } from 'discord.js';
import { deleteIfPresent, getRoleNames } from '../src/discord';
import { DiscordError, isUnknownMessageError } from '../src/errors';

/** A stand-in for a GuildMember carrying just the role shape the helper reads. */
function memberWithRoles(...names: string[]): GuildMember {
  return { roles: { cache: names.map(name => ({ name })) } } as unknown as GuildMember;
}

/** Run an effect with logging silenced, so test output stays readable. */
const Silent = Layer.succeed(References.MinimumLogLevel, 'None');

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Silent)));
}

describe('getRoleNames', () => {
  test('drops the implicit @everyone role that every member carries', () => {
    expect(getRoleNames(memberWithRoles('@everyone', 'Moderator'))).toEqual(['Moderator']);
  });

  test('keeps multiple real roles in order', () => {
    expect(getRoleNames(memberWithRoles('@everyone', 'Mod', 'Core'))).toEqual(['Mod', 'Core']);
  });

  test('is empty for a member with only @everyone', () => {
    expect(getRoleNames(memberWithRoles('@everyone'))).toEqual([]);
  });

  test('tolerates a null member', () => {
    // The GuildMembers intent was dropped, so message.member is absent more
    // often than it used to be — this path is live, not theoretical.
    expect(getRoleNames(null)).toEqual([]);
    expect(getRoleNames(undefined)).toEqual([]);
  });

  test('tolerates a member whose roles were never populated', () => {
    expect(getRoleNames({} as unknown as GuildMember)).toEqual([]);
  });
});

describe('isUnknownMessageError', () => {
  test('recognises Discord error code 10008', () => {
    expect(isUnknownMessageError({ code: 10008 })).toBe(true);
  });

  test('does not match a different Discord error, e.g. missing permissions', () => {
    expect(isUnknownMessageError({ code: 50013 })).toBe(false);
  });

  test('does not match the code as a string', () => {
    expect(isUnknownMessageError({ code: '10008' })).toBe(false);
  });

  test('tolerates non-object throws', () => {
    expect(isUnknownMessageError(null)).toBe(false);
    expect(isUnknownMessageError(undefined)).toBe(false);
    expect(isUnknownMessageError('boom')).toBe(false);
    expect(isUnknownMessageError(new Error('boom'))).toBe(false);
  });
});

describe('deleteIfPresent', () => {
  test('reports true when the delete succeeds', async () => {
    let called = false;
    const message = {
      delete: async () => {
        called = true;
      }
    } as unknown as Message;

    expect(await run(deleteIfPresent(message, 'ctx'))).toBe(true);
    expect(called).toBe(true);
  });

  test('absorbs the "already deleted" race and reports false', async () => {
    // Another moderator or automod removing the message first is expected, not
    // exceptional — it must not take down the surrounding handler.
    const message = {
      delete: async () => {
        throw { code: 10008 };
      }
    } as unknown as Message;

    expect(await run(deleteIfPresent(message, 'ctx'))).toBe(false);
  });

  test('leaves any other failure in the error channel', async () => {
    const message = {
      delete: async () => {
        throw { code: 50013, message: 'Missing Permissions' };
      }
    } as unknown as Message;

    const exit = await Effect.runPromise(Effect.exit(deleteIfPresent(message, 'ctx')));

    expect(Exit.isFailure(exit)).toBe(true);

    const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    const error = reason && Cause.isFailReason(reason) ? reason.error : undefined;

    // The original error survives inside the tagged wrapper, rather than being
    // flattened into a message string.
    expect(error).toBeInstanceOf(DiscordError);
    expect((error as DiscordError).cause).toMatchObject({ code: 50013 });
    expect((error as DiscordError).message).toBe('ctx: [object Object]');
  });
});
