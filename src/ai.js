'use strict';

const OpenAI = require('openai');
const { logger } = require('./logger');
const { config } = require('./config');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

function formatRolesForDisplay(roles) {
  if (!roles || roles.length === 0) {
    return 'None';
  }
  return roles.join(', ');
}

/**
 * Check if a message contains spam or scam content, considering channel context
 * 
 * @param {string} messageContent - The content of the message to check
 * @param {Array<Object>} previousMessages - Previous messages in the channel for context
 * @param {Object|null} currentMessageMeta - Metadata about the current message author (roles, etc.)
 * @returns {Promise<Object>} - Result object with isSpamOrScam flag, severity level, and reason
 */
async function checkMessage(messageContent, previousMessages = [], currentMessageMeta = null) {
  try {
    // Log full message being analyzed
    logger.debug('=========== BEGIN MESSAGE ANALYSIS ===========');
    logger.debug('Message being analyzed:');
    logger.debug(messageContent);
    logger.debug('=============================================');
    
    // Format previous messages for context
    const formattedPreviousMessages = previousMessages.map(msg => {
      const rolesText = formatRolesForDisplay(msg.roles);
      return `[${msg.author} | Roles: ${rolesText}]: ${msg.content}`;
    }).join('\n');
    
    // Log previous messages if available
    if (previousMessages.length > 0) {
      logger.debug('Previous messages for context:');
      logger.debug(formattedPreviousMessages);
      logger.debug('=============================================');
    } else {
      logger.debug('No previous messages for context');
      logger.debug('=============================================');
    }
    
    const contextText = previousMessages.length > 0 
      ? `\nHere are the previous ${previousMessages.length} messages in this channel for context:\n${formattedPreviousMessages}\n\nNow analyze this new message:`
      : '';
    
    const systemPrompt = `
    You are a Discord moderation assistant that identifies spam and scam messages.
    
    Analyze the message and determine if it matches any of these spam/scam patterns, and classify them by severity:
    
    HIGH SEVERITY (Obvious scams that require immediate action):
    1. Messages containing suspicious links or asking users to open tickets 
    2. Messages containing Discord invite links to other servers
    3. Phishing attempts asking for personal information or wallet addresses
    4. ANY impersonation of staff or team members (including usernames/nicknames containing "team" or "support")
    5. Messages that clearly aim to steal funds or personal information
    6. Messages asking users to DM for support instead of using public channels
    7. Generic job-seeking messages that appear to be copy-pasted
    
    MEDIUM SEVERITY (Spam that is problematic but not clearly malicious):
    1. Messages asking who to contact for unspecified business/partnerships
    2. Messages promising rewards, giveaways, or airdrops that seem suspicious
    3. Unsolicited help or support messages that seem generic
    
    LOW SEVERITY (Borderline spam that should be removed but user doesn't need timeout):
    1. Excessive self-promotion 
    2. Slightly off-topic messages that could be disruptive
    3. Messages that are questionable but might be legitimate
    4. Messages that are merely annoying rather than harmful
    
    Consider the context of the conversation when making your determination:
    - If the message is a normal part of an ongoing conversation, it's likely not spam
    - If the message suddenly changes topic in a suspicious way, it might be spam
    - Consider whether the user has been participating normally in the conversation
    
    For each message, you will only respond with a JSON object in this format:
    {
      "isSpamOrScam": true/false,
      "severity": "high" or "medium" or "low" or null (if not spam/scam),
      "reason": "brief explanation if it's spam/scam" or null if not
    }
    
    Be precise but not overly strict. Normal community discussions, technical questions, 
    and legitimate support requests should not be flagged.
    `;
    
    // Log system prompt
    logger.debug('System prompt:');
    logger.debug(systemPrompt);
    logger.debug('=============================================');
    
    // Construct messages array for the API call
    const messages = [
      {
        role: "system",
        content: systemPrompt
      }
    ];
    
    // Add context as a separate message if available
    if (contextText) {
      messages.push({
        role: "user",
        content: contextText
      });
    }
    
    let currentMessageContent = messageContent;
    if (currentMessageMeta) {
      const rolesText = formatRolesForDisplay(currentMessageMeta.roles);
      const authorLine = currentMessageMeta.author
        ? `Author: ${currentMessageMeta.author}\n`
        : '';
      currentMessageContent = `${authorLine}Roles: ${rolesText}\nMessage: ${messageContent}`;
    }
    
    // Add the current message to analyze
    messages.push({
      role: "user",
      content: currentMessageContent
    });
    
    // Log full messages array being sent to OpenAI
    logger.debug('Complete messages array being sent to OpenAI:');
    logger.debug(JSON.stringify(messages, null, 2));
    logger.debug('=============================================');
    
    // Log request parameters
    logger.debug('OpenAI request parameters:');
    logger.debug(`Model: ${config.openaiModel}`);
    logger.debug(`Temperature: 0.1`);
    logger.debug(`Max tokens: 200`); // Increased token limit for more detailed response
    logger.debug(`Response format: JSON object`);
    logger.debug('=============================================');
    
    // Send request to OpenAI
    logger.debug('Sending request to OpenAI...');
    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: messages,
      temperature: 0.1,
      max_tokens: 200, // Increased for more detailed responses
      response_format: { type: "json_object" }
    });
    
    // Log full OpenAI response
    logger.debug('Full OpenAI API response:');
    logger.debug(JSON.stringify(response, null, 2));
    logger.debug('=============================================');
    
    // Extract the content from the response
    const aiResponse = response.choices[0].message.content;
    
    // Log the extracted content
    logger.debug('Extracted AI response content:');
    logger.debug(aiResponse);
    logger.debug('=============================================');
    
    // Parse the JSON response
    const result = JSON.parse(aiResponse);
    
    // Log the parsed result
    logger.debug('Parsed AI analysis result:');
    logger.debug(JSON.stringify(result, null, 2));
    logger.debug('============ END MESSAGE ANALYSIS ===========');
    
    return {
      isSpamOrScam: result.isSpamOrScam,
      severity: result.severity || null,
      reason: result.reason || "Detected as spam/scam by moderation system"
    };
  } catch (error) {
    logger.error('Error checking message with AI:', error);
    logger.debug('============ MESSAGE ANALYSIS FAILED ===========');
    
    // Return a safe default to ensure bot continues functioning
    return {
      isSpamOrScam: false,
      severity: null,
      reason: null
    };
  }
}

module.exports = { checkMessage };
