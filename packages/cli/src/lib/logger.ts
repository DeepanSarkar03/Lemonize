import pc from 'picocolors';

export interface LogOptions {
  json: boolean;
  verbose: boolean;
  color: boolean;
}

let opts: LogOptions = { json: false, verbose: false, color: true };

export function configureLogger(o: Partial<LogOptions>) {
  opts = { ...opts, ...o };
  if (!opts.color) (pc as unknown as { isColorSupported: boolean }).isColorSupported = false;
}

const c = (fn: (s: string) => string, s: string) => (opts.color ? fn(s) : s);

export const log = {
  info: (msg: string) => {
    if (!opts.json) console.log(msg);
  },
  step: (msg: string) => {
    if (!opts.json) console.log(`${c(pc.yellow, '›')} ${msg}`);
  },
  success: (msg: string) => {
    if (!opts.json) console.log(`${c(pc.green, '✔')} ${msg}`);
  },
  warn: (msg: string) => {
    if (!opts.json) console.warn(`${c(pc.yellow, '!')} ${msg}`);
  },
  error: (msg: string) => {
    console.error(`${c(pc.red, '✖')} ${msg}`);
  },
  debug: (msg: string) => {
    if (opts.verbose && !opts.json) console.error(c(pc.gray, `  ${msg}`));
  },
  json: (data: unknown) => {
    console.log(JSON.stringify(data, null, 2));
  },
  dim: (s: string) => c(pc.gray, s),
  bold: (s: string) => c(pc.bold, s),
  yellow: (s: string) => c(pc.yellow, s),
  isJson: () => opts.json,
};
