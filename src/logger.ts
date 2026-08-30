import winston from 'winston';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// Assigned by the initLogger() call at the bottom of this module.
let winstonLogger!: winston.Logger;

/**
 * Initialize the logger with given log level
 */
export function initLogger(level: string = 'info'): void {
  winstonLogger = winston.createLogger({
    level: level,
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.printf(info => {
        return `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}${info.stack ? '\n' + info.stack : ''}`;
      })
    ),
    transports: [
      // Console output
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(info => {
            return `${info.timestamp} [${info.level}]: ${info.message}${info.stack ? '\n' + info.stack : ''}`;
          })
        )
      }),
      // File output
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error'
      }),
      new winston.transports.File({
        filename: 'logs/combined.log'
      })
    ]
  });
}

// Create default logger so importing this module is always safe
initLogger();

export const logger: Logger = {
  error: (message, ...args) => { winstonLogger.error(message, ...args); },
  warn: (message, ...args) => { winstonLogger.warn(message, ...args); },
  info: (message, ...args) => { winstonLogger.info(message, ...args); },
  debug: (message, ...args) => { winstonLogger.debug(message, ...args); },
};
