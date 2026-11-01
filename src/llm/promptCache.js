/**
 * Anthropic prompt caching (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
 *
 * A request's prefix (tools, then system, then messages) can be written to a cache at a breakpoint and read back
 * by later requests that start with the same prefix: a read costs 0.1x of the input price (0.05x on Opus 5.5 and
 * Sonnet 5.5), a write 1.25x (5-minute entry) or 2x (1 hour). Where this tool sends the same prefix again:
 *
 *  - planner, judge and the reading of failures: the same system prompt on every call. A breakpoint on the system
 *    message caches tools + system (prompts below the model's minimum, 512 to 4096 tokens, are simply not cached).
 *  - our own agent loop: every step re-sends the whole conversation so far. Automatic caching (one top-level
 *    `cache_control`) moves the breakpoint to the end of each request, so step N reads steps 1..N-1 from the
 *    cache. The loop only ever appends, which is what keeps the prefix identical.
 *  - Stagehand's agent caches its own system prompt already; its history is rewritten between steps, so nothing
 *    more can be cached there.
 *
 * Other providers ignore these options.
 */

/** @typedef {'off' | '5m' | '1h'} PromptCache */

/** Is this an Anthropic model ("anthropic/…" id, or an AI SDK model whose provider is anthropic)? @param {unknown} model */
export const isAnthropic = (model) =>
  typeof model === 'string'
    ? model.startsWith('anthropic/')
    : String(/** @type {any} */ (model)?.provider ?? '').startsWith('anthropic');

/** The cache_control value for a setting, or undefined when off. @param {PromptCache | undefined} ttl */
export const cacheControl = (ttl = '5m') =>
  ttl === 'off'
    ? undefined
    : /** @type {{ type: 'ephemeral', ttl?: '1h' }} */ ({
        type: 'ephemeral',
        ...(ttl === '1h' ? { ttl: '1h' } : {}),
      });

/**
 * @typedef {object} TokenUsage
 * @property {number} inputTokens  ALL input: not cached + read from the cache + written to it
 * @property {number} outputTokens
 * @property {number} [cachedInputTokens]  of the input, read from the cache (billed at a tenth or less)
 * @property {number} [cacheWriteTokens]  of the input, written to the cache (billed at 1.25x or 2x)
 */

/**
 * Token usage from an AI SDK result, with cached input counted as input. Anthropic reports `input_tokens` as only
 * the part after the last cache breakpoint, so without this a cached run would look like it read almost nothing.
 * @param {{ inputTokens?: number, outputTokens?: number, cachedInputTokens?: number } | undefined} usage
 * @param {Array<Record<string, any> | undefined>} [metadata]  providerMetadata of each step (cache writes)
 * @returns {TokenUsage}
 */
export function usageOf(usage, metadata = []) {
  const read = usage?.cachedInputTokens ?? 0;
  const write = metadata.reduce(
    (n, m) => n + (Number(m?.anthropic?.cacheCreationInputTokens) || 0),
    0,
  );
  return {
    inputTokens: (usage?.inputTokens ?? 0) + read + write,
    outputTokens: usage?.outputTokens ?? 0,
    ...(read ? { cachedInputTokens: read } : {}),
    ...(write ? { cacheWriteTokens: write } : {}),
  };
}

/** Add usages together, cache fields included. @param {TokenUsage} a @param {Partial<TokenUsage>} b */
export function addUsage(a, b) {
  a.inputTokens += b.inputTokens ?? 0;
  a.outputTokens += b.outputTokens ?? 0;
  if (b.cachedInputTokens) a.cachedInputTokens = (a.cachedInputTokens ?? 0) + b.cachedInputTokens;
  if (b.cacheWriteTokens) a.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + b.cacheWriteTokens;
  return a;
}
