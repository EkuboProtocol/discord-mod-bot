import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events, PermissionsBitField, type Client } from 'discord.js';
import { Cause, Duration, Effect, Exit, Option, Redacted } from 'effect';
import {
  loginDiscord, validateDiscordPermissions, missingPermissions, requiredChannelPermissions, requiredGuildPermissions,
  type PermissionConfig
} from '../src/discord-startup';

import type { AppConfigShape } from '../src/config';

const config: PermissionConfig = {
  moderatedChannels: Option.none(), excludedChannels: [], excludedRoles: [],
  notificationChannelId: Option.some('reports'), timeoutDuration: 5, contextMessageCount: 10
};
const text = { id: 'general', type: ChannelType.GuildText, textBased: true, thread: false };

describe('Discord permission requirements', () => {
  test('requires bans and only requires timeouts when enabled', () => {
    expect(requiredGuildPermissions(config)).toEqual(['BanMembers', 'ModerateMembers']);
    expect(requiredGuildPermissions({ ...config, timeoutDuration: 0 })).toEqual(['BanMembers']);
  });
  test('checks reading, deletion and notice permissions in moderated channels', () => {
    expect(requiredChannelPermissions(text, config)).toEqual([
      'ViewChannel', 'ManageMessages', 'SendMessages', 'ReadMessageHistory'
    ]);
  });
  test('checks report embeds even in an excluded notification channel', () => {
    expect(requiredChannelPermissions({ ...text, id: 'reports' }, {
      ...config, excludedChannels: ['reports']
    })).toEqual(['ViewChannel', 'ReadMessageHistory', 'ManageMessages', 'SendMessages', 'EmbedLinks']);
  });
  test('purge still needs access to channels outside the automatic moderation scope', () => {
    expect(requiredChannelPermissions(text, {
      ...config, moderatedChannels: Option.some(['elsewhere'])
    })).toEqual(['ViewChannel', 'ReadMessageHistory', 'ManageMessages']);
  });
  test('exclusions need no permissions when report/purge buttons are disabled', () => {
    expect(requiredChannelPermissions(text, {
      ...config, excludedChannels: ['general'], notificationChannelId: Option.none()
    })).toEqual([]);
  });
  test('does not require history without context or report/purge buttons', () => {
    expect(requiredChannelPermissions(text, {
      ...config, contextMessageCount: 0, notificationChannelId: Option.none()
    })).toEqual(['ViewChannel', 'ManageMessages', 'SendMessages']);
  });
  test('threads need SendMessagesInThreads, not SendMessages', () => {
    expect(requiredChannelPermissions({ ...text, type: ChannelType.PublicThread, thread: true }, config))
      .toEqual(['ViewChannel', 'ManageMessages', 'SendMessagesInThreads', 'ReadMessageHistory']);
  });
  test('categories are not moderation targets', () => {
    expect(requiredChannelPermissions({ ...text, type: ChannelType.GuildCategory, textBased: false }, config))
      .toEqual([]);
  });
  test('reports exact missing effective permissions, including invisible channels', () => {
    expect(missingPermissions(new PermissionsBitField(['ViewChannel']), ['ViewChannel', 'ManageMessages']))
      .toEqual(['ManageMessages']);
    expect(missingPermissions(null, ['ViewChannel', 'SendMessages'])).toEqual(['ViewChannel', 'SendMessages']);
    expect(missingPermissions(new PermissionsBitField(['Administrator']), ['BanMembers', 'ManageMessages']))
      .toEqual([]);
  });
});

function fakeClient(login: () => Promise<string>) {
  const events = new EventEmitter();
  return Object.assign(events, { login });
}

describe('Discord startup lifecycle', () => {
  test('waits for clientReady even after login resolves and removes listeners', async () => {
    const client = fakeClient(async () => 'token');
    let completed = false;
    const result = Effect.runPromise(loginDiscord(client as unknown as Client, Redacted.make('test')))
      .then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(client.listenerCount('ready')).toBe(0);
    client.emit(Events.ClientReady);
    await result;
    expect(completed).toBe(true);
    expect(client.listenerCount(Events.ClientReady)).toBe(0);
    expect(client.listenerCount(Events.Error)).toBe(0);
  });
  test('login failure propagates and cleans up the ready listener', async () => {
    const client = fakeClient(async () => { throw new Error('invalid token'); });
    const exit = await Effect.runPromiseExit(loginDiscord(client as unknown as Client, Redacted.make('test')));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(client.listenerCount(Events.ClientReady)).toBe(0);
  });
  test('interruption cleans up listeners when Discord never becomes ready', async () => {
    const client = fakeClient(async () => 'token');
    const exit = await Effect.runPromiseExit(loginDiscord(client as unknown as Client, Redacted.make('test')).pipe(
      Effect.timeout(Duration.millis(5))
    ));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(client.listenerCount(Events.ClientReady)).toBe(0);
    expect(client.listenerCount(Events.Error)).toBe(0);
  });
});

function permissionFixture(guildPermissions: string[], channelPermissions: string[]) {
  const calls: string[] = [];
  const bits = (names: string[]) => new PermissionsBitField(
    names.map(name => PermissionsBitField.Flags[name as keyof typeof PermissionsBitField.Flags])
  );
  const me = { permissions: bits(guildPermissions), roles: { highest: {} } };
  const channel = {
    ...text, name: 'general', permissionsFor: () => bits(channelPermissions),
    isTextBased: () => true, isThread: () => false, isSendable: () => true
  };
  const guild = {
    id: 'server', name: 'Test server',
    roles: { cache: new Collection(), fetch: async () => { calls.push('roles'); } },
    channels: {
      cache: new Collection([['general', channel]]),
      fetch: async () => { calls.push('channels'); },
      fetchActiveThreads: async () => { calls.push('threads'); }
    },
    members: { fetchMe: async () => { calls.push('member'); return me; } }
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const settings = { ...config, serverId: 'server', notificationChannelId: Option.none() } as AppConfigShape;
  return { client, settings, calls };
}

describe('Discord runtime permission validation', () => {
  test('refreshes roles, channels, active threads and the bot member before passing', async () => {
    const f = permissionFixture(['BanMembers', 'ModerateMembers'],
      ['ViewChannel', 'ManageMessages', 'ReadMessageHistory', 'SendMessages']);
    await Effect.runPromise(validateDiscordPermissions(f.client, f.settings));
    expect(f.calls).toEqual(['roles', 'channels', 'threads', 'member']);
  });
  test('fails with all missing server and channel permissions in the error', async () => {
    const f = permissionFixture([], ['ViewChannel']);
    const exit = await Effect.runPromiseExit(validateDiscordPermissions(f.client, f.settings));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.pretty(exit.cause);
      expect(error).toContain('BanMembers, ModerateMembers');
      expect(error).toContain('#general (general): missing ManageMessages, SendMessages, ReadMessageHistory');
    }
  });
  test('fails for a configured report channel outside the configured server', async () => {
    const f = permissionFixture(['Administrator'], ['Administrator']);
    const exit = await Effect.runPromiseExit(validateDiscordPermissions(f.client, {
      ...f.settings, notificationChannelId: Option.some('wrong-channel')
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('Notification channel wrong-channel');
  });
  test('fails for a missing explicitly moderated channel', async () => {
    const f = permissionFixture(['Administrator'], ['Administrator']);
    const exit = await Effect.runPromiseExit(validateDiscordPermissions(f.client, {
      ...f.settings, moderatedChannels: Option.some(['missing'])
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('Moderated channel missing');
  });
});
