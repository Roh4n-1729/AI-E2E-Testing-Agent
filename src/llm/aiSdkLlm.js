import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';

/** @import { LlmClient } from '../core/ports.js' */

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
   * @param {(u: { inputTokens: number, outputTokens: number }) => void} [onUsage]  token accounting
   */
  constructor(model, onUsage) {
    this.model = model;
    this.onUsage = onUsage;
  }

  /** @param {string} modelId @param {(u: { inputTokens: number, outputTokens: number }) => void} [onUsage] */
  static fromModelId(modelId, onUsage) {
    return new AiSdkLlm(resolveModel(modelId), onUsage);
  }

  /**
   * @template T
   * @param {{ schema: import('zod').ZodType<T>, system: string, prompt: string, images?: Uint8Array[] }} args
   * @returns {Promise<T>}
   */
  async generateObject({ schema, system, prompt, images = [] }) {
    const { object, usage } = await generateObject({
      model: this.model,
      schema,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map((image) => /** @type {const} */ ({ type: 'image', image })),
          ],
        },
      ],
      temperature: 0,
    });
    this.onUsage?.({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });
    return /** @type {T} */ (object);
  }
}
