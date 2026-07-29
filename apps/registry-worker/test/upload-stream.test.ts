import { describe, expect, it } from 'vitest';
import { fixedLengthUploadBody } from '../src/lib/upload-stream.js';

function body(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

describe('fixed-length R2 upload bodies', () => {
  it('preserves all bytes across multiple input chunks', async () => {
    const counter = { bytes: 0 };
    const upload = fixedLengthUploadBody(body([1, 2], [3, 4]), 4, counter);
    const bytes = new Uint8Array(await new Response(upload.readable).arrayBuffer());

    await expect(upload.completed).resolves.toBeUndefined();
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(counter.bytes).toBe(4);
  });

  it('rejects an upload that exceeds its declared length', async () => {
    const counter = { bytes: 0 };
    const upload = fixedLengthUploadBody(body([1, 2, 3]), 2, counter);
    const consumed = new Response(upload.readable).arrayBuffer();

    await expect(Promise.all([upload.completed, consumed])).rejects.toThrow();
    expect(counter.bytes).toBe(3);
  });

  it('rejects an upload shorter than its declared length', async () => {
    const upload = fixedLengthUploadBody(body([1, 2]), 3, { bytes: 0 });
    const consumed = new Response(upload.readable).arrayBuffer();

    await expect(Promise.all([upload.completed, consumed])).rejects.toThrow();
  });
});
