import {
  ChannelType, Events, PermissionsBitField,
  type Client, type Guild, type GuildBasedChannel, type GuildMember,
  type PermissionFlagsBits
} from 'discord.js';
import { Duration, Effect, Option, Redacted } from 'effect';
import type { AppConfigShape } from './config';
import { DiscordError } from './errors';

export type PermissionConfig = Pick<AppConfigShape,
  'moderatedChannels' | 'excludedChannels' | 'excludedRoles' |
  'notificationChannelId' | 'timeoutDuration' | 'contextMessageCount'>;
type PermissionName = keyof typeof PermissionFlagsBits;

export function requiredGuildPermissions(config: PermissionConfig): PermissionName[] {
  return config.timeoutDuration > 0 ? ['BanMembers', 'ModerateMembers'] : ['BanMembers'];
}

function isModerated(id: string, config: PermissionConfig): boolean {
  return !config.excludedChannels.includes(id) &&
    Option.match(config.moderatedChannels, {
      onNone: () => true,
      onSome: ids => ids.includes(id)
    });
}

export interface ChannelFacts {
  readonly id: string;
  readonly type: ChannelType;
  readonly textBased: boolean;
  readonly thread: boolean;
}

export function requiredChannelPermissions(
  channel: ChannelFacts, config: PermissionConfig
): PermissionName[] {
  const required = new Set<PermissionName>();
  if (channel.textBased && isModerated(channel.id, config)) {
    required.add('ViewChannel');
    required.add('ManageMessages');
    required.add(channel.thread ? 'SendMessagesInThreads' : 'SendMessages');
    if (config.contextMessageCount > 0) required.add('ReadMessageHistory');
  }
  // The report's purge button scans every regular text channel, even exclusions.
  if (Option.isSome(config.notificationChannelId) && channel.type === ChannelType.GuildText) {
    for (const name of ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'] as const) {
      required.add(name);
    }
  }
  if (Option.getOrNull(config.notificationChannelId) === channel.id) {
    required.add('ViewChannel');
    required.add(channel.thread ? 'SendMessagesInThreads' : 'SendMessages');
    required.add('EmbedLinks');
  }
  return [...required];
}

export function missingPermissions(
  permissions: Readonly<PermissionsBitField> | null, required: readonly PermissionName[]
): PermissionName[] {
  return required.filter(name => !permissions?.has(PermissionsBitField.Flags[name]));
}

function channelIssues(channel: GuildBasedChannel, me: GuildMember, config: PermissionConfig): string[] {
  const required = requiredChannelPermissions({
    id: channel.id, type: channel.type, textBased: channel.isTextBased(), thread: channel.isThread()
  }, config);
  const missing = missingPermissions(channel.permissionsFor(me), required);
  return missing.length ? [`#${channel.name} (${channel.id}): missing ${missing.join(', ')}`] : [];
}

function configuredChannelIssues(guild: Guild, config: PermissionConfig): string[] {
  const issues: string[] = [];
  for (const id of Option.getOrElse(config.moderatedChannels, () => [])) {
    const channel = guild.channels.cache.get(id);
    if (!channel?.isTextBased()) issues.push(`Moderated channel ${id} is missing or not message-capable`);
  }
  const reportId = Option.getOrNull(config.notificationChannelId);
  if (reportId !== null && !guild.channels.cache.get(reportId)?.isSendable()) {
    issues.push(`Notification channel ${reportId} is missing, outside this server, or not sendable`);
  }
  return issues;
}

/** Read-only validation: never send/delete messages or alter roles to probe access. */
export const validateDiscordPermissions = Effect.fn('validateDiscordPermissions')(
  function* (client: Client, config: AppConfigShape) {
    const guild = yield* Effect.tryPromise({
      try: () => client.guilds.fetch(config.serverId),
      catch: cause => new DiscordError({ op: `fetch configured server ${config.serverId}`, cause })
    });
    const me = yield* Effect.tryPromise({
      try: async () => {
        await guild.roles.fetch();
        await guild.channels.fetch();
        await guild.channels.fetchActiveThreads();
        // Explicitly selected archived threads are absent from the guild channel list.
        const ids = [...Option.getOrElse(config.moderatedChannels, () => []),
          ...Option.toArray(config.notificationChannelId)];
        for (const id of ids) await guild.channels.fetch(id);
        return guild.members.fetchMe({ force: true });
      },
      catch: cause => new DiscordError({ op: 'fetch Discord permission configuration', cause })
    });
    const missing = missingPermissions(me.permissions, requiredGuildPermissions(config));
    const issues = [
      ...configuredChannelIssues(guild, config),
      ...[...guild.channels.cache.values()].flatMap(channel => channelIssues(channel, me, config))
    ];
    if (missing.length) issues.unshift(`Server ${guild.name}: missing ${missing.join(', ')}`);
    if (me.communicationDisabledUntilTimestamp && me.communicationDisabledUntilTimestamp > Date.now()) {
      issues.push('The bot is currently timed out');
    }
    if (issues.length) {
      return yield* new DiscordError({
        op: 'Discord startup permission check failed',
        cause: new Error(issues.join('\n'))
      });
    }
    // Permission bits cannot override member hierarchy or owner/administrator immunity.
    const higher = guild.roles.cache.filter(role =>
      role.id !== guild.id && !role.managed && !config.excludedRoles.includes(role.id) &&
      role.comparePositionTo(me.roles.highest) >= 0
    );
    if (higher.size) {
      yield* Effect.logWarning(
        `Bot role cannot ban/timeout members with these non-excluded roles: ${higher.map(r => r.name).join(', ')}. ` +
        'Move the bot role above intended targets or exclude those roles.'
      );
    }
    yield* Effect.logInfo(`Discord startup permission check passed for server ${guild.name}`);
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError(cause => new DiscordError({ op: 'validate Discord startup permissions', cause }))
);

/** Wait for clientReady before inspecting permissions or installing moderation handlers. */
export function loginDiscord(client: Client, token: AppConfigShape['token']) {
  return Effect.callback<void, DiscordError>(resume => {
    const cleanup = () => {
      client.off(Events.ClientReady, ready);
      client.off(Events.Error, failed);
    };
    const ready = () => { cleanup(); resume(Effect.void); };
    const failed = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(new DiscordError({ op: 'log in to Discord', cause })));
    };
    client.once(Events.ClientReady, ready);
    client.once(Events.Error, failed);
    void client.login(Redacted.value(token)).catch(failed);
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.mapError(cause => cause instanceof DiscordError
      ? cause
      : new DiscordError({ op: 'wait for Discord clientReady', cause }))
  );
}
