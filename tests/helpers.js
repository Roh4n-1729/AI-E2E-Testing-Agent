import { MockLanguageModelV2 } from 'ai/test';
import { AiSdkLlm } from '../src/llm/aiSdkLlm.js';

/**
 * An LlmClient backed by the AI SDK's mock model that returns `object` as the structured
 * output. Exercises the real schema conversion and response parsing without network access.
 * @param {unknown} object
 * @param {{ calls?: unknown[] }} [spy]
 */
export function mockLlm(object, spy) {
  const model = new MockLanguageModelV2({
    doGenerate: async (options) => {
      spy?.calls?.push(options);
      return {
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        content: [{ type: 'text', text: JSON.stringify(object) }],
        warnings: [],
      };
    },
  });
  return new AiSdkLlm(model);
}
