#!/usr/bin/env bun

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Effect, Exit, Layer, ManagedRuntime, Option } from 'effect';
import { Moderator } from './ai';
import { AppConfig } from './config';
import { describeSetup, setupBot } from './discord';
import { explainStartupFailure } from './errors';
import { loginDiscord, validateDiscordPermissions } from './discord-startup';
import { LoggerLive } from './logging';

const AppLayer = Layer.mergeAll(AppConfig.layer, Moderator.layer).pipe(
  Layer.provideMerge(LoggerLive.pipe(Layer.provide(AppConfig.layer)))
);

const gatewayClient = Effect.acquireRelease(
  Effect.sync(
    () =>
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Message, Partials.Channel]
      })
  ),
  client => Effect.promise(() => client.destroy())
);

const runtime = ManagedRuntime.make(AppLayer);

const program = Effect.gen(function* () {
  const config = yield* AppConfig;

  yield* Effect.logInfo('Starting Discord Moderation Bot');
  yield* Effect.logInfo(
    `Server ${config.serverId}, channels: ` +
      Option.match(config.moderatedChannels, {
        onNone: () => 'all',
        onSome: ids => ids.join(', ')
      })
  );

  const moderator = yield* Moderator;
  yield* Effect.logInfo(`Checking OpenAI configuration for model ${config.openaiModel}`);
  yield* moderator.startupCheck;
  yield* Effect.logInfo(`OpenAI startup check passed for model ${config.openaiModel}`);

  const client = yield* gatewayClient;
  yield* loginDiscord(client, config.token);
  yield* validateDiscordPermissions(client, config);
  yield* describeSetup(client, config);
  yield* setupBot(client, runtime);
  yield* Effect.logInfo('Discord bot startup checks passed; moderation is active');

  yield* Effect.never;
});

const fiber = runtime.runFork(Effect.scoped(program));

fiber.addObserver(exit => {
  if (Exit.isFailure(exit) && exit.cause.reasons.some(r => r._tag !== 'Interrupt')) {
    console.error(explainStartupFailure(exit.cause));
    void runtime.dispose().finally(() => process.exit(1));
    return;
  }
  void runtime.dispose().finally(() => process.exit(0));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`Received ${signal}, shutting down...`);
    void runtime.dispose().finally(() => process.exit(0));
  });
}

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled Rejection:', reason);
});
