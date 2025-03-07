'use strict';

const { logger } = require('./logger');

/**
 * Sets up the Discord bot with all necessary event handlers
 * @param {Client} client - Discord.js Client instance
 * @param {Object} config - Bot configuration object
 * @param {Function} checkMessageFn - Function to check messages for spam/scam content
 */
function setupBot(client, config, checkMessageFn) {
  // Once the client is ready, log that we're online
  client.once('ready', () => {
    logger.info(`Logged in as ${client.user.tag}`);
    
    // Verify we're connected to the specified server
    const targetGuild = client.guilds.cache.get(config.serverId);
    if (!targetGuild) {
      logger.error(`Could not find the specified server with ID: ${config.serverId}`);
      logger.info('Available servers:');
      client.guilds.cache.forEach(guild => {
        logger.info(`- ${guild.name} (${guild.id})`);
      });
      process.exit(1);
    }
    
    logger.info(`Connected to server: ${targetGuild.name}`);
    
    // Log which channels are being moderated
    if (!config.moderatedChannels) {
      logger.info('Moderating all channels in the server');
    } else {
      logger.info(`Moderating specific channels: ${config.moderatedChannels.join(', ')}`);
    }
    
    logger.info(`Excluded roles: ${config.excludedRoles.length ? config.excludedRoles.join(', ') : 'None'}`);
  });

  // Handle incoming messages
  client.on('messageCreate', async (message) => {
    // Ignore bot messages to prevent potential loops
    if (message.author.bot) return;
    
    // Ensure the message is from the target server
    if (message.guild.id !== config.serverId) return;
    
    // Check if we should moderate this channel
    if (config.moderatedChannels && !config.moderatedChannels.includes(message.channel.id)) {
      return;
    }
    
    // Check if the user has an excluded role
    const hasExcludedRole = message.member && message.member.roles.cache.some(
      role => config.excludedRoles.includes(role.id)
    );
    
    if (hasExcludedRole) {
      logger.debug(`Skipping message from ${message.author.tag} - has excluded role`);
      return;
    }
    
    try {
      // Log the message for debugging
      logger.debug(`Processing message from ${message.author.tag} in #${message.channel.name}: ${message.content}`);
      
      // Send to AI for checking
      const result = await checkMessageFn(message.content);
      
      if (result.isSpamOrScam) {
        logger.info(`Detected spam/scam from ${message.author.tag} in #${message.channel.name}`);
        logger.info(`Message: ${message.content}`);
        logger.info(`Reason: ${result.reason}`);
        
        // Delete the message
        await message.delete();
        
        // Notify the channel that a message was removed
        const notificationMsg = await message.channel.send(
          `⚠️ Removed a message from ${message.author} that violated server rules. Reason: ${result.reason}`
        );
        
        // Delete the notification after a few seconds to keep the channel clean
        setTimeout(() => {
          notificationMsg.delete().catch(e => logger.warn('Could not delete notification message:', e));
        }, 10000);
        
        // TODO: Implement ban logic for repeat offenders if required
      }
    } catch (error) {
      logger.error(`Error processing message from ${message.author.tag}:`, error);
    }
  });

  // Handle errors
  client.on('error', (error) => {
    logger.error('Discord client error:', error);
  });

  client.on('shardError', (error) => {
    logger.error('Discord websocket error:', error);
  });
}

module.exports = { setupBot };
