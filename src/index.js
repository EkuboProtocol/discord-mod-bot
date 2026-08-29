#!/usr/bin/env node
'use strict';

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { config } = require('./config');
const { setupBot } = require('./discord');
const { checkMessage } = require('./ai');
const { initLogger, logger } = require('./logger');

// Initialize logger
initLogger(config.logLevel);

logger.info('Starting Discord Moderation Bot');
logger.info(`Bot Configuration: ${JSON.stringify({
  server: config.serverId,
  moderatedChannels: config.moderatedChannels ? config.moderatedChannels : 'all',
  excludedRoles: config.excludedRoles
}, null, 2)}`);

// Create a new Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// Set up the bot with event handlers
setupBot(client, config, checkMessage);

// Login to Discord
client.login(config.token)
  .then(() => {
    logger.info('Discord bot logged in successfully');
  })
  .catch(error => {
    logger.error('Error logging into Discord:', error);
    process.exit(1);
  });

// Handle process termination
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Keep the process running despite errors
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Keep the process running despite errors
});
