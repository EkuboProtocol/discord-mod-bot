'use strict';

const dotenv = require('dotenv');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Load environment variables from .env file
dotenv.config();

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('token', {
    alias: 't',
    description: 'Discord bot token',
    type: 'string'
  })
  .option('server', {
    alias: 's',
    description: 'Discord server ID',
    type: 'string'
  })
  .option('channels', {
    alias: 'c',
    description: 'Comma-separated list of moderated channel IDs (default: all)',
    type: 'string'
  })
  .option('excluded-roles', {
    alias: 'e',
    description: 'Comma-separated list of role IDs to exclude from moderation',
    type: 'string'
  })
  .option('excluded-channels', {
    alias: 'x',
    description: 'Comma-separated list of channel IDs to exclude from moderation',
    type: 'string'
  })
  .option('welcome-channel', {
    alias: 'w',
    description: 'Channel ID of the welcome channel to exclude from moderation',
    type: 'string'
  })
  .option('log-level', {
    alias: 'l',
    description: 'Log level (error, warn, info, debug)',
    type: 'string',
    default: 'info'
  })
  .option('openai-api-key', {
    alias: 'k',
    description: 'OpenAI API key',
    type: 'string'
  })
  .option('openai-model', {
    alias: 'm',
    description: 'OpenAI model to use',
    type: 'string'
  })
  .option('notification-channel', {
    alias: 'n',
    description: 'Channel ID to send moderation notifications to',
    type: 'string'
  })
  .option('context-messages', {
    description: 'Number of previous messages to include for context',
    type: 'number',
    default: 5
  })
  .option('ignored-phrases', {
    alias: 'i',
    description: 'Comma-separated list of phrases to ignore (won\'t be sent to OpenAI)',
    type: 'string'
  })
  .option('timeout-duration', {
    alias: 'd',
    description: 'Duration in minutes to timeout users when their message is deleted (0 to disable)',
    type: 'number'
  })
  .help()
  .alias('help', 'h')
  .argv;

// Configuration with priority: CLI args > Environment variables > Defaults
const config = {
  // Discord configuration
  token: argv.token || process.env.DISCORD_TOKEN,
  serverId: argv.server || process.env.DISCORD_SERVER_ID,
  
  // Channels to moderate (undefined means all channels)
  moderatedChannels: argv.channels 
    ? argv.channels.split(',').map(c => c.trim()) 
    : process.env.MODERATED_CHANNELS 
      ? process.env.MODERATED_CHANNELS.split(',').map(c => c.trim())
      : undefined,
  
  // Channels to exclude from moderation
  excludedChannels: (() => {
    // Start with the excluded channels from CLI/env
    const excluded = argv['excluded-channels']
      ? argv['excluded-channels'].split(',').map(c => c.trim())
      : process.env.EXCLUDED_CHANNELS
        ? process.env.EXCLUDED_CHANNELS.split(',').map(c => c.trim())
        : [];
    
    // Add welcome channel if specified
    const welcomeChannel = argv['welcome-channel'] || process.env.WELCOME_CHANNEL_ID;
    if (welcomeChannel && !excluded.includes(welcomeChannel)) {
      excluded.push(welcomeChannel);
    }
    
    return excluded;
  })(),
  
  // Roles to exclude from moderation
  excludedRoles: argv['excluded-roles']
    ? argv['excluded-roles'].split(',').map(r => r.trim())
    : process.env.EXCLUDED_ROLES
      ? process.env.EXCLUDED_ROLES.split(',').map(r => r.trim())
      : [],
  
  // Timeout configuration
  timeoutDuration: argv['timeout-duration'] !== undefined
    ? argv['timeout-duration']
    : process.env.TIMEOUT_DURATION !== undefined
      ? parseInt(process.env.TIMEOUT_DURATION, 10)
      : 5, // Default to 5 minutes if not specified
  
  // OpenAI configuration
  openaiApiKey: argv['openai-api-key'] || process.env.OPENAI_API_KEY,
  openaiModel: argv['openai-model'] || process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
  
  // Notification channel for moderation actions
  notificationChannelId: argv['notification-channel'] || process.env.NOTIFICATION_CHANNEL_ID,
  
  // Message filtering
  ignoredPhrases: argv['ignored-phrases']
    ? argv['ignored-phrases'].split(',').map(p => p.trim().toLowerCase())
    : process.env.IGNORED_PHRASES
      ? process.env.IGNORED_PHRASES.split(',').map(p => p.trim().toLowerCase())
      : ['gm'], // Default to ignoring "gm" if not specified
  
  // Context for AI analysis
  contextMessageCount: argv['context-messages'] || parseInt(process.env.CONTEXT_MESSAGE_COUNT || '5', 10),
  
  // Logging configuration
  logLevel: argv['log-level'] || process.env.LOG_LEVEL || 'info',

  // Rich presence: protocol stats published as the bot's Discord status.
  // Every field defaults, so the feature needs no new deployment config.
  presence: {
    enabled: (process.env.PRESENCE_ENABLED || 'true').toLowerCase() !== 'false',
    apiBase: process.env.EKUBO_API_BASE || 'https://prod-api.ekubo.org',
    intervalMs: parseInt(process.env.PRESENCE_INTERVAL_MS || '300000', 10),
    timeoutMs: parseInt(process.env.PRESENCE_TIMEOUT_MS || '10000', 10)
  }
};

// Validation
if (!config.token) {
  throw new Error('Discord token is required. Set via DISCORD_TOKEN env variable or --token flag.');
}

if (!config.serverId) {
  throw new Error('Discord server ID is required. Set via DISCORD_SERVER_ID env variable or --server flag.');
}

if (!config.openaiApiKey) {
  throw new Error('OpenAI API key is required. Set via OPENAI_API_KEY env variable or --openai-api-key flag.');
}

module.exports = { config };
