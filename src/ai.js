'use strict';

const OpenAI = require('openai');
const { logger } = require('./logger');
const { config } = require('./config');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

/**
 * Check if a message contains spam or scam content
 * 
 * @param {string} messageContent - The content of the message to check
 * @returns {Promise<Object>} - Result object with isSpamOrScam flag and reason
 */
async function checkMessage(messageContent) {
  try {
    logger.debug('Checking message with AI:', messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : ''));
    
    const systemPrompt = `
    You are a Discord moderation assistant that identifies spam and scam messages.
    
    Analyze the message and determine if it matches any of these spam/scam patterns:
    1. Messages containing suspicious links or asking users to open tickets
    2. Messages asking users to DM for support instead of using public channels
    3. Generic job-seeking messages that appear to be copy-pasted
    4. Messages asking who to contact for unspecified business/partnerships
    5. Messages promising rewards, giveaways, or airdrops that seem suspicious
    6. Impersonation of staff or team members
    7. Phishing attempts asking for personal information or wallet addresses
    
    For each message, you will only respond with a JSON object in this format:
    {
      "isSpamOrScam": true/false,
      "reason": "brief explanation if it's spam/scam" or null if not
    }
    
    Be precise but not overly strict. Normal community discussions, technical questions, 
    and legitimate support requests should not be flagged.
    `;
    
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: messageContent
        }
      ],
      temperature: 0.1,
      max_tokens: 150,
      response_format: { type: "json_object" }
    });
    
    // Extract the content from the response
    const aiResponse = response.choices[0].message.content;
    
    // Parse the JSON response
    const result = JSON.parse(aiResponse);
    
    logger.debug(`AI analysis result: ${JSON.stringify(result)}`);
    
    return {
      isSpamOrScam: result.isSpamOrScam,
      reason: result.reason || "Detected as spam/scam by moderation system"
    };
  } catch (error) {
    logger.error('Error checking message with AI:', error);
    
    // Return a safe default to ensure bot continues functioning
    return {
      isSpamOrScam: false,
      reason: null
    };
  }
}

module.exports = { checkMessage };
