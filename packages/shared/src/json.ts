export interface JsonStructureLimits {
  maxDepth: number;
  maxNodes: number;
  maxKeys: number;
}

export type JsonStructureIssue =
  | 'depth'
  | 'nodes'
  | 'keys'
  | 'cycle'
  | 'invalid_value';

export const MANIFEST_JSON_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 50_000,
  maxKeys: 20_000,
}) satisfies JsonStructureLimits;

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

function validLimits(limits: JsonStructureLimits): boolean {
  return (
    Number.isSafeInteger(limits.maxDepth) &&
    limits.maxDepth >= 0 &&
    Number.isSafeInteger(limits.maxNodes) &&
    limits.maxNodes >= 1 &&
    Number.isSafeInteger(limits.maxKeys) &&
    limits.maxKeys >= 0
  );
}

/** Iteratively validates JSON shape so hostile nesting cannot consume the call stack. */
export function jsonStructureIssue(
  value: unknown,
  limits: JsonStructureLimits,
): JsonStructureIssue | null {
  if (!validLimits(limits)) throw new TypeError('Invalid JSON structure limits.');

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
    if (nodes > limits.maxNodes) return 'nodes';
    if (frame.depth > limits.maxDepth) return 'depth';

    const current = frame.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'invalid_value';
      continue;
    }
    if (typeof current !== 'object') return 'invalid_value';
    if (ancestors.has(current)) return 'cycle';

    if (Array.isArray(current)) {
      if (current.length > limits.maxNodes - nodes) return 'nodes';
      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: current[index], depth: frame.depth + 1 });
      }
    } else {
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) return 'invalid_value';
      const objectKeys = Object.keys(current);
      keys += objectKeys.length;
      if (keys > limits.maxKeys) return 'keys';
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

  return null;
}
