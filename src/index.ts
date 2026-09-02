#!/usr/bin/env bun

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from 'effect';
import { Moderator } from './ai';
import { AppConfig } from './config';
import { setupBot } from './discord';
import { DiscordError, explainStartupFailure } from './errors';
import { LoggerLive } from './logging';

/**
 * The bot's services: configuration, the winston-backed logger, and the
 * moderation model. Everything else in the program is a plain function of
 * these, which is what lets the whole app be exercised with a substituted
 * layer rather than a substituted global.
 */
const AppLayer = Layer.mergeAll(AppConfig.layer, Moderator.layer).pipe(
  Layer.provideMerge(LoggerLive.pipe(Layer.provide(AppConfig.layer)))
);

/**
 * The gateway connection, tied to the program's scope.
 *
 * Shutting down disposes the runtime below, which runs this release step, so
 * SIGTERM closes the websocket rather than dropping it — without a
 * `client.destroy()` duplicated into each signal handler.
 */
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

/**
 * `ManagedRuntime` is the bridge to discord.js's callback API: it builds the
 * layer once and hands every event handler a way to run an Effect with the
 * services already in scope.
 */
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

  const client = yield* gatewayClient;
  yield* setupBot(client, runtime);

  yield* Effect.tryPromise({
    try: () => client.login(Redacted.value(config.token)),
    catch: cause => new DiscordError({ op: 'log in to Discord', cause })
  });
  yield* Effect.logInfo('Discord bot logged in successfully');

  // The bot is event-driven from here; hold the scope open until interrupted.
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

/** Disposing the runtime runs the release step that closes the gateway. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`Received ${signal}, shutting down...`);
    void runtime.dispose().finally(() => process.exit(0));
  });
}

// Anything that escapes a fiber is logged and survived, not fatal: a single bad
// event must not take moderation offline for the whole server.
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled Rejection:', reason);
});
