// Placeholder credentials for the few tests that build the real config.
//
// Unlike the version this replaces, nothing here is load-bearing for *imports*:
// configuration is resolved inside an Effect rather than at module scope, so
// importing `src/ai.ts` or `src/config.ts` no longer throws when the
// environment is empty. Only `config.test.ts`, which resolves the config on
// purpose, depends on these.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.DISCORD_SERVER_ID ??= 'test-server';
process.env.OPENAI_API_KEY ??= 'test-openai-key';
