export interface FixedLengthUploadBody {
  readable: ReadableStream<Uint8Array>;
  completed: Promise<void>;
}

/**
 * Preserve a request body's known length while enforcing the declared upload
 * size. R2 rejects ordinary transformed streams because their length is
 * unknown, even when the incoming request included Content-Length.
 */
export function fixedLengthUploadBody(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  counter: { bytes: number },
): FixedLengthUploadBody {
  const fixed = new FixedLengthStream(expectedBytes);
  const completed = body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          counter.bytes += chunk.byteLength;
          if (counter.bytes > expectedBytes) {
            controller.error(new Error('upload_limit_exceeded'));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeTo(fixed.writable);

  return { readable: fixed.readable, completed };
}
