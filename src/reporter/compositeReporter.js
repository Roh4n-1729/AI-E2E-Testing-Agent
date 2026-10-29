/** @import { Reporter } from '../core/ports.js' */

/** @implements {Reporter} */
export class CompositeReporter {
  /** @param {Reporter[]} reporters */
  constructor(reporters) {
    this.reporters = reporters;
  }

  /** @param {import('../core/types.js').RunReport} report */
  async report(report) {
    for (const r of this.reporters) await r.report(report);
  }
}
