function consumeCsi(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return input.length;
}

function consumeControlString(input: string, start: number, allowBell: boolean): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (allowBell && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return input.length;
}

function consumeEscape(input: string, start: number): number {
  const next = input.charCodeAt(start + 1);
  if (!Number.isFinite(next)) return input.length;
  if (next === 0x5b) return consumeCsi(input, start + 2); // CSI: ESC [
  if (next === 0x5d) return consumeControlString(input, start + 2, true); // OSC: ESC ]
  if ([0x50, 0x58, 0x5e, 0x5f].includes(next)) {
    return consumeControlString(input, start + 2, false); // DCS/SOS/PM/APC
  }

  let index = start + 1;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      index += 1;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return index + 1;
    return index + 1;
  }
  return input.length;
}

/** Strip terminal-active controls from untrusted human-readable registry text. */
export function sanitizeTerminalText(input: string): string {
  let output = '';
  let index = 0;
  const appendSpace = () => {
    if (output.length > 0 && output.at(-1) !== ' ') output += ' ';
  };

  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      index = consumeEscape(input, index);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(input, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = consumeControlString(input, index + 1, true);
      continue;
    }
    if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
      index = consumeControlString(input, index + 1, false);
      continue;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x85) appendSpace();
      index += 1;
      continue;
    }
    output += input[index];
    index += 1;
  }
  return output.trim();
}

