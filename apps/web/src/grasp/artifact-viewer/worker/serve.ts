// A viewer Worker's loop, shared by the core's Worker and each item's: one message per task, the
// answer or the error back, typed arrays in the answer handed over, not copied.
interface Request {
  id: number;
  task: unknown;
}

/** An item's tasks: what its Worker runs. */
export type Runner = (task: never) => Promise<unknown>;

// Typed arrays in the result (highlighted code's pieces, a table's cell starts, matches in cells)
// are handed over, not copied.
const transferOf = (result: unknown) => {
  const transfer: ArrayBuffer[] = [];
  if (typeof result === "object" && result !== null) {
    for (const value of Object.values(result)) {
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
        transfer.push(value.buffer);
      }
    }
  }
  return transfer;
};

// A Worker's messages take no target origin: the second argument is only what they hand over.
const answerWith = async (run: Runner, { id, task }: Request) => {
  let result: unknown;
  try {
    // SAFETY: the page sends this Worker only the tasks its lane registered (client.ts).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    result = await run(task as never);
  } catch (error) {
    self.postMessage(
      { id, error: error instanceof Error ? error.message : String(error) },
      { transfer: [] }
    );
    return;
  }
  self.postMessage({ id, result }, { transfer: transferOf(result) });
};

/** Answers every task sent to this Worker with `run`, and says it started. */
export const serve = (run: Runner) => {
  self.addEventListener("message", (event: MessageEvent<Request>) => {
    void answerWith(run, event.data);
  });
  // Says it started, so the page knows this bundler shipped the Worker.
  self.postMessage({ ready: true }, { transfer: [] });
};
