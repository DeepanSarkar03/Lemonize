type CanonicalManifestFrame =
  | { kind: 'value'; value: unknown; depth: number }
  | { kind: 'text'; value: string }
  | { kind: 'leave'; value: object };

export class StoredManifestJsonError extends Error {
  constructor() {
    super('Stored manifest is invalid.');
    this.name = 'StoredManifestJsonError';
  }
}

/** Canonicalizes stored JSON iteratively under the publish-boundary limits. */
export function canonicalStoredManifest(value: unknown): string {
  const maxDepth = 32;
  const maxNodes = 50_000;
  const maxKeys = 20_000;
  const output: string[] = [];
  const ancestors = new Set<object>();
  const stack: CanonicalManifestFrame[] = [{ kind: 'value', value, depth: 0 }];
  let nodes = 0;
  let keys = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'text') {
      output.push(frame.value);
      continue;
    }
    if (frame.kind === 'leave') {
      ancestors.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > maxNodes || frame.depth > maxDepth) throw new StoredManifestJsonError();
    const current = frame.value;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      if (typeof current === 'number' && !Number.isFinite(current)) {
        throw new StoredManifestJsonError();
      }
      const encoded = JSON.stringify(current);
      if (encoded === undefined) throw new StoredManifestJsonError();
      output.push(encoded);
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      throw new StoredManifestJsonError();
    }

    if (Array.isArray(current)) {
      if (current.length > maxNodes - nodes) throw new StoredManifestJsonError();
      ancestors.add(current);
      output.push('[');
      stack.push({ kind: 'leave', value: current });
      stack.push({ kind: 'text', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: current[index], depth: frame.depth + 1 });
        if (index > 0) stack.push({ kind: 'text', value: ',' });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StoredManifestJsonError();
    }
    const record = current as Record<string, unknown>;
    const objectKeys = Object.keys(record).sort();
    keys += objectKeys.length;
    if (keys > maxKeys) throw new StoredManifestJsonError();
    ancestors.add(current);
    output.push('{');
    stack.push({ kind: 'leave', value: current });
    stack.push({ kind: 'text', value: '}' });
    for (let index = objectKeys.length - 1; index >= 0; index -= 1) {
      const key = objectKeys[index]!;
      stack.push({ kind: 'value', value: record[key], depth: frame.depth + 1 });
      stack.push({ kind: 'text', value: ':' });
      stack.push({ kind: 'text', value: JSON.stringify(key) });
      if (index > 0) stack.push({ kind: 'text', value: ',' });
    }
  }

  return output.join('');
}
