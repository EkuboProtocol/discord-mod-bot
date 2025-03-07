# Discord Moderation Bot

A Node.js bot for Discord that uses AI to automatically moderate messages and remove spam or scam content from your server.

## Features

- Automatically monitors Discord channels for spam and scam messages
- Uses OpenAI's GPT models to intelligently detect problematic content
- Considers previous channel messages for context when moderating
- Can be configured to monitor specific channels or the entire server
- Allows excluding users with specific roles from moderation
- Sends detailed notifications to a designated channel for moderation actions
- Provides detailed logging of moderation activities
- Runs as a systemd service on Ubuntu for 24/7 operation

## Requirements

- Node.js 16.x or higher
- Discord Bot Token (with appropriate permissions)
- OpenAI API Key
- Ubuntu server (for systemd service setup)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/EkuboProtocol/discord-mod-bot.git
   cd discord-mod-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on the example:
   ```bash
   cp .env.example .env
   nano .env  # Edit with your actual credentials
   ```

4. Configure your environment variables in the `.env` file:
   ```
   DISCORD_TOKEN=your_discord_bot_token
   DISCORD_SERVER_ID=your_server_id
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_MODEL=gpt-3.5-turbo
   # Add more configuration as needed
   ```

## Usage

### Running Manually

Start the bot directly using Node.js:

```bash
node src/index.js
```

### Command Line Arguments

The bot supports the following command line arguments:

```
Options:
  -t, --token                Discord bot token                      [string]
  -s, --server               Discord server ID                      [string]
  -c, --channels             Comma-separated list of moderated channel IDs
                             (default: all)                         [string]
  -e, --excluded-roles       Comma-separated list of role IDs to exclude from
                             moderation                             [string]
  -m, --openai-model         OpenAI model to use                    [string]
  -n, --notification-channel Channel ID to send notifications to    [string]
  --context-messages         Number of previous messages for context [number]
  -l, --log-level            Log level (error, warn, info, debug)
                                                    [string] [default: "info"]
  -k, --openai-api-key       OpenAI API key                        [string]
  -h, --help                 Show help                             [boolean]
```

Example:
```bash
node src/index.js --token=your_token --server=your_server_id --channels=channel1,channel2 --excluded-roles=role1,role2 --openai-model=gpt-4
```

### Setting Up as a Systemd Service

1. Copy the service file to systemd:
   ```bash
   sudo cp discord-mod-bot.service /etc/systemd/system/
   ```

2. Edit the service file to match your environment:
   ```bash
   sudo nano /etc/systemd/system/discord-mod-bot.service
   ```
   
3. Reload systemd, enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable discord-mod-bot
   sudo systemctl start discord-mod-bot
   ```

4. Check the status:
   ```bash
   sudo systemctl status discord-mod-bot
   ```

## Configuration

The bot can be configured using environment variables or command line arguments. Command line arguments take precedence over environment variables.

### Environment Variables

- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_SERVER_ID`: The ID of your Discord server
- `MODERATED_CHANNELS`: Comma-separated list of channel IDs to moderate (leave empty to moderate all)
- `EXCLUDED_ROLES`: Comma-separated list of role IDs to exclude from moderation
- `OPENAI_API_KEY`: Your OpenAI API key
- `OPENAI_MODEL`: Model to use for AI moderation (default: gpt-3.5-turbo)
- `IGNORED_PHRASES`: Comma-separated list of phrases to ignore (won't be sent to OpenAI)
- `NOTIFICATION_CHANNEL_ID`: Channel ID to send detailed moderation notifications
- `CONTEXT_MESSAGE_COUNT`: Number of previous messages to include for context (default: 5)
- `LOG_LEVEL`: Logging level (error, warn, info, debug)

## Logging

Logs are stored in the `logs` directory:
- `logs/combined.log`: Contains all log messages
- `logs/error.log`: Contains only error messages

## Moderation Rules

The bot monitors messages for:
1. Messages containing suspicious links or asking users to open tickets
2. Messages asking users to DM for support instead of using public channels
3. Generic job-seeking messages that appear to be copy-pasted
4. Messages asking who to contact for unspecified business/partnerships
5. Messages promising rewards, giveaways, or airdrops that seem suspicious
6. Impersonation of staff or team members
7. Phishing attempts asking for personal information or wallet addresses

## Discord Integration Options

There are several ways to integrate this bot with Discord:

### 1. Standard Bot User (Default)

This is the most common method where you create a bot application in the Discord Developer Portal and add it to your server. This approach:

- Requires a separate bot user in your server
- Needs specific permissions to read/delete messages
- Is easy to set up through the Discord Developer Portal

### 2. Discord Interactions and Webhooks

For more advanced integrations with fewer permissions, you could modify this code to use:

- **Discord Webhooks**: For sending notifications without a full bot
- **Discord Interactions**: For slash commands (would require additional development)

### 3. User Account Token (Not Recommended)

While technically possible to use a user account token instead of a bot token, this approach:
- Violates Discord's Terms of Service
- Can result in account termination
- Is not supported by this code

### 4. Discord Bot Framework Integration

If you already have a bot for your server, you could integrate this moderation code as a module in your existing bot framework to avoid adding another bot user to your server.

## Troubleshooting

- **Bot not starting**: Check the logs for error messages
- **Bot not detecting messages**: Make sure the bot has the required permissions in Discord
- **OpenAI API errors**: Verify your API key and quota
- **Bot not running after system restart**: Make sure the systemd service is enabled
- **Context not being considered**: Ensure the bot has permissions to read message history

## License

MIT