import { Context, Duration, Effect, Layer, Redacted, Schema } from 'effect';
import OpenAI from 'openai';
import { AppConfig } from './config';
import { OpenAiError } from './errors';
import { CLEAN, ModerationVerdict } from './moderation';

export interface ContextMessage {
  readonly author: string;
  readonly roles: ReadonlyArray<string>;
  readonly content: string;
}

export interface MessageMeta {
  readonly author?: string;
  readonly roles: ReadonlyArray<string>;
}

/** Roles as the prompt shows them; a member with none is stated, not omitted. */
export function formatRolesForDisplay(roles: ReadonlyArray<string> | undefined | null): string {
  return roles && roles.length > 0 ? roles.join(', ') : 'None';
}

/**
 * Whether the model belongs to the families that take `max_completion_tokens`
 * and a `developer` system role.
 */
export function isModernReasoningModel(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return normalizedModel.startsWith('gpt-5') || /^o\d/.test(normalizedModel);
}

/**
 * Getting this wrong is not a soft failure: OpenAI rejects `max_tokens` for the
 * reasoning models and `max_completion_tokens` for the older ones, so the whole
 * moderation call errors out and the bot falls back to "not spam".
 */
export function getTokenLimitParam(
  model: string,
  tokenLimit: number
): { max_completion_tokens: number } | { max_tokens: number } {
  return isModernReasoningModel(model)
    ? { max_completion_tokens: tokenLimit }
    : { max_tokens: tokenLimit };
}

export const SYSTEM_PROMPT = `
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

export interface CheckInput {
  readonly content: string;
  readonly previousMessages: ReadonlyArray<ContextMessage>;
  readonly meta: MessageMeta | null;
}

/**
 * The exact request body sent to OpenAI, built without touching the network.
 *
 * Pulling this out of the request is what lets a test assert that context
 * ordering, the role name and the token-limit parameter are right, none of
 * which used to be observable without an API key.
 */
export function buildRequest(
  model: string,
  input: CheckInput
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: isModernReasoningModel(model) ? 'developer' : 'system',
      content: SYSTEM_PROMPT
    }
  ];

  if (input.previousMessages.length > 0) {
    const formatted = input.previousMessages
      .map(msg => `[${msg.author} | Roles: ${formatRolesForDisplay(msg.roles)}]: ${msg.content}`)
      .join('\n');

    messages.push({
      role: 'user',
      content:
        `\nHere are the previous ${input.previousMessages.length} messages in this ` +
        `channel for context:\n${formatted}\n\nNow analyze this new message:`
    });
  }

  const meta = input.meta;
  messages.push({
    role: 'user',
    content: meta
      ? `${meta.author ? `Author: ${meta.author}\n` : ''}` +
        `Roles: ${formatRolesForDisplay(meta.roles)}\nMessage: ${input.content}`
      : input.content
  });

  return {
    model,
    messages,
    temperature: 0.1,
    ...getTokenLimitParam(model, 200),
    response_format: { type: 'json_object' }
  };
}

const decodeVerdict = Schema.decodeUnknownEffect(ModerationVerdict);

/**
 * The moderation model, as a service.
 *
 * `check` cannot fail. That is a deliberate promise encoded in its type: an
 * OpenAI outage, a malformed completion, or a timeout must all read as "not
 * spam", because the alternative — an error path that reaches the action code —
 * would have the bot banning people because a third party was down.
 */
export class Moderator extends Context.Service<
  Moderator,
  {
    check(input: CheckInput): Effect.Effect<ModerationVerdict>;
  }
>()('discord-mod-bot/Moderator') {
  static readonly layer = Layer.effect(
    Moderator,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const client = new OpenAI({ apiKey: Redacted.value(config.openaiApiKey) });
      const model = config.openaiModel;

      const check = Effect.fn('Moderator.check')(
        function* (input: CheckInput) {
          const response = yield* Effect.tryPromise({
            try: signal =>
              client.chat.completions.create(buildRequest(model, input), { signal }),
            catch: cause => new OpenAiError({ cause })
          }).pipe(
            // The original had no bound here, so a stalled request pinned the
            // message handler open indefinitely.
            Effect.timeout(Duration.seconds(30))
          );

          const raw = response.choices[0]?.message?.content ?? '{}';
          yield* Effect.logDebug('OpenAI verdict', raw);

          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: cause => new OpenAiError({ cause })
          });

          return yield* decodeVerdict(parsed);
        },
        // `catchCause`, not `catch`: a decode defect must fail open too.
        Effect.tapCause(cause => Effect.logError('Error checking message with AI', cause)),
        Effect.catchCause(() => Effect.succeed(CLEAN))
      );

      return Moderator.of({ check });
    })
  ).pipe(Layer.provide(AppConfig.layer));
}
