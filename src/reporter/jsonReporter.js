/**
 * @import { Reporter } from '../core/ports.js'
 * @import { RunReport } from '../core/types.js'
 * @import { RunArtifacts } from '../storage/artifacts.js'
 * @import { Logger } from '../util/logger.js'
 */

/**
 * Writes report.json and prints a console summary.
 * @implements {Reporter}
 */
export class JsonReporter {
  /** @param {RunArtifacts} artifacts @param {Logger} logger */
  constructor(artifacts, logger) {
    this.artifacts = artifacts;
    this.logger = logger;
  }

  /** @param {RunReport} report */
  async report(report) {
    const file = await this.artifacts.writeJson('report.json', report);
    const icon = { pass: 'PASS', fail: 'FAIL', error: 'ERR ' };
    this.logger.info('');
    for (const r of report.results) {
      const flags = [
        r.mode,
        r.heals.length ? `${r.heals.length} heal(s)` : '',
        r.claimMismatch ? 'AGENT CLAIM MISMATCH' : '',
      ].filter(Boolean);
      this.logger.info(`${icon[r.verdict.status]}  ${r.test.title}  [${flags.join(', ')}]`);
      if (r.verdict.status !== 'pass') this.logger.info(`      ${r.verdict.reason}`);
      for (const w of r.verdict.warnings) this.logger.info(`      warning: ${w}`);
    }
    const s = report.summary;
    this.logger.info(
      `\n${s.passed}/${s.total} passed, ${s.failed} failed, ${s.errored} errored, ${s.healed} healed`,
    );
    this.logger.info(`Report: ${file}`);
  }
}
