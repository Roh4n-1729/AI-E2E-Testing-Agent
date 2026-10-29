#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/config.js';
import { buildPipeline } from '../src/core/pipeline.js';
import { silentLogger } from '../src/util/logger.js';

/** Writes the LangGraph run graph as Mermaid (docs/diagrams/05-langgraph.mmd), straight from the code. */
const noop = async () => {
  throw new Error('not used');
};
const { graph } = buildPipeline({
  config: loadConfig({}, {}),
  logger: silentLogger,
  crawler: { crawl: noop },
  planner: { plan: noop },
  runner: { run: noop },
  reporter: { report: noop },
});
const out = 'docs/diagrams/05-langgraph.mmd';
await writeFile(out, graph.getGraph().drawMermaid());
console.log(`Wrote ${out}`);
