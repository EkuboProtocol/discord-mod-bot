import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type TextChannel
} from 'discord.js';
import { type Config, Duration, Effect, type ManagedRuntime, Option } from 'effect';
import { AppConfig, type AppConfigShape } from './config';
import { DiscordError, isUnknownMessageError } from './errors';
import { Moderator, type ContextMessage } from './ai';
import {
  actionFor,
  channelNotice,
  parseButtonTarget,
  reportEmbed,
  severityOf,
  skipReason,
  type Action,
  type ButtonTarget,
  type Outcome
} from './moderation';
import { presenceLoop } from './presence';

/** How long the in-channel notice stays up before it is cleaned away. */
const NOTICE_LIFETIME = Duration.seconds(10);

/** Discord refuses to bulk-delete anything older than 14 days. */
const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Wrap a discord.js promise, tagging it with the operation for the log line.
 *
 * Every REST call in this file goes through here, so a failure is always a
 * typed `DiscordError` in the error channel rather than a rejection that some
 * enclosing `try` may or may not have been placed to catch.
 */
function discord<A>(op: string, thunk: () => Promise<A>): Effect.Effect<A, DiscordError> {
  return Effect.tryPromise({ try: thunk, catch: cause => new DiscordError({ op, cause }) });
}

/** Channel name for logging; DMs and other channel kinds have no name. */
function channelName(message: Message): string {
  const channel = message.channel as { name?: string };
  return channel.name ?? message.channel.id;
}

/** Return a list of user-friendly role names for a guild member. */
export function getRoleNames(member: GuildMember | null | undefined): string[] {
  if (!member || !member.roles) {
    return [];
  }

  return member.roles.cache.filter(role => role.name !== '@everyone').map(role => role.name);
}

function getRoleIds(member: GuildMember | null | undefined): string[] {
  if (!member || !member.roles) {
    return [];
  }

  return member.roles.cache.map(role => role.id);
}

/**
 * Delete a message, treating "it is already gone" as success-adjacent.
 *
 * Returns whether this call is the one that removed it; any other failure stays
 * in the error channel for the caller to decide about.
 */
export function deleteIfPresent(
  message: Message,
  context: string
): Effect.Effect<boolean, DiscordError> {
  return discord(context, () => message.delete()).pipe(
    Effect.as(true),
    Effect.catchIf(
      error => isUnknownMessageError(error.cause),
      () => Effect.logInfo(`${context}: message was already deleted`).pipe(Effect.as(false))
    )
  );
}

/** A channel we can post moderation notices into. */
function asSendable(channel: unknown): GuildTextBasedChannel | null {
  const candidate = channel as GuildTextBasedChannel | null;
  return candidate && candidate.isTextBased?.() && !candidate.isDMBased?.() ? candidate : null;
}

// ---------------------------------------------------------------------------
// Moderation actions
// ---------------------------------------------------------------------------

function timeoutMember(
  member: GuildMember,
  minutes: number,
  reason: string
): Effect.Effect<Outcome, DiscordError> {
  return discord(`timeout ${member.user.tag}`, () =>
    member.timeout(minutes * 60 * 1000, reason)
  ).pipe(
    Effect.tap(() => Effect.logInfo(`Applied ${minutes} minute timeout to ${member.user.tag}`)),
    Effect.as<Outcome>({ _tag: 'TimedOut', minutes })
  );
}

/**
 * Carry out the action the severity called for, reporting what actually landed.
 *
 * This never fails: a ban the bot lacks the role hierarchy to perform, or a
 * timeout on a member who has since left, still leaves the message deleted and
 * still has to be reported accurately, so each failure degrades one rung rather
 * than aborting the handler.
 */
export function applyAction(
  message: Message<true>,
  action: Action,
  reason: string
): Effect.Effect<Outcome> {
  const deletedOnly = Effect.succeed<Outcome>({ _tag: 'DeletedOnly' });

  const timeout = (minutes: number | null, why: string) =>
    minutes === null || message.member === null
      ? deletedOnly
      : timeoutMember(message.member, minutes, why).pipe(
          Effect.catch(error =>
            Effect.logError(`Failed to timeout user ${message.author.tag}`, error).pipe(
              Effect.andThen(deletedOnly)
            )
          )
        );

  switch (action._tag) {
    case 'BanThenTimeout':
      return discord(`ban ${message.author.tag}`, () =>
        message.guild.members.ban(message.author.id, { reason: `Automated ban: ${reason}` })
      ).pipe(
        Effect.tap(() =>
          Effect.logInfo(
            `Applied automatic ban to ${message.author.tag} - high severity spam/scam`
          )
        ),
        Effect.as<Outcome>({ _tag: 'Banned' }),
        Effect.catch(error =>
          Effect.logError(`Failed to ban user ${message.author.tag}`, error).pipe(
            Effect.andThen(
              timeout(
                action.fallbackTimeoutMinutes,
                `Automated timeout (fallback from ban): ${reason}`
              )
            )
          )
        )
      );

    case 'Timeout':
      return timeout(action.minutes, `Automated timeout: ${reason}`);

    case 'DeleteOnly':
      return Effect.logInfo(
        `Message deleted, no timeout applied for low-severity content from ${message.author.tag}`
      ).pipe(Effect.andThen(deletedOnly));
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Post the short in-channel notice and schedule its own removal.
 *
 * The cleanup is a *daemon* fiber: it outlives this handler by design, so it
 * must not be interrupted when the handler's scope closes ten seconds early.
 */
function postChannelNotice(message: Message<true>, outcome: Outcome, reason: string) {
  return Effect.gen(function* () {
    const channel = asSendable(message.channel);
    if (!channel) {
      return;
    }

    // Only ping users the offending message itself tagged, never @everyone and
    // never the author; `parse: []` is what stops a crafted message from
    // turning the bot into a mass-mention vector.
    const mentionedUserIds = [...message.mentions.users.keys()].filter(
      id => id !== message.author.id
    );

    const notice = yield* discord('post channel notice', () =>
      channel.send({
        content: channelNotice({
          authorMention: `${message.author}`,
          reason,
          outcome,
          mentionedUserIds
        }),
        allowedMentions: { parse: [], users: mentionedUserIds }
      })
    );

    yield* Effect.sleep(NOTICE_LIFETIME).pipe(
      Effect.andThen(deleteIfPresent(notice, 'Could not delete notification message')),
      Effect.catch(error =>
        Effect.logWarning('Could not delete notification message', error)
      ),
      Effect.forkDetach
    );
  });
}

function moderationButtons(target: Omit<ButtonTarget, 'action'>, banned: boolean) {
  const button = (action: string, label: string, style: ButtonStyle) =>
    new ButtonBuilder()
      .setCustomId(`${action}:${target.userId}:${target.guildId}`)
      .setLabel(label)
      .setStyle(style);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    banned
      ? button('unban', 'Unban User', ButtonStyle.Success)
      : button('ban', 'Ban User', ButtonStyle.Danger),
    button('delete', 'Delete Recent Messages', ButtonStyle.Secondary)
  );
}

/** Send the detailed report, with its moderator buttons, to the audit channel. */
function postReport(
  client: Client,
  channelId: string,
  message: Message<true>,
  outcome: Outcome,
  severity: ReturnType<typeof severityOf>,
  reason: string
) {
  return Effect.gen(function* () {
    const channel = asSendable(client.channels.cache.get(channelId));
    if (!channel) {
      return;
    }

    yield* discord('send moderation report', () =>
      channel.send({
        embeds: [
          reportEmbed({
            authorId: message.author.id,
            authorTag: message.author.tag,
            channelId: message.channel.id,
            severity,
            reason,
            content: message.content,
            outcome,
            at: new Date()
          })
        ],
        components: [
          moderationButtons(
            { userId: message.author.id, guildId: message.guild.id },
            outcome._tag === 'Banned'
          )
        ],
        allowedMentions: { parse: [] }
      })
    );
  });
}

// ---------------------------------------------------------------------------
// messageCreate
// ---------------------------------------------------------------------------

/** The preceding messages sent to the model as conversational context. */
function fetchContext(
  message: Message<true>,
  count: number
): Effect.Effect<ReadonlyArray<ContextMessage>> {
  if (count <= 0) {
    return Effect.succeed([]);
  }

  return discord('fetch context messages', () =>
    message.channel.messages.fetch({ limit: count, before: message.id })
  ).pipe(
    Effect.map(fetched =>
      fetched
        .map(msg => ({
          author: msg.author.tag,
          roles: getRoleNames(msg.member),
          content: msg.content
        }))
        .reverse()
    ),
    Effect.tap(context => Effect.logDebug(`Fetched ${context.length} previous messages`)),
    Effect.catch(error =>
      Effect.logWarning('Could not fetch previous messages for context', error).pipe(
        Effect.as<ReadonlyArray<ContextMessage>>([])
      )
    )
  );
}

const handleMessage = (client: Client, message: Message) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;

    const skip = skipReason(
      {
        authorIsBot: message.author.bot,
        guildId: message.guildId,
        channelId: message.channel.id,
        roleIds: getRoleIds(message.member),
        content: message.content
      },
      config
    );

    if (skip !== null) {
      // `other-guild` and `bot-author` fire on essentially every event in a
      // busy server, so they stay below the debug line the operator reads.
      if (skip !== 'bot-author' && skip !== 'other-guild') {
        yield* Effect.logDebug(`Skipping message from ${message.author.tag}: ${skip}`);
      }
      return;
    }

    // `skipReason` established the guild, which is what `Message<true>` means.
    const guildMessage = message as Message<true>;

    yield* Effect.logDebug(
      `Processing message from ${message.author.tag} in #${channelName(message)}`
    );

    const moderator = yield* Moderator;
    const verdict = yield* moderator.check({
      content: message.content,
      previousMessages: yield* fetchContext(guildMessage, config.contextMessageCount),
      meta: { author: message.author.tag, roles: getRoleNames(message.member) }
    });

    if (!verdict.isSpamOrScam) {
      return;
    }

    const severity = severityOf(verdict.severity);
    const reason = verdict.reason ?? 'Detected as spam/scam by moderation system';

    yield* Effect.logInfo(
      `Detected ${severity} spam/scam from ${message.author.tag} in ` +
        `#${channelName(message)}: ${reason}`
    );

    yield* deleteIfPresent(
      guildMessage,
      `Could not delete offending message from ${message.author.tag}`
    );

    const outcome = yield* applyAction(
      guildMessage,
      actionFor(severity, config.timeoutDuration),
      reason
    );

    yield* postChannelNotice(guildMessage, outcome, reason);

    yield* Option.match(config.notificationChannelId, {
      onNone: () => Effect.void,
      onSome: channelId =>
        postReport(client, channelId, guildMessage, outcome, severity, reason)
    });
  }).pipe(
    Effect.catchCause(cause =>
      Effect.logError(`Error processing message from ${message.author.tag}`, cause)
    ),
    Effect.withLogSpan('messageCreate')
  );

// ---------------------------------------------------------------------------
// interactionCreate
// ---------------------------------------------------------------------------

/**
 * Append a field to the report embed and swap in the buttons that now apply.
 *
 * The report is the audit trail, so it is edited in place rather than replied
 * to: a moderator scrolling back sees the final state, not a thread of updates.
 */
function updateReport(
  interaction: ButtonInteraction,
  field: { name: string; value: string },
  options: { title?: string; components?: unknown }
) {
  if (!interaction.message.editable) {
    return Effect.void;
  }

  const original = interaction.message.embeds[0];
  const embed = {
    ...original?.data,
    ...(options.title ? { title: options.title } : {}),
    fields: [...(original?.fields ?? []), field]
  };

  return discord('edit moderation report', () =>
    interaction.message.edit({
      embeds: [embed],
      components: (options.components ?? interaction.message.components) as never
    })
  ).pipe(Effect.catch(error => Effect.logWarning('Could not update report embed', error)));
}

function banUser(interaction: ButtonInteraction, guild: Guild, target: ButtonTarget): Effect.Effect<string, DiscordError> {
  const by = interaction.user.tag;

  return discord('ban via button', () =>
    guild.members.ban(target.userId, { reason: `Banned by ${by} through moderation bot` })
  ).pipe(
    Effect.andThen(
      updateReport(
        interaction,
        { name: 'Ban Action', value: `User was banned by ${by}` },
        {
          title: 'Moderation Action: User Banned',
          components: [moderationButtons(target, true)]
        }
      )
    ),
    Effect.as(`✅ Successfully banned user <@${target.userId}>.`)
  );
}

function unbanUser(interaction: ButtonInteraction, guild: Guild, target: ButtonTarget): Effect.Effect<string, DiscordError> {
  const by = interaction.user.tag;

  return discord('unban via button', () =>
    guild.members.unban(target.userId, `Unbanned by ${by} through moderation bot`)
  ).pipe(
    Effect.andThen(
      updateReport(
        interaction,
        { name: 'Unban Action', value: `User was unbanned by ${by}` },
        {
          title: 'Moderation Action: User Unbanned',
          components: [moderationButtons(target, false)]
        }
      )
    ),
    Effect.as(`✅ Successfully unbanned user <@${target.userId}>.`)
  );
}

/** Recent messages from one author in one channel, within the bulk-delete window. */
function purgeChannel(channel: TextChannel, userId: string): Effect.Effect<number> {
  return discord(`purge #${channel.name}`, () => channel.messages.fetch({ limit: 100 })).pipe(
    Effect.map(messages =>
      messages.filter(
        m => m.author.id === userId && Date.now() - m.createdTimestamp < BULK_DELETE_WINDOW_MS
      )
    ),
    Effect.flatMap(mine =>
      mine.size === 0
        ? Effect.succeed(0)
        : discord(`bulk delete in #${channel.name}`, () =>
            channel.bulkDelete(mine)
          ).pipe(Effect.as(mine.size))
    ),
    // One channel the bot cannot read must not abort the sweep of the others.
    Effect.catch(error =>
      Effect.logWarning(`Failed to delete messages in channel ${channel.name}`, error).pipe(
        Effect.as(0)
      )
    )
  );
}

function deleteRecentMessages(
  interaction: ButtonInteraction,
  guild: Guild,
  target: ButtonTarget
) {
  const channels = [
    ...guild.channels.cache.filter((c): c is TextChannel => c.type === 0).values()
  ];

  return Effect.forEach(channels, channel => purgeChannel(channel, target.userId)).pipe(
    Effect.map(counts => counts.reduce((sum, n) => sum + n, 0)),
    Effect.tap(deleted =>
      updateReport(
        interaction,
        {
          name: 'Messages Deleted',
          value: `${deleted} messages were deleted by ${interaction.user.tag}`
        },
        {}
      )
    ),
    Effect.map(deleted => `✅ Deleted ${deleted} messages from user <@${target.userId}>.`)
  );
}

const ephemeral = (interaction: ButtonInteraction, content: string) =>
  discord('reply to interaction', () =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral })
  );

/**
 * A moderator pressed one of the report's buttons.
 *
 * The permission check is not decorative: the buttons are visible to everyone
 * who can see the notification channel, so authority comes from the clicker's
 * own `BanMembers` permission and never from the fact that the bot posted the
 * button.
 */
const handleInteraction = (client: Client, interaction: Interaction) =>
  Effect.gen(function* () {
    if (!interaction.isButton()) {
      return;
    }

    const target = parseButtonTarget(interaction.customId);
    if (target === null) {
      return;
    }

    const guild = client.guilds.cache.get(target.guildId);
    if (!guild) {
      return yield* ephemeral(interaction, '❌ Error: Cannot find the server.');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers)) {
      return yield* ephemeral(
        interaction,
        '❌ You do not have permission to perform this action.'
      );
    }

    yield* discord('defer interaction reply', () =>
      interaction.deferReply({ flags: MessageFlags.Ephemeral })
    );

    const run = {
      ban: banUser,
      unban: unbanUser,
      delete: deleteRecentMessages
    }[target.action];

    const content = yield* run(interaction, guild, target).pipe(
      Effect.catch(error =>
        Effect.logError(`Button action "${target.action}" failed`, error).pipe(
          Effect.as(`❌ Failed to ${target.action}: ${error.message}`)
        )
      )
    );

    yield* discord('edit interaction reply', () => interaction.editReply({ content }));
  }).pipe(
    Effect.catchCause(cause => Effect.logError('Error handling button interaction', cause)),
    Effect.withLogSpan('interactionCreate')
  );

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function describeSetup(client: Client, config: AppConfigShape) {
  return Effect.gen(function* () {
    yield* Effect.logInfo(`Logged in as ${client.user?.tag}`);

    const guild = client.guilds.cache.get(config.serverId);
    if (!guild) {
      const available = client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ');
      return yield* new DiscordError({
        op: 'locate configured server',
        cause: new Error(
          `Could not find server ${config.serverId}. Available: ${available || 'none'}`
        )
      });
    }

    yield* Effect.logInfo(`Connected to server: ${guild.name}`);
    yield* Effect.logInfo(
      Option.match(config.moderatedChannels, {
        onNone: () => 'Moderating all channels in the server',
        onSome: ids => `Moderating specific channels: ${ids.join(', ')}`
      })
    );
    yield* Effect.logInfo(
      `Excluded channels: ${config.excludedChannels.join(', ') || 'None'}`
    );
    yield* Effect.logInfo(`Excluded roles: ${config.excludedRoles.join(', ') || 'None'}`);
    yield* Effect.logInfo(`Using OpenAI model: ${config.openaiModel}`);
    yield* Effect.logInfo(
      `Using ${config.contextMessageCount} previous messages for context`
    );

    yield* Option.match(config.notificationChannelId, {
      onNone: () => Effect.void,
      onSome: id => {
        const channel = asSendable(client.channels.cache.get(id));
        return channel
          ? Effect.logInfo(`Using notification channel: #${channel.name}`)
          : Effect.logWarning(`Notification channel ${id} is missing or not a server channel`);
      }
    });
  });
}

/**
 * Attach the bot's event handlers to a client.
 *
 * discord.js is callback-driven, so this is the one adapter between its world
 * and Effect's: each event forks its handler on the application runtime, which
 * is what gives every handler the config, the moderator and the logger without
 * any of them being a module-level singleton.
 */
export const setupBot = (
  client: Client,
  runtime: ManagedRuntime.ManagedRuntime<AppConfig | Moderator, Config.ConfigError>
): Effect.Effect<void, never, AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const fork = (effect: Effect.Effect<void, never, AppConfig | Moderator>) => {
      runtime.runFork(effect);
    };

    client.once('ready', () =>
      fork(
        describeSetup(client, config).pipe(
          Effect.catch(error =>
            Effect.logError(error.message).pipe(
              Effect.andThen(Effect.sync(() => process.exit(1)))
            )
          ),
          Effect.andThen(presenceLoop(client, config.presence))
        )
      )
    );

    client.on('messageCreate', message => fork(handleMessage(client, message)));
    client.on('interactionCreate', interaction => fork(handleInteraction(client, interaction)));

    client.on('error', error => fork(Effect.logError('Discord client error', error)));
    client.on('shardError', error => fork(Effect.logError('Discord websocket error', error)));
  });
