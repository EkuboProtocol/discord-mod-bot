'use strict';

const winston = require('winston');

let logger;

/**
 * Initialize the logger with given log level
 * @param {string} level - Log level (error, warn, info, debug)
 */
function initLogger(level = 'info') {
  logger = winston.createLogger({
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

// Create default logger if not initialized
if (!logger) {
  initLogger();
}

module.exports = {
  initLogger,
  logger: {
    error: (message, ...args) => logger.error(message, ...args),
    warn: (message, ...args) => logger.warn(message, ...args),
    info: (message, ...args) => logger.info(message, ...args),
    debug: (message, ...args) => logger.debug(message, ...args),
  }
};
