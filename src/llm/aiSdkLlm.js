import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { cacheControl, isAnthropic, usageOf } from './promptCache.js';

/**
 * @import { LlmClient } from '../core/ports.js'
 * @import { PromptCache, TokenUsage } from './promptCache.js'
 */

/**
 * Resolve a "provider/model" string to an AI SDK language model. API keys come from the
 * standard env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY).
 * @param {string} modelId
 */
export function resolveModel(modelId) {
  const slash = modelId.indexOf('/');
  const provider = slash === -1 ? '' : modelId.slice(0, slash);
  const name = slash === -1 ? modelId : modelId.slice(slash + 1);
  switch (provider) {
    case 'anthropic':
      return createAnthropic()(name);
    case 'openai':
      return createOpenAI()(name);
    case 'google':
      return createGoogleGenerativeAI()(name);
    default:
      throw new Error(
        `Unsupported model provider "${provider}" in "${modelId}". Use anthropic/, openai/ or google/.`,
      );
  }
}

/** @implements {LlmClient} */
export class AiSdkLlm {
  /**
   * @param {import('ai').LanguageModel} model
   * @param {(u: TokenUsage) => void} [onUsage]  token accounting
   * @param {{ cache?: PromptCache }} [opts]  prompt caching of the system prompt (Anthropic only)
   */
  constructor(model, onUsage, opts = {}) {
    this.model = model;
    this.onUsage = onUsage;
    this.cache = isAnthropic(model) ? cacheControl(opts.cache) : undefined;
  }

  /**
   * @param {string} modelId @param {(u: TokenUsage) => void} [onUsage]
   * @param {{ cache?: PromptCache }} [opts]
   */
  static fromModelId(modelId, onUsage, opts) {
    return new AiSdkLlm(resolveModel(modelId), onUsage, opts);
  }

  /**
   * @template T
   * @param {{ schema: import('zod').ZodType<T>, system: string, prompt: string, images?: Uint8Array[] }} args
   * @returns {Promise<T>}
   */
  async generateObject({ schema, system, prompt, images = [] }) {
    const { object, usage, providerMetadata } = await generateObject({
      model: this.model,
      schema,
      // the system prompt is the same on every call of this kind: cached as a prefix (with the schema's tool)
      ...(this.cache ? {} : { system }),
      messages: [
        ...(this.cache
          ? [
              /** @type {const} */ ({
                role: 'system',
                content: system,
                providerOptions: { anthropic: { cacheControl: this.cache } },
              }),
            ]
          : []),
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map((image) => /** @type {const} */ ({ type: 'image', image })),
          ],
        },
      ],
      // thinking models (the claude 5.5 family) reject a temperature; the SDK would warn on every call
      ...(fixedTemperature(this.model) ? {} : { temperature: 0 }),
    });
    this.onUsage?.(usageOf(usage, [providerMetadata]));
    return /** @type {T} */ (object);
  }
}

/**
 * Models that always think and ignore `temperature` (the SDK warns on every call otherwise).
 * @param {import('ai').LanguageModel} model
 */
export function fixedTemperature(model) {
  const id = typeof model === 'string' ? model : model.modelId;
  return /claude-[a-z]+-5-5/.test(id);
}
