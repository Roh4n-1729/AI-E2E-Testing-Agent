import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config/config.js';
import { AiSdkLlm } from '../src/llm/aiSdkLlm.js';
import { addUsage, cacheControl, isAnthropic, usageOf } from '../src/llm/promptCache.js';

/**
 * An Anthropic model whose HTTP calls are answered here: the request bodies are kept, and the reply carries the
 * cache counts the API would report.
 */
function fakeAnthropic() {
  /** @type {any[]} */
  const bodies = [];
  const fetch = async (/** @type {any} */ _url, /** @type {any} */ init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const json = body.tools?.find((/** @type {any} */ t) => t.name === 'json');
    const content = json
      ? [{ type: 'tool_use', id: 't1', name: 'json', input: { answer: 'yes' } }]
      : [{ type: 'text', text: body.output_format ? '{"answer":"yes"}' : 'done' }];
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: json ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { model: createAnthropic({ apiKey: 'test', fetch })('claude-sonnet-4-6'), bodies };
}

const SYSTEM = 'You are a strict judge. '.repeat(50);

describe('prompt caching', () => {
  it('caches the planner and judge system prompt, and counts cached input as input', async () => {
    const { model, bodies } = fakeAnthropic();
    /** @type {any[]} */
    const usages = [];
    const llm = new AiSdkLlm(model, (u) => usages.push(u), { cache: '5m' });
    const out = await llm.generateObject({
      schema: z.object({ answer: z.string() }),
      system: SYSTEM,
      prompt: 'Is it done?',
    });
    expect(out).toEqual({ answer: 'yes' });
    const system = bodies[0].system;
    expect(system.at(-1)).toMatchObject({
      type: 'text',
      text: SYSTEM,
      cache_control: { type: 'ephemeral' },
    });
    // 100 not cached + 900 read + 50 written: all of it was input
    expect(usages[0]).toEqual({
      inputTokens: 1050,
      outputTokens: 20,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
    });
  });

  it('a 1-hour entry when asked, and no cache_control at all when switched off', async () => {
    const a = fakeAnthropic();
    await new AiSdkLlm(a.model, undefined, { cache: '1h' }).generateObject({
      schema: z.object({ answer: z.string() }),
      system: SYSTEM,
      prompt: 'x',
    });
    expect(a.bodies[0].system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    const b = fakeAnthropic();
    await new AiSdkLlm(b.model, undefined, { cache: 'off' }).generateObject({
      schema: z.object({ answer: z.string() }),
      system: SYSTEM,
      prompt: 'x',
    });
    expect(JSON.stringify(b.bodies[0])).not.toContain('cache_control');
  });

  it('the agent loop asks for automatic caching: one top-level cache_control on every step', async () => {
    const { model, bodies } = fakeAnthropic();
    const cache = cacheControl('5m');
    const r = await generateText({
      model,
      providerOptions: { anthropic: { cacheControl: /** @type {any} */ (cache) } },
      system: SYSTEM,
      messages: [{ role: 'user', content: 'Start.' }],
    });
    expect(bodies[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(
      usageOf(
        r.totalUsage,
        r.steps.map((s) => s.providerMetadata),
      ),
    ).toMatchObject({
      inputTokens: 1050,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
    });
  });

  it('only Anthropic models, a setting from the environment, and usage adds up', () => {
    expect(isAnthropic('anthropic/claude-haiku-4-5')).toBe(true);
    expect(isAnthropic('openai/gpt-5')).toBe(false);
    expect(cacheControl('off')).toBeUndefined();
    expect(loadConfig({}, {}).promptCache).toBe('5m');
    expect(loadConfig({}, { AIE2E_PROMPT_CACHE: 'off' }).promptCache).toBe('off');
    const total = { inputTokens: 0, outputTokens: 0 };
    addUsage(total, { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 800 });
    addUsage(total, { inputTokens: 500, outputTokens: 5 });
    expect(total).toEqual({ inputTokens: 1500, outputTokens: 15, cachedInputTokens: 800 });
  });
});
