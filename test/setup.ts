// `src/config.ts` validates and throws at import time, and `src/ai.ts` imports
// it for the OpenAI client. Any test that touches those modules therefore needs
// credentials present before the import graph is evaluated, which is why this
// runs as a preload rather than as a line inside a test file — ESM imports are
// hoisted, so assigning to process.env in the test body would happen too late.
//
// These are placeholders. No test in this suite makes a network call.
process.env.DISCORD_TOKEN ??= 'test-token';
process.env.DISCORD_SERVER_ID ??= 'test-server';
process.env.OPENAI_API_KEY ??= 'test-openai-key';
