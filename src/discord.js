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
    
    // Log which channels are excluded from moderation
    if (config.excludedChannels && config.excludedChannels.length > 0) {
      logger.info(`Excluded channels: ${config.excludedChannels.join(', ')}`);
      
      // Try to log the names of the excluded channels for better readability
      const excludedChannelNames = config.excludedChannels
        .map(id => {
          const channel = targetGuild.channels.cache.get(id);
          return channel ? `#${channel.name} (${id})` : id;
        })
        .join(', ');
      
      logger.info(`Excluded channels by name: ${excludedChannelNames}`);
    }
    
    logger.info(`Excluded roles: ${config.excludedRoles.length ? config.excludedRoles.join(', ') : 'None'}`);
    
    // Verify notification channel if configured
    if (config.notificationChannelId) {
      const notificationChannel = client.channels.cache.get(config.notificationChannelId);
      if (!notificationChannel) {
        logger.warn(`Could not find the specified notification channel with ID: ${config.notificationChannelId}`);
        logger.info('Available channels:');
        targetGuild.channels.cache.forEach(channel => {
          if (channel.type === 0) { // 0 is GUILD_TEXT
            logger.info(`- ${channel.name} (${channel.id})`);
          }
        });
      } else {
        logger.info(`Using notification channel: #${notificationChannel.name}`);
      }
    }
    
    logger.info(`Using OpenAI model: ${config.openaiModel}`);
    logger.info(`Using ${config.contextMessageCount} previous messages for context`);
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
    
    // Check if this channel is in the excluded channels list
    if (config.excludedChannels && config.excludedChannels.includes(message.channel.id)) {
      logger.debug(`Skipping message in #${message.channel.name} (${message.channel.id}) - channel excluded from moderation`);
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
      
      // Check if the message content is in the ignored phrases list
      const messageContentLower = message.content.trim().toLowerCase();
      if (config.ignoredPhrases.includes(messageContentLower)) {
        logger.debug(`Skipping message "${messageContentLower}" - in ignored phrases list`);
        return;
      }
      
      // Fetch previous messages for context
      let previousMessages = [];
      if (config.contextMessageCount > 0) {
        try {
          const messages = await message.channel.messages.fetch({ 
            limit: config.contextMessageCount,
            before: message.id 
          });
          
          previousMessages = messages.map(msg => ({
            author: msg.author.tag,
            content: msg.content,
            timestamp: msg.createdAt
          })).reverse(); // Oldest first
          
          logger.debug(`Fetched ${previousMessages.length} previous messages for context`);
        } catch (error) {
          logger.warn('Could not fetch previous messages for context:', error);
        }
      }
      
      // Send to AI for checking with context
      const result = await checkMessageFn(message.content, previousMessages);
      
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
        
        // Send detailed notification to the designated notification channel
        if (config.notificationChannelId) {
          try {
            const notificationChannel = client.channels.cache.get(config.notificationChannelId);
            if (notificationChannel) {
              await notificationChannel.send({
                embeds: [{
                  title: 'Moderation Action: Message Removed',
                  color: 0xFF0000, // Red
                  description: `A message has been removed for violating server rules.`,
                  fields: [
                    {
                      name: 'User',
                      value: `${message.author.tag} (${message.author.id})`,
                      inline: true
                    },
                    {
                      name: 'Channel',
                      value: `#${message.channel.name} (${message.channel.id})`,
                      inline: true
                    },
                    {
                      name: 'Timestamp',
                      value: new Date().toISOString(),
                      inline: true
                    },
                    {
                      name: 'Reason',
                      value: result.reason || 'Not specified'
                    },
                    {
                      name: 'Message Content',
                      value: message.content.length > 1024 ? message.content.substring(0, 1021) + '...' : message.content
                    }
                  ],
                  timestamp: new Date(),
                  footer: {
                    text: 'Discord Moderation Bot'
                  }
                }]
              });
            }
          } catch (error) {
            logger.error('Failed to send notification to the notification channel:', error);
          }
        }
        
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
