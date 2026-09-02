import { describe, expect, test } from 'bun:test';
import { Config, ConfigProvider, Effect, Option } from 'effect';
import { flagFor, parseLogLevel, splitList } from '../src/config';

/**
 * The precedence rule — CLI flag beats environment variable beats default — is
 * the part of configuration that used to be a hand-written ternary per setting,
 * and the part most likely to be wrong without anyone noticing. Here it is a
 * single provider composition, tested directly.
 */
function resolve<A>(
  config: Config.Config<A>,
  cli: Record<string, string>,
  env: Record<string, string>
): Promise<A> {
  const provider = ConfigProvider.orElse(
    ConfigProvider.fromEnvRecord(cli),
    ConfigProvider.fromEnvRecord(env)
  );

  return Effect.runPromise(
    config.pipe(Effect.provide(ConfigProvider.layer(provider)))
  );
}

describe('configuration precedence', () => {
  const model = Config.string('OPENAI_MODEL').pipe(Config.withDefault('gpt-3.5-turbo'));

  test('a flag overrides the environment', async () => {
    expect(await resolve(model, { OPENAI_MODEL: 'gpt-5' }, { OPENAI_MODEL: 'gpt-4o' })).toBe(
      'gpt-5'
    );
  });

  test('the environment is used when no flag was passed', async () => {
    expect(await resolve(model, {}, { OPENAI_MODEL: 'gpt-4o' })).toBe('gpt-4o');
  });

  test('an unset flag does not shadow the environment variable', async () => {
    // This is the bug the old yargs `default:` values caused: LOG_LEVEL and
    // CONTEXT_MESSAGE_COUNT could never take effect, because the flag was
    // always present with its default and won the `||` chain.
    const logLevel = Config.string('LOG_LEVEL').pipe(Config.withDefault('info'));

    expect(await resolve(logLevel, {}, { LOG_LEVEL: 'debug' })).toBe('debug');
  });

  test('the default applies when neither source has it', async () => {
    expect(await resolve(model, {}, {})).toBe('gpt-3.5-turbo');
  });

  test('a numeric setting of 0 is honoured, not treated as absent', async () => {
    // TIMEOUT_DURATION=0 means "disable timeouts"; a `||` chain would silently
    // read it as 5.
    const timeout = Config.int('TIMEOUT_DURATION').pipe(Config.withDefault(5));

    expect(await resolve(timeout, {}, { TIMEOUT_DURATION: '0' })).toBe(0);
  });

  test('an absent optional list stays absent rather than becoming empty', async () => {
    const channels = Config.string('MODERATED_CHANNELS').pipe(
      Config.map(splitList),
      Config.option
    );

    expect(await resolve(channels, {}, {})).toEqual(Option.none());
    expect(await resolve(channels, {}, { MODERATED_CHANNELS: 'a,b' })).toEqual(
      Option.some(['a', 'b'])
    );
  });

  test('a blank value counts as absent, not as an empty allow-list', async () => {
    // The README tells App Platform users to "leave blank to use defaults", and
    // an empty MODERATED_CHANNELS that decoded to `Some([])` would moderate
    // nothing at all — the opposite of the documented default.
    const channels = Config.string('MODERATED_CHANNELS').pipe(
      Config.map(splitList),
      Config.option
    );

    expect(await resolve(channels, {}, { MODERATED_CHANNELS: '' })).toEqual(Option.none());
  });
});

describe('splitList', () => {
  test('trims the spaces people leave after commas', () => {
    expect(splitList('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  test('drops empty entries from a trailing or doubled comma', () => {
    expect(splitList('a,,b,')).toEqual(['a', 'b']);
    expect(splitList('')).toEqual([]);
    expect(splitList('   ')).toEqual([]);
  });
});

describe('flagFor', () => {
  test('names the flag that sets a given environment variable', () => {
    // Used to turn a missing-config error into an actionable startup message.
    expect(flagFor('DISCORD_TOKEN')).toBe('--token');
    expect(flagFor('NOTIFICATION_CHANNEL_ID')).toBe('--notification-channel');
  });

  test('is null for settings that have no flag', () => {
    expect(flagFor('PRESENCE_INTERVAL_MS')).toBeNull();
  });
});

describe('parseLogLevel', () => {
  test('accepts the lowercase names the README and the live deploy spec use', () => {
    // Effect 4 spells its levels "Info"/"Warn". Rejecting "info" would turn a
    // redeploy of the existing LOG_LEVEL into a startup failure.
    expect(parseLogLevel('debug')).toBe('Debug');
    expect(parseLogLevel('info')).toBe('Info');
    expect(parseLogLevel('warn')).toBe('Warn');
    expect(parseLogLevel('error')).toBe('Error');
  });

  test("accepts Effect's own spelling too, and ignores surrounding space", () => {
    expect(parseLogLevel('Debug')).toBe('Debug');
    expect(parseLogLevel('  DEBUG  ')).toBe('Debug');
  });

  test('falls back to Info rather than failing on an unknown level', () => {
    expect(parseLogLevel('verbose')).toBe('Info');
    expect(parseLogLevel('')).toBe('Info');
  });
});
