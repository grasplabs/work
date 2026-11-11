/** A signal aborted once `ms` pass without a `touch`; `stop` lets it go. */
interface StallWatch {
  readonly signal: AbortSignal;
  readonly touch: () => void;
  readonly stop: () => void;
}

export const stallWatch = (ms: number): StallWatch => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(timer);
  };
  const touch = (): void => {
    stop();
    timer = setTimeout(() => {
      controller.abort(new DOMException("Nothing arrived.", "TimeoutError"));
    }, ms);
  };
  touch();
  return { signal: controller.signal, touch, stop };
};

/**
 * `response`, its body read through `watch`: each piece that arrives
 * puts its stall off again, and the end or a cancel lets it go. Its
 * reader reads it as it comes (a download does): a body no one reads
 * counts as stalled.
 */
export const following = (response: Response, watch: StallWatch): Response => {
  const { body } = response;
  if (body === null) {
    watch.stop();
    return response;
  }
  const reader = body.getReader();
  // Read on demand only (no high-water mark): nothing is read ahead of
  // its reader, so what core stops sending is never already buffered.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            watch.stop();
            controller.close();
            return;
          }
          watch.touch();
          controller.enqueue(value);
        } catch (error) {
          watch.stop();
          throw error;
        }
      },
      cancel: async (reason) => {
        watch.stop();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
