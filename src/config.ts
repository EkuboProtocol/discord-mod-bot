import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  type LogLevel,
  Option,
  type Redacted
} from 'effect';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

// Bun loads .env automatically, so there is no dotenv call here.

/**
 * Every setting is named once, by its environment variable, and the CLI flag is
 * just another way to write it. Keeping the two in one table is what lets the
 * whole precedence rule (CLI > env > default) be a single `ConfigProvider`
 * composition below instead of one ternary chain per setting.
 */
const FLAGS = {
  DISCORD_TOKEN: { flag: 'token', alias: 't', description: 'Discord bot token' },
  DISCORD_SERVER_ID: { flag: 'server', alias: 's', description: 'Discord server ID' },
  MODERATED_CHANNELS: {
    flag: 'channels',
    alias: 'c',
    description: 'Comma-separated list of moderated channel IDs (default: all)'
  },
  EXCLUDED_ROLES: {
    flag: 'excluded-roles',
    alias: 'e',
    description: 'Comma-separated list of role IDs to exclude from moderation'
  },
  EXCLUDED_CHANNELS: {
    flag: 'excluded-channels',
    alias: 'x',
    description: 'Comma-separated list of channel IDs to exclude from moderation'
  },
  WELCOME_CHANNEL_ID: {
    flag: 'welcome-channel',
    alias: 'w',
    description: 'Channel ID of the welcome channel to exclude from moderation'
  },
  LOG_LEVEL: {
    flag: 'log-level',
    alias: 'l',
    description: 'Log level (Error, Warn, Info, Debug)'
  },
  OPENAI_API_KEY: { flag: 'openai-api-key', alias: 'k', description: 'OpenAI API key' },
  OPENAI_MODEL: { flag: 'openai-model', alias: 'm', description: 'OpenAI model to use' },
  NOTIFICATION_CHANNEL_ID: {
    flag: 'notification-channel',
    alias: 'n',
    description: 'Channel ID to send moderation notifications to'
  },
  CONTEXT_MESSAGE_COUNT: {
    flag: 'context-messages',
    description: 'Number of previous messages to include for context'
  },
  IGNORED_PHRASES: {
    flag: 'ignored-phrases',
    alias: 'i',
    description: "Comma-separated list of phrases to ignore (won't be sent to OpenAI)"
  },
  TIMEOUT_DURATION: {
    flag: 'timeout-duration',
    alias: 'd',
    description:
      'Duration in minutes to timeout users when their message is deleted (0 to disable)'
  }
} as const satisfies Record<string, { flag: string; alias?: string; description: string }>;

type EnvName = keyof typeof FLAGS;

/** The `--flag` a user would pass to set a given environment variable. */
export function flagFor(envName: string): string | null {
  const entry = (FLAGS as Record<string, { flag: string } | undefined>)[envName];
  return entry ? `--${entry.flag}` : null;
}

/**
 * Read argv into a `name -> value` record keyed by environment variable.
 *
 * No yargs `default:` values are declared, deliberately. A default here would
 * make the flag *always* present and so would shadow the environment variable
 * it is supposed to merely override; defaults belong on the `Config` values
 * below, which sit underneath both sources.
 */
export function parseCli(argv: ReadonlyArray<string>): Record<string, string> {
  let parser = yargs(hideBin(argv as string[])).help().alias('help', 'h');

  for (const [envName, spec] of Object.entries(FLAGS)) {
    parser = parser.option(spec.flag, {
      ...('alias' in spec ? { alias: spec.alias } : {}),
      description: `${spec.description} [env: ${envName}]`,
      type: 'string'
    }) as typeof parser;
  }

  const parsed = parser.parseSync() as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const [envName, spec] of Object.entries(FLAGS)) {
    const value = parsed[spec.flag];
    if (typeof value === 'string' || typeof value === 'number') {
      result[envName] = String(value);
    }
  }

  return result;
}

/** Split a comma-separated setting, trimming blanks the way a human writes them. */
export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/**
 * Accept the lowercase level names the README and the deployed App Platform
 * spec use, not just Effect's own capitalised spelling.
 *
 * `Config.logLevel` would reject `LOG_LEVEL=debug` outright, which would turn a
 * routine redeploy of the existing configuration into a startup failure.
 */
export function parseLogLevel(raw: string): LogLevel.LogLevel {
  const normalized = raw.trim().toLowerCase();
  const match = LOG_LEVELS.find(level => level.toLowerCase() === normalized);

  return match ?? 'Info';
}

const LOG_LEVELS = ['All', 'Fatal', 'Error', 'Warn', 'Info', 'Debug', 'Trace', 'None'] as const;

const listOf = (name: EnvName) => Config.string(name).pipe(Config.map(splitList));

const lowercaseListOf = (name: EnvName) =>
  Config.string(name).pipe(Config.map(raw => splitList(raw).map(item => item.toLowerCase())));

export interface PresenceConfig {
  readonly enabled: boolean;
  readonly apiBase: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

/**
 * Rich presence: protocol stats published as the bot's Discord status. Every
 * field defaults, so the feature needs no new deployment config.
 */
const presenceConfig: Config.Config<PresenceConfig> = Config.all({
  enabled: Config.boolean('PRESENCE_ENABLED').pipe(Config.withDefault(true)),
  apiBase: Config.string('EKUBO_API_BASE').pipe(
    Config.withDefault('https://prod-api.ekubo.org')
  ),
  intervalMs: Config.int('PRESENCE_INTERVAL_MS').pipe(Config.withDefault(300_000)),
  timeoutMs: Config.int('PRESENCE_TIMEOUT_MS').pipe(Config.withDefault(10_000))
});

/**
 * Channels excluded from moderation, with the welcome channel folded in.
 *
 * The welcome channel is its own setting only because it is the one exclusion
 * most servers want and would otherwise have to look up an ID for; downstream
 * there is no reason to distinguish it from any other exclusion.
 */
const excludedChannels = Config.all({
  explicit: listOf('EXCLUDED_CHANNELS').pipe(Config.withDefault<ReadonlyArray<string>>([])),
  welcome: Config.string('WELCOME_CHANNEL_ID').pipe(Config.option)
}).pipe(
  Config.map(({ explicit, welcome }) =>
    Option.match(welcome, {
      onNone: () => explicit,
      onSome: id => (explicit.includes(id) ? explicit : [...explicit, id])
    })
  )
);

const appConfig = Config.all({
  token: Config.redacted('DISCORD_TOKEN'),
  serverId: Config.string('DISCORD_SERVER_ID'),

  // `None` means "every channel", which is not the same as an empty allow-list.
  moderatedChannels: listOf('MODERATED_CHANNELS').pipe(Config.option),
  excludedChannels,
  excludedRoles: listOf('EXCLUDED_ROLES').pipe(Config.withDefault<ReadonlyArray<string>>([])),

  timeoutDuration: Config.int('TIMEOUT_DURATION').pipe(Config.withDefault(5)),

  openaiApiKey: Config.redacted('OPENAI_API_KEY'),
  openaiModel: Config.string('OPENAI_MODEL').pipe(Config.withDefault('gpt-3.5-turbo')),

  notificationChannelId: Config.string('NOTIFICATION_CHANNEL_ID').pipe(Config.option),

  ignoredPhrases: lowercaseListOf('IGNORED_PHRASES').pipe(
    Config.withDefault<ReadonlyArray<string>>(['gm'])
  ),
  contextMessageCount: Config.int('CONTEXT_MESSAGE_COUNT').pipe(Config.withDefault(5)),

  logLevel: Config.string('LOG_LEVEL').pipe(
    Config.map(parseLogLevel),
    Config.withDefault<LogLevel.LogLevel>('Info')
  ),
  presence: presenceConfig
});

export interface AppConfigShape {
  readonly token: Redacted.Redacted<string>;
  readonly serverId: string;
  readonly moderatedChannels: Option.Option<ReadonlyArray<string>>;
  readonly excludedChannels: ReadonlyArray<string>;
  readonly excludedRoles: ReadonlyArray<string>;
  readonly timeoutDuration: number;
  readonly openaiApiKey: Redacted.Redacted<string>;
  readonly openaiModel: string;
  readonly notificationChannelId: Option.Option<string>;
  readonly ignoredPhrases: ReadonlyArray<string>;
  readonly contextMessageCount: number;
  readonly logLevel: LogLevel.LogLevel;
  readonly presence: PresenceConfig;
}

/**
 * CLI arguments on top of the environment. `orElse` only falls through when the
 * first provider has no value for a path, so a flag that was not passed defers
 * to `.env`, and a setting absent from both lands on the `withDefault` baked
 * into each `Config`.
 */
export function makeConfigProvider(
  argv: ReadonlyArray<string> = process.argv
): ConfigProvider.ConfigProvider {
  return ConfigProvider.orElse(
    ConfigProvider.fromEnvRecord(parseCli(argv)),
    ConfigProvider.fromEnv()
  );
}

/**
 * The resolved configuration, as a service.
 *
 * Unlike the module-level object it replaces, nothing is validated at import
 * time: a missing token is a typed `ConfigError` in the startup effect, which
 * is why importing `src/ai.ts` in a unit test no longer requires a fake
 * `DISCORD_TOKEN` to be in scope first.
 */
export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  'discord-mod-bot/AppConfig'
) {
  static readonly layer = Layer.effect(
    AppConfig,
    appConfig.pipe(Effect.map(AppConfig.of))
  ).pipe(Layer.provide(ConfigProvider.layer(makeConfigProvider())));
}
