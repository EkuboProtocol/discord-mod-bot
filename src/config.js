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
  
  // Roles to exclude from moderation
  excludedRoles: argv['excluded-roles']
    ? argv['excluded-roles'].split(',').map(r => r.trim())
    : process.env.EXCLUDED_ROLES
      ? process.env.EXCLUDED_ROLES.split(',').map(r => r.trim())
      : [],
  
  // OpenAI configuration
  openaiApiKey: argv['openai-api-key'] || process.env.OPENAI_API_KEY,
  
  // Logging configuration
  logLevel: argv['log-level'] || process.env.LOG_LEVEL || 'info'
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
