import { Cause, Effect, Layer, Logger, type LogLevel, Predicate, References } from 'effect';
import winston from 'winston';
import { AppConfig } from './config';

/** Effect's level vocabulary is wider than winston's; collapse it onto the four. */
export function winstonLevelFor(level: LogLevel.LogLevel): 'error' | 'warn' | 'info' | 'debug' {
  switch (level) {
    case 'Fatal':
    case 'Error':
      return 'error';
    case 'Warn':
      return 'warn';
    case 'Info':
      return 'info';
    default:
      return 'debug';
  }
}

/**
 * Render the values passed to `Effect.logInfo(...)` as one line.
 *
 * Effect hands the logger whatever the call site passed — usually a string,
 * sometimes a string followed by an error or an object — so this mirrors
 * `console.log`'s behaviour rather than picking only the first argument.
 */
export function renderMessage(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];

  return parts
    .map(part => {
      if (Predicate.isString(part)) return part;
      if (part instanceof Error) return part.stack ?? part.message;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');
}

function createWinston(level: string): winston.Logger {
  const line = (info: winston.Logform.TransformableInfo): string =>
    `${info.timestamp} [${info.level}]: ${info.message}`;

  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true })
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.printf(line))
      }),
      // Documented in the README as logs/error.log and logs/combined.log.
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' })
    ]
  });
}

/**
 * Route Effect's structured logging into winston, at the configured level.
 *
 * Replacing the default logger rather than exporting a `logger` object is what
 * removes the mutable module-level `winstonLogger` and the `initLogger()` call
 * that had to run before any import could safely log: a fiber cannot log
 * without this layer, so there is no uninitialised window to get wrong.
 */
export const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const backend = createWinston(winstonLevelFor(config.logLevel));

    const logger = Logger.make<unknown, void>(({ cause, logLevel, message }) => {
      // A logged failure carries its cause separately from the message; drop it
      // in as a second line rather than losing the stack.
      const causeText = cause.reasons.length === 0 ? '' : `\n${Cause.pretty(cause)}`;
      backend.log(winstonLevelFor(logLevel), `${renderMessage(message)}${causeText}`);
    });

    return Layer.mergeAll(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, config.logLevel)
    );
  })
);
