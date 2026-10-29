/** @typedef {'silent' | 'error' | 'warn' | 'info' | 'debug'} LogLevel */
/**
 * @typedef {object} Logger
 * @property {(msg: string, meta?: unknown) => void} error
 * @property {(msg: string, meta?: unknown) => void} warn
 * @property {(msg: string, meta?: unknown) => void} info
 * @property {(msg: string, meta?: unknown) => void} debug
 * @property {(scope: string) => Logger} child
 */

/** @type {Record<LogLevel, number>} */
const ORDER = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * @param {LogLevel} [level] @param {string} [scope]
 * @param {(entry: { level: string, scope: string, message: string }) => void} [sink]  also receives every emitted line
 * @returns {Logger}
 */
export function createLogger(level = 'info', scope = '', sink) {
  /** @param {'error' | 'warn' | 'info' | 'debug'} lvl @param {string} msg @param {unknown} [meta] */
  const emit = (lvl, msg, meta) => {
    if (ORDER[lvl] > ORDER[level]) return;
    sink?.({ level: lvl, scope, message: msg });
    const line = `${scope ? `[${scope}] ` : ''}${msg}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    if (meta === undefined) out(line);
    else out(line, meta);
  };
  return {
    error: (m, x) => emit('error', m, x),
    warn: (m, x) => emit('warn', m, x),
    info: (m, x) => emit('info', m, x),
    debug: (m, x) => emit('debug', m, x),
    child: (s) => createLogger(level, scope ? `${scope}:${s}` : s, sink),
  };
}

export const silentLogger = createLogger('silent');
