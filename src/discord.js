'use strict';

const { logger } = require('./logger');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Return a list of user-friendly role names for a guild member
 * @param {import('discord.js').GuildMember | null | undefined} member
 * @returns {string[]}
 */
function getRoleNames(member) {
  if (!member || !member.roles) {
    return [];
  }

  return member.roles.cache
    .filter(role => role.name !== '@everyone')
    .map(role => role.name);
}

/**
 * Returns true when Discord reports the target message no longer exists.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnknownMessageError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 10008);
}

/**
 * Delete a Discord message, ignoring the "already deleted" race.
 * @param {import('discord.js').Message} message
 * @param {string} context
 * @returns {Promise<boolean>}
 */
async function deleteMessageIfPresent(message, context) {
  try {
    await message.delete();
    return true;
  } catch (error) {
    if (isUnknownMessageError(error)) {
      logger.info(`${context}: message was already deleted`);
      return false;
    }

    throw error;
  }
}

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

  // Handle button interactions for moderation actions
  client.on('interactionCreate', async (interaction) => {
    // Only handle button interactions
    if (!interaction.isButton()) return;
    
    try {
      // Check if the button is one of our moderation buttons
      if (interaction.customId.startsWith('ban:') || 
          interaction.customId.startsWith('delete:') || 
          interaction.customId.startsWith('unban:')) {
        // Extract user and guild IDs from the customId
        const parts = interaction.customId.split(':');
        const action = parts[0];
        const userId = parts[1];
        const guildId = parts[2];
        
        // Get the guild and verify permissions
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          return await interaction.reply({ 
            content: '❌ Error: Cannot find the server.',
            ephemeral: true
          });
        }
        
        // Check if the user clicking the button has permission
        if (!interaction.member.permissions.has('BanMembers')) {
          return await interaction.reply({ 
            content: '❌ You do not have permission to perform this action.',
            ephemeral: true 
          });
        }
        
        // Defer the reply to give us time to process
        await interaction.deferReply({ ephemeral: true });
        
        if (action === 'ban') {
          try {
            // Ban the user
            await guild.members.ban(userId, { 
              reason: `Banned by ${interaction.user.tag} through moderation bot` 
            });
            
            await interaction.editReply({ 
              content: `✅ Successfully banned user <@${userId}>.`,
              ephemeral: true 
            });
            
            // Edit the original message to update the status
            if (interaction.message.editable) {
              // Create a new embed based on the original one
              const originalEmbed = interaction.message.embeds[0];
              const newEmbed = {
                ...originalEmbed.data,
                title: 'Moderation Action: User Banned',
                fields: [
                  ...originalEmbed.fields,
                  {
                    name: 'Ban Action',
                    value: `User was banned by ${interaction.user.tag}`
                  }
                ]
              };
              
              // Create unban button for the updated message
              const unbanButton = new ButtonBuilder()
                .setCustomId(`unban:${userId}:${guildId}`)
                .setLabel('Unban User')
                .setStyle(ButtonStyle.Success);
                
              const actionRow = new ActionRowBuilder()
                .addComponents(unbanButton);
              
              // Update message with unban button
              await interaction.message.edit({ 
                embeds: [newEmbed],
                components: [actionRow] 
              });
            }
          } catch (error) {
            logger.error(`Failed to ban user ${userId}:`, error);
            await interaction.editReply({ 
              content: `❌ Failed to ban user: ${error.message}`,
              ephemeral: true 
            });
          }
        } else if (action === 'unban') {
          try {
            // Unban the user
            await guild.members.unban(userId, { 
              reason: `Unbanned by ${interaction.user.tag} through moderation bot` 
            });
            
            await interaction.editReply({ 
              content: `✅ Successfully unbanned user <@${userId}>.`,
              ephemeral: true 
            });
            
            // Edit the original message to update the status
            if (interaction.message.editable) {
              // Create a new embed based on the original one
              const originalEmbed = interaction.message.embeds[0];
              const newEmbed = {
                ...originalEmbed.data,
                title: 'Moderation Action: User Unbanned',
                fields: [
                  ...originalEmbed.fields,
                  {
                    name: 'Unban Action',
                    value: `User was unbanned by ${interaction.user.tag}`
                  }
                ]
              };
              
              // Create ban button (in case they need to be re-banned)
              const banButton = new ButtonBuilder()
                .setCustomId(`ban:${userId}:${guildId}`)
                .setLabel('Ban User')
                .setStyle(ButtonStyle.Danger);
                
              const deleteMessagesButton = new ButtonBuilder()
                .setCustomId(`delete:${userId}:${guildId}`)
                .setLabel('Delete Recent Messages')
                .setStyle(ButtonStyle.Secondary);
                
              const actionRow = new ActionRowBuilder()
                .addComponents(banButton, deleteMessagesButton);
              
              // Update message with new buttons
              await interaction.message.edit({ 
                embeds: [newEmbed],
                components: [actionRow] 
              });
            }
          } catch (error) {
            logger.error(`Failed to unban user ${userId}:`, error);
            await interaction.editReply({ 
              content: `❌ Failed to unban user: ${error.message}`,
              ephemeral: true 
            });
          }
        } else if (action === 'delete') {
          try {
            // Delete recent messages from this user across all channels
            let deletedCount = 0;
            
            // Get all text channels
            const textChannels = guild.channels.cache.filter(c => c.type === 0);
            
            for (const [, channel] of textChannels) {
              try {
                // Get recent messages in this channel
                const messages = await channel.messages.fetch({ limit: 100 });
                
                // Filter messages from this user that are less than 14 days old
                const userMessages = messages.filter(m => 
                  m.author.id === userId && 
                  (Date.now() - m.createdTimestamp) < 1209600000 // 14 days in milliseconds
                );
                
                if (userMessages.size > 0) {
                  // Bulk delete if possible
                  if (userMessages.size > 1) {
                    await channel.bulkDelete(userMessages);
                  } else {
                    // Delete single message
                    await userMessages.first().delete();
                  }
                  
                  deletedCount += userMessages.size;
                }
              } catch (e) {
                // Log error but continue with other channels
                logger.warn(`Failed to delete messages in channel ${channel.name}:`, e);
              }
            }
            
            await interaction.editReply({ 
              content: `✅ Deleted ${deletedCount} messages from user <@${userId}>.`,
              ephemeral: true 
            });
            
            // Update original message
            if (interaction.message.editable) {
              const originalEmbed = interaction.message.embeds[0];
              const newEmbed = {
                ...originalEmbed.data,
                fields: [
                  ...originalEmbed.fields,
                  {
                    name: 'Messages Deleted',
                    value: `${deletedCount} messages were deleted by ${interaction.user.tag}`
                  }
                ]
              };
              
              // Preserve existing buttons
              await interaction.message.edit({ 
                embeds: [newEmbed],
                components: interaction.message.components 
              });
            }
          } catch (error) {
            logger.error(`Failed to delete messages from user ${userId}:`, error);
            await interaction.editReply({ 
              content: `❌ Failed to delete messages: ${error.message}`,
              ephemeral: true 
            });
          }
        }
      }
    } catch (error) {
      logger.error('Error handling button interaction:', error);
      try {
        // Try to reply if we haven't already
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ An error occurred while processing this action.',
            ephemeral: true
          });
        } else if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({
            content: '❌ An error occurred while processing this action.',
            ephemeral: true
          });
        }
      } catch (e) {
        logger.error('Error responding to interaction error:', e);
      }
    }
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
            roles: getRoleNames(msg.member),
            content: msg.content,
            timestamp: msg.createdAt
          })).reverse(); // Oldest first
          
          logger.debug(`Fetched ${previousMessages.length} previous messages for context`);
        } catch (error) {
          logger.warn('Could not fetch previous messages for context:', error);
        }
      }
      
      // Send to AI for checking with context
      const authorRoles = getRoleNames(message.member);
      const result = await checkMessageFn(
        message.content,
        previousMessages,
        {
          author: message.author.tag,
          roles: authorRoles
        }
      );
      
      if (result.isSpamOrScam) {
        logger.info(`Detected spam/scam from ${message.author.tag} in #${message.channel.name}`);
        logger.info(`Message: ${message.content}`);
        logger.info(`Severity: ${result.severity || 'medium'}`);
        logger.info(`Reason: ${result.reason}`);
        
        // Delete the message. Another moderator or automod may have removed it first.
        await deleteMessageIfPresent(message, `Could not delete offending message from ${message.author.tag}`);
        
        // Handle different severity levels
        let timeoutApplied = false;
        let timeoutDuration = config.timeoutDuration;
        let userBanned = false;
        
        // Determine action based on severity
        const severity = result.severity || 'medium'; // Default to medium if not specified
        
        if (severity === 'high') {
          // High severity - Ban the user immediately
          try {
            // Ban the user with a reason
            await message.guild.members.ban(message.author.id, {
              reason: `Automated ban: ${result.reason || 'Posted high-severity spam/scam content'}`
            });
            userBanned = true;
            logger.info(`Applied automatic ban to ${message.author.tag} - high severity spam/scam`);
          } catch (error) {
            logger.error(`Failed to ban user ${message.author.tag}:`, error);
            userBanned = false;
            
            // Fall back to timeout if ban fails
            if (timeoutDuration > 0 && message.member) {
              try {
                // Convert minutes to milliseconds
                const timeoutMs = timeoutDuration * 60 * 1000;
                
                await message.member.timeout(
                  timeoutMs, 
                  `Automated timeout (fallback from ban): ${result.reason || 'Posted high-severity spam/scam content'}`
                );
                
                timeoutApplied = true;
                logger.info(`Applied ${timeoutDuration} minute timeout to ${message.author.tag} (fallback from failed ban)`);
              } catch (fallbackError) {
                logger.error(`Failed to timeout user ${message.author.tag} as ban fallback:`, fallbackError);
                timeoutApplied = false;
              }
            }
          }
        } else if (severity === 'medium') {
          // Medium severity - Apply timeout (default behavior)
          if (timeoutDuration > 0 && message.member) {
            try {
              // Convert minutes to milliseconds
              const timeoutMs = timeoutDuration * 60 * 1000;
              
              await message.member.timeout(
                timeoutMs, 
                `Automated timeout: ${result.reason || 'Posted medium-severity spam/scam content'}`
              );
              
              timeoutApplied = true;
              logger.info(`Applied ${timeoutDuration} minute timeout to ${message.author.tag}`);
            } catch (error) {
              logger.error(`Failed to timeout user ${message.author.tag}:`, error);
              timeoutApplied = false;
            }
          }
        } else if (severity === 'low') {
          // Low severity - Just delete the message, no timeout
          logger.info(`Message deleted, no timeout applied for low-severity content from ${message.author.tag}`);
        }
        
        // Notify the channel that a message was removed and user was timed out or banned
        // Only allow mentions for users tagged in the offending message.
        const mentionedUserIds = [...message.mentions.users.keys()]
          .filter(id => id !== message.author.id);

        let notificationText = `⚠️ Removed a message from ${message.author} that violated server rules. Reason: ${result.reason}`;
        
        if (userBanned) {
          notificationText = `🚫 Banned user ${message.author} for posting high-severity spam/scam. Reason: ${result.reason}`;
        } else if (timeoutApplied) {
          notificationText += ` User has been timed out for ${timeoutDuration} minute${timeoutDuration !== 1 ? 's' : ''}.`;
        }

        if (mentionedUserIds.length > 0) {
          const taggedUsers = mentionedUserIds.map(id => `<@${id}>`).join(' ');
          notificationText += ` Heads up to tagged user${mentionedUserIds.length === 1 ? '' : 's'}: ${taggedUsers}`;
        }
        
        const notificationMsg = await message.channel.send({
          content: notificationText,
          allowedMentions: {
            parse: [],
            users: mentionedUserIds
          }
        });
        
        // Delete the notification after a few seconds to keep the channel clean
        setTimeout(() => {
          deleteMessageIfPresent(notificationMsg, 'Could not delete notification message')
            .catch(error => logger.warn('Could not delete notification message:', error));
        }, 10000);
        
        // Send detailed notification to the designated notification channel
        if (config.notificationChannelId) {
          try {
            const notificationChannel = client.channels.cache.get(config.notificationChannelId);
            if (notificationChannel) {
              // Create clickable user mention
              const userMention = `<@${message.author.id}>`;
              
              // Create clickable channel mention
              const channelMention = `<#${message.channel.id}>`;
              
              const fields = [
                {
                  name: 'User',
                  value: `${userMention} (${message.author.tag}, ${message.author.id})`,
                  inline: true
                },
                {
                  name: 'Channel',
                  value: `${channelMention} (${message.channel.id})`,
                  inline: true
                },
                {
                  name: 'Severity',
                  value: severity.charAt(0).toUpperCase() + severity.slice(1), // Capitalize first letter
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
              ];
              
              // Add action information
              if (userBanned) {
                fields.push({
                  name: 'Action Taken',
                  value: `User was automatically banned (high-severity spam/scam)`
                });
              } else if (timeoutApplied) {
                fields.push({
                  name: 'Action Taken',
                  value: `User timed out for ${timeoutDuration} minute${timeoutDuration !== 1 ? 's' : ''}`
                });
              } else {
                fields.push({
                  name: 'Action Taken',
                  value: 'Message deleted (no timeout applied)'
                });
              }
              
              // Create action buttons based on severity and actions taken
              const actionRow = new ActionRowBuilder();
              
              if (userBanned) {
                // For banned users, add unban button
                const unbanButton = new ButtonBuilder()
                  .setCustomId(`unban:${message.author.id}:${message.guild.id}`)
                  .setLabel('Unban User')
                  .setStyle(ButtonStyle.Success);
                  
                const deleteMessagesButton = new ButtonBuilder()
                  .setCustomId(`delete:${message.author.id}:${message.guild.id}`)
                  .setLabel('Delete Recent Messages')
                  .setStyle(ButtonStyle.Secondary);
                  
                actionRow.addComponents(unbanButton, deleteMessagesButton);
              } else {
                // Standard buttons for non-banned users
                const banButton = new ButtonBuilder()
                  .setCustomId(`ban:${message.author.id}:${message.guild.id}`)
                  .setLabel('Ban User')
                  .setStyle(ButtonStyle.Danger);
                
                const deleteMessagesButton = new ButtonBuilder()
                  .setCustomId(`delete:${message.author.id}:${message.guild.id}`)
                  .setLabel('Delete Recent Messages')
                  .setStyle(ButtonStyle.Secondary);
                  
                actionRow.addComponents(banButton, deleteMessagesButton);
              }
              
              // Determine title and color based on actions taken
              let title, color;
              
              if (userBanned) {
                title = 'Moderation Action: User Automatically Banned';
                color = 0x992D22; // Dark red
              } else if (timeoutApplied) {
                title = 'Moderation Action: Message Removed & User Timed Out';
                color = 0xE74C3C; // Lighter red
              } else {
                title = 'Moderation Action: Message Removed';
                color = 0xF1C40F; // Yellow/amber for lower severity
              }
              
              await notificationChannel.send({
                embeds: [{
                  title: title,
                  color: color,
                  description: `A message has been removed for violating server rules.`,
                  fields: fields,
                  timestamp: new Date(),
                  footer: {
                    text: 'Discord Moderation Bot'
                  }
                }],
                components: [actionRow],
                allowedMentions: { parse: [] }
              });
            }
          } catch (error) {
            logger.error('Failed to send notification to the notification channel:', error);
          }
        }
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
