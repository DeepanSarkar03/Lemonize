const MAX_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_KEYS = 20_000;

export class ManifestJsonError extends Error {
  constructor() {
    super('invalid_manifest');
    this.name = 'ManifestJsonError';
  }
}

interface ValueFrame {
  kind: 'value';
  value: unknown;
  depth: number;
}

interface LeaveFrame {
  kind: 'leave';
  value: object;
}

type StructureFrame = ValueFrame | LeaveFrame;

/** Mirrors the registry boundary limits without adding a runtime package dependency. */
export function assertManifestJsonStructure(value: unknown): void {
  const stack: StructureFrame[] = [{ kind: 'value', value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let keys = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'leave') {
      ancestors.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > MAX_NODES || frame.depth > MAX_DEPTH) throw new ManifestJsonError();
    const current = frame.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new ManifestJsonError();
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) throw new ManifestJsonError();

    if (Array.isArray(current)) {
      if (current.length > MAX_NODES - nodes) throw new ManifestJsonError();
      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: current[index], depth: frame.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new ManifestJsonError();
    const objectKeys = Object.keys(current);
    keys += objectKeys.length;
    if (keys > MAX_KEYS) throw new ManifestJsonError();
    ancestors.add(current);
    stack.push({ kind: 'leave', value: current });
    for (let index = objectKeys.length - 1; index >= 0; index -= 1) {
      const key = objectKeys[index]!;
      stack.push({
        kind: 'value',
        value: (current as Record<string, unknown>)[key],
        depth: frame.depth + 1,
      });
    }
  }
}

interface CanonicalValueFrame {
  kind: 'value';
  value: unknown;
}

interface CanonicalTextFrame {
  kind: 'text';
  value: string;
}

type CanonicalFrame = CanonicalValueFrame | CanonicalTextFrame;

/** Deterministic JSON encoding with an iterative traversal and explicit limits. */
export function canonicalManifestJson(value: unknown): string {
  assertManifestJsonStructure(value);
  const output: string[] = [];
  const stack: CanonicalFrame[] = [{ kind: 'value', value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'text') {
      output.push(frame.value);
      continue;
    }

    const current = frame.value;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      const encoded = JSON.stringify(current);
      if (encoded === undefined) throw new ManifestJsonError();
      output.push(encoded);
      continue;
    }
    if (Array.isArray(current)) {
      output.push('[');
      stack.push({ kind: 'text', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: current[index] });
        if (index > 0) stack.push({ kind: 'text', value: ',' });
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const objectKeys = Object.keys(record).sort();
    output.push('{');
    stack.push({ kind: 'text', value: '}' });
    for (let index = objectKeys.length - 1; index >= 0; index -= 1) {
      const key = objectKeys[index]!;
      stack.push({ kind: 'value', value: record[key] });
      stack.push({ kind: 'text', value: ':' });
      stack.push({ kind: 'text', value: JSON.stringify(key) });
      if (index > 0) stack.push({ kind: 'text', value: ',' });
    }
  }

  return output.join('');
}
