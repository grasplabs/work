// What a step's result becomes, through the run object's real boundary:
// streams kept and read back, results a step can't keep, sensitive results
// and coded errors. Process death and eviction mid-upload are in
// test/process.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { errorRecord } from "../src/errors.ts";
import type { HistoryEvent } from "../src/history.ts";
import type { StepOutput } from "../src/run.ts";
import { patterned, sha256 } from "./bytes.ts";
import {
  alarmOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  runObject,
  until,
  within,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";
import {
  slowStreamFirst,
  slowStreamRest,
  testMaxRunStreamBytes,
  tinyChunks,
} from "./result-definitions.ts";
import { TestRuns } from "./worker.ts";

interface ChunkRow extends Record<string, SqlStorageValue> {
  ordinal: number;
  attempt: number;
  chunk_index: number;
  length: number;
}

/** The stream chunks the run's storage holds. */
const chunksOf = async (definition: string, id: string): Promise<ChunkRow[]> =>
  await runInDurableObject(runObject(definition, id), (_, state) =>
    state.storage.sql
      .exec<ChunkRow>(
        "SELECT ordinal, attempt, chunk_index, LENGTH(bytes) AS length FROM stream_chunks ORDER BY ordinal, attempt, chunk_index"
      )
      .toArray()
  );

/**
 * The run's history, read in the object itself: Workers RPC types drop a
 * value typed `unknown`, which an event's output is.
 */
const historyOf = async (
  definition: string,
  id: string
): Promise<HistoryEvent[]> =>
  await runInDurableObject(runObject(definition, id), (run) =>
    run instanceof TestRuns ? run.history() : []
  );

/** The bytes of a stream, read to its end within the deadline. */
const read = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(
    await within("the stream to end", new Response(stream).arrayBuffer())
  );

const outputOf = async (
  definition: string,
  id: string,
  name: string
): Promise<StepOutput | undefined> =>
  await runObject(definition, id).stepOutput({ name, count: 1 });

/**
 * Reads a step's stream result in the run object itself, chunk by chunk:
 * how many bytes each chunk it was given held, and how it ended; or why
 * no stream was given. In the object, so no RPC stands between.
 */
const readInObject = async (
  definition: string,
  id: string,
  name: string
): Promise<{ given: number[]; ended: string } | { refused: string }> =>
  await within(
    "the stream to be read",
    runInDurableObject(runObject(definition, id), async (run) => {
      if (!(run instanceof TestRuns)) {
        throw new TypeError("the object isn't a run object");
      }
      let output: StepOutput | undefined;
      try {
        output = await run.stepOutput({ name, count: 1 });
      } catch (error) {
        return { refused: errorRecord(error).message };
      }
      if (output?.kind !== "stream") {
        return { refused: "no stream" };
      }
      const reader = output.stream.getReader();
      const given: number[] = [];
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
          const { done, value } = await reader.read();
          if (done) {
            return { given, ended: "cleanly" };
          }
          given.push(value.byteLength);
        }
      } catch (error) {
        return { given, ended: errorRecord(error).message };
      }
    })
  );

/** The run's count of its stream bytes, and what its chunks hold. */
const streamBytesOf = async (
  definition: string,
  id: string
): Promise<{ counted: number; stored: number }> =>
  await runInDurableObject(runObject(definition, id), (_, state) =>
    state.storage.sql
      .exec<{ counted: number; stored: number }>(
        "SELECT (SELECT stream_bytes FROM run) AS counted, (SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM stream_chunks) AS stored"
      )
      .one()
  );

/** Whether a read ended, or was refused, on corruption. */
const corruptionOf = (
  outcome: { given: number[]; ended: string } | { refused: string }
): { given: number[]; corrupt: boolean } | { refused: boolean } =>
  "refused" in outcome
    ? { refused: /corrupt/u.test(outcome.refused) }
    : { given: outcome.given, corrupt: /corrupt/u.test(outcome.ended) };

/** What a stream of `sizes` streams (test/result-definitions.ts). */
const contentOf = (sizes: number[]): Uint8Array =>
  patterned(
    sizes.reduce((sum, size) => sum + size, 0),
    sizes.length
  );

/** Waits until the journal shows generation 1's activation has ended. */
const firstActivationEnded = async (definition: string, id: string) =>
  await until("the first activation to end", async () => {
    const journal = await journalOf(definition, id);
    return journal.activations[0]?.ended === null ? undefined : journal;
  });

const kib = 1024;

const terminated = (step: string, detail: string): string =>
  `The execution of the Workflow instance was terminated, as the step "${step}" ${detail}`;

const locked =
  "Step returned a ReadableStream that is already locked or otherwise unreadable. Return a fresh, unlocked ReadableStream from step.do().";
const unsupported =
  "Step returned a ReadableStream with unsupported chunk type. Only ArrayBuffer and TypedArray chunks are supported.";

describe("a step's stream result", () => {
  it("is read to its end and kept, and the step returns a fresh stream of exactly its bytes", async () => {
    const id = newId();
    const sizes = [100 * kib, 300 * kib, 5, 200 * kib];
    const content = contentOf(sizes);
    const hash = await sha256(content);
    await workflow("streamed").create({ id, params: { sizes } });

    const status = await ended("streamed", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: { sha256: hash, length: content.byteLength, fresh: true },
    });
    expect(effectsOf(id).map((effect) => effect.label)).toStrictEqual([
      "export",
      "digest",
    ]);
    // Kept in 256 KiB chunks, of the one attempt that ran.
    await expect(chunksOf("streamed", id)).resolves.toStrictEqual([
      { ordinal: 1, attempt: 1, chunk_index: 0, length: 256 * kib },
      { ordinal: 1, attempt: 1, chunk_index: 1, length: 256 * kib },
      {
        ordinal: 1,
        attempt: 1,
        chunk_index: 2,
        length: content.byteLength - 512 * kib,
      },
    ]);
    // Observers are told its length and hash, never its bytes.
    await expect(historyOf("streamed", id)).resolves.toMatchObject([
      {
        step: { name: "export", count: 1 },
        streamOutput: {
          length: content.byteLength,
          sha256: hash,
          encoding: "identity",
        },
      },
      {
        step: { name: "digest", count: 1 },
        output: status.status === "complete" ? status.output : undefined,
      },
    ]);
    const [exported] = await historyOf("streamed", id);
    expect(exported).not.toHaveProperty("output");
  });

  it("gives the host a fresh stream of the result, with its length, hash and encoding, each time it asks", async () => {
    const id = newId();
    const sizes = [300 * kib, 10];
    const content = contentOf(sizes);
    await workflow("streamed").create({ id, params: { sizes } });
    await ended("streamed", id);

    const first = await outputOf("streamed", id, "export");
    const second = await outputOf("streamed", id, "export");

    expect(first).toMatchObject({
      kind: "stream",
      length: content.byteLength,
      sha256: await sha256(content),
      encoding: "identity",
    });
    expect(
      first?.kind === "stream" && (await read(first.stream))
    ).toStrictEqual(content);
    expect(
      second?.kind === "stream" && (await read(second.stream))
    ).toStrictEqual(content);
  });

  it("keeps an empty stream as an empty result", async () => {
    const id = newId();
    await workflow("streamed").create({ id, params: { sizes: [] } });

    await expect(ended("streamed", id)).resolves.toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(new Uint8Array()),
        length: 0,
        fresh: true,
      },
    });
    await expect(chunksOf("streamed", id)).resolves.toStrictEqual([]);
  });

  it("keeps a byte stream that isn't locked", async () => {
    const id = newId();
    await workflow("byte-stream").create({ id });

    await expect(ended("byte-stream", id)).resolves.toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(patterned(1000)),
        length: 1000,
        fresh: true,
      },
    });
  });

  it("is read back from storage when another activation replays the step, which doesn't run again", async () => {
    const id = newId();
    const sizes = [600 * kib];
    const content = contentOf(sizes);
    const digest = hold(id, "digest");
    await workflow("streamed").create({ id, params: { sizes } });
    await within("digest to be held", digest.held);

    // The duplicate delivery: another activation replays "export" from the
    // journal and reads its stream again in "digest".
    await deliverAlarm("streamed", id);
    const status = await ended("streamed", id);
    digest.release();
    await firstActivationEnded("streamed", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(content),
        length: content.byteLength,
        fresh: true,
      },
    });
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["export", 1],
      ["digest", 1],
      ["digest", 2],
    ]);
    const history = await historyOf("streamed", id);
    expect(history.map((event) => event.step.name)).toStrictEqual([
      "export",
      "digest",
    ]);
  });

  it("can't be completed by an upload superseded midway; the attempt that took over keeps its own", async () => {
    const id = newId();
    const content = new Uint8Array(slowStreamFirst + slowStreamRest);
    content.set(patterned(slowStreamFirst));
    content.set(patterned(slowStreamRest, 1), slowStreamFirst);
    const upload = hold(id, "export");
    await workflow("slow-stream").create({ id });
    await within("the upload to be held", upload.held);
    const midway = await until("part of the upload to be stored", async () => {
      const rows = await chunksOf("slow-stream", id);
      return rows.length > 0 ? rows : undefined;
    });

    // Another activation takes the step over; then the first one's upload
    // goes on, and finishes, too late.
    await deliverAlarm("slow-stream", id);
    const status = await ended("slow-stream", id);
    upload.release();
    const journal = await firstActivationEnded("slow-stream", id);

    expect(midway).toStrictEqual([
      { ordinal: 1, attempt: 1, chunk_index: 0, length: 256 * kib },
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(content),
        length: content.byteLength,
        fresh: true,
      },
    });
    expect(journal).toMatchObject({
      steps: [{ name: "export", state: "succeeded", attempt: 2 }],
      attempts: [
        { attempt: 1, generation: 1, ended: "superseded" },
        { attempt: 2, generation: 2, ended: "succeeded" },
      ],
    });
    // The run's count of its stream bytes is what its chunks hold, after
    // the superseded upload's were deleted.
    await expect(streamBytesOf("slow-stream", id)).resolves.toStrictEqual({
      counted: content.byteLength,
      stored: content.byteLength,
    });
    await expect(chunksOf("slow-stream", id)).resolves.toStrictEqual([
      { ordinal: 1, attempt: 2, chunk_index: 0, length: 256 * kib },
      {
        ordinal: 1,
        attempt: 2,
        chunk_index: 1,
        length: content.byteLength - 256 * kib,
      },
    ]);
  });

  it("gives a reader no byte that isn't the committed one, and no clean end", async () => {
    const id = newId();
    const sizes = [300 * kib];
    await workflow("streamed").create({ id, params: { sizes } });
    await ended("streamed", id);

    // Same length, other bytes: chunk 0 is given, chunk 1 never is.
    await runInDurableObject(runObject("streamed", id), (_, state) => {
      state.storage.sql.exec(
        "UPDATE stream_chunks SET bytes = ? WHERE chunk_index = 1",
        new Uint8Array(300 * kib - 256 * kib)
      );
    });
    const changed = await readInObject("streamed", id, "export");

    // Bytes and their chunk digest changed together: the digest list the
    // commit named tells, before any byte is given.
    await runInDurableObject(runObject("streamed", id), (_, state) => {
      state.storage.sql.exec(
        "UPDATE stream_chunks SET bytes = ?, digest = ? WHERE chunk_index = 1",
        new Uint8Array(300 * kib - 256 * kib),
        "0".repeat(64)
      );
    });
    const relabelled = await readInObject("streamed", id, "export");

    // A chunk gone: refused before any byte is given.
    await runInDurableObject(runObject("streamed", id), (_, state) => {
      state.storage.sql.exec("DELETE FROM stream_chunks WHERE chunk_index = 1");
    });
    const missing = await readInObject("streamed", id, "export");

    expect([changed, relabelled, missing].map(corruptionOf)).toStrictEqual([
      { given: [256 * kib], corrupt: true },
      { refused: true },
      { refused: true },
    ]);
  });

  it("leaves a storage failure while a stream is kept to the watchdog, and the definition never hears of it", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("stream-after").create({ id });
    await within("before to be held", before.held);
    await runInDurableObject(runObject("stream-after", id), (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_chunks BEFORE INSERT ON stream_chunks BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
      );
    });

    before.release();
    const faulted = await until("the activation to fault", async () => {
      const journal = await journalOf("stream-after", id);
      return journal.activations[0]?.ended === "faulted" ? journal : undefined;
    });
    await runInDurableObject(runObject("stream-after", id), (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_chunks");
    });
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("stream-after", id);
    const status = await ended("stream-after", id);

    expect(faulted).toMatchObject({
      run: { status: "running" },
      steps: [
        { name: "before", state: "succeeded" },
        { name: "export", state: "running", attempt: 1 },
      ],
    });
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(patterned(300 * kib)),
        length: 300 * kib,
        fresh: true,
      },
    });
    await expect(journalOf("stream-after", id)).resolves.toMatchObject({
      steps: [
        { name: "before", state: "succeeded" },
        { name: "export", state: "succeeded", attempt: 2 },
      ],
    });
  });

  it("can't make a run's stream outputs hold more than the run's limit", async () => {
    const id = newId();
    await workflow("two-streams").create({ id });

    const status = await ended("two-streams", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowFatalError",
        message: terminated(
          "second",
          `returned an invalid ReadableStream output. The run's stream outputs would hold more than the ${testMaxRunStreamBytes} bytes a run's stream outputs may hold.`
        ),
      },
    });
    await expect(streamBytesOf("two-streams", id)).resolves.toStrictEqual({
      counted: 700 * kib,
      stored: 700 * kib,
    });
    await expect(chunksOf("two-streams", id)).resolves.toMatchObject([
      { ordinal: 1 },
      { ordinal: 1 },
      { ordinal: 1 },
    ]);
  });
});

describe("a stream the step can't keep ends the run, and the definition can't catch it", () => {
  it.each([
    ["locked", locked],
    ["locked-by-a-byob-reader", locked],
    ["a-string-chunk", unsupported],
    ["a-data-view-chunk", unsupported],
    [
      "an-oversized-chunk",
      "Step returned a ReadableStream chunk larger than the maximum allowed size of 16777216 bytes. Return smaller chunks from step.do().",
    ],
    [
      "too-large",
      "Step returned a ReadableStream of more than the 1048576 bytes a step's stream output may hold.",
    ],
    ["a-cancel-that-never-settles", unsupported],
    [
      "a-detached-chunk",
      "Step returned a ReadableStream chunk that can't be read: its buffer is detached. Return chunks the stream no longer changes.",
    ],
    [
      "errors-midway",
      "Failed to read from step ReadableStream output. the source broke",
    ],
  ])("%s", async (kind, message) => {
    const id = newId();
    await workflow("invalid-stream").create({ id, params: { kind } });

    const status = await ended("invalid-stream", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowFatalError",
        message: terminated(
          "export",
          `returned an invalid ReadableStream output. ${message}`
        ),
      },
    });
    await expect(journalOf("invalid-stream", id)).resolves.toMatchObject({
      activations: [{ generation: 1, ended: "settled" }],
      steps: [
        {
          name: "export",
          state: "fatal",
          value: null,
          error: JSON.stringify({
            name: "WorkflowFatalError",
            message: terminated(
              "export",
              `returned an invalid ReadableStream output. ${message}`
            ),
            detail: message,
          }),
        },
      ],
      attempts: [{ attempt: 1, ended: "failed" }],
    });
    // Neither its catch nor its finally ran; nothing of the upload is left.
    expect(effectsOf(id)).toStrictEqual([]);
    await expect(chunksOf("invalid-stream", id)).resolves.toStrictEqual([]);
    await expect(alarmOf("invalid-stream", id)).resolves.toBeNull();
  });
});

/** Runs `statement` on the run's own SQLite. */
const exec = async (
  definition: string,
  id: string,
  statement: string
): Promise<void> => {
  await runInDurableObject(runObject(definition, id), (_, state) => {
    state.storage.sql.exec(statement);
  });
};

describe("a step's fatal outcome", () => {
  it("halts the replay that reaches it when the run's end wasn't written, and the definition never hears of it", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("unkeepable-after").create({ id });
    await within("before to be held", before.held);
    // The run's end, written after the step's fatal outcome, fails.
    await exec(
      "unkeepable-after",
      id,
      "CREATE TRIGGER fail_end BEFORE UPDATE OF status ON run WHEN NEW.status = 'errored' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );

    before.release();
    const cutOff = await until(
      "the fatal outcome to be journaled",
      async () => {
        const journal = await journalOf("unkeepable-after", id);
        return journal.steps[1]?.state === "fatal" ? journal : undefined;
      }
    );
    await exec("unkeepable-after", id, "DROP TRIGGER fail_end");
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("unkeepable-after", id);
    const status = await ended("unkeepable-after", id);

    expect(cutOff.run.status).toBe("running");
    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowFatalError",
        message: terminated(
          "link",
          "returned a value which is not serialisable"
        ),
      },
    });
    // The step's work ran once; no catch or finally of the author's ran.
    expect(effectsOf(id).map((effect) => effect.label)).toStrictEqual([
      "before",
      "linked",
    ]);
  });
});

describe("a replayed stream whose storage fails while it is read", () => {
  it("faults the activation, never fails the step reading it, and the watchdog's replay reads it whole", async () => {
    const id = newId();
    const pause = hold(id, "pause");
    await workflow("replay-read").create({ id });
    await within("pause to be held", pause.held);
    // Storage fails under the next chunk read.
    await exec(
      "replay-read",
      id,
      "ALTER TABLE stream_chunks RENAME TO stream_chunks_away"
    );

    pause.release();
    const faulted = await until("the activation to fault", async () => {
      const journal = await journalOf("replay-read", id);
      return journal.activations[0]?.ended === "faulted" ? journal : undefined;
    });
    await exec(
      "replay-read",
      id,
      "ALTER TABLE stream_chunks_away RENAME TO stream_chunks"
    );
    await deliverAlarm("replay-read", id);
    const status = await ended("replay-read", id);

    expect(faulted.steps).toMatchObject([
      { name: "export", state: "succeeded" },
      { name: "pause", state: "succeeded" },
      { name: "digest", state: "running", attempt: 1, error: null },
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(patterned(600 * kib)),
        length: 600 * kib,
        fresh: true,
      },
    });
    // The first read neither failed nor finished in the author's code.
    expect(effectsOf(id).map((effect) => effect.label)).toStrictEqual([
      "pause",
      "read-attempt-2",
    ]);
  });
});

describe("a stream of many tiny chunks", () => {
  it("is kept whole, chunk after chunk", async () => {
    const id = newId();
    const content = Uint8Array.from(
      { length: tinyChunks },
      (_, index) => index % 256
    );
    await workflow("tiny-chunks").create({ id });

    await expect(ended("tiny-chunks", id)).resolves.toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(content),
        length: tinyChunks,
        fresh: true,
      },
    });
  });
});

describe("a step error whose getters answer differently each time", () => {
  it("is read once: the retry decision and the stored error agree", async () => {
    const id = newId();
    await workflow("fickle-error").create({ id });

    const status = await ended("fickle-error", id);

    // Not retried: the one reading said NonRetryableError, and that is
    // what was stored and thrown.
    expect(status).toStrictEqual({
      status: "complete",
      output: "NonRetryableError",
    });
    const { attempts, steps } = await journalOf("fickle-error", id);
    expect(attempts).toHaveLength(1);
    expect(steps[0]?.error).toBe(
      JSON.stringify({ name: "NonRetryableError", message: "changes its mind" })
    );
  });
});

describe("a replayed stream its reader cancels", () => {
  it("stops quietly while a chunk is being checked: no fault, and the run carries on", async () => {
    const id = newId();
    await workflow("cancel-read").create({ id });

    const status = await ended("cancel-read", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        cancelled: true,
        after: effectsOf(id, "after")[0]?.receipt,
      },
    });
    await expect(journalOf("cancel-read", id)).resolves.toMatchObject({
      activations: [{ generation: 1, ended: "settled" }],
    });
  });
});

describe("a value the step can't keep ends the run, and the definition can't catch it", () => {
  it.each(["url", "rpc-stub", "a-function-inside"])("%s", async (kind) => {
    const id = newId();
    await workflow("unkeepable").create({ id, params: { kind } });

    const status = await ended("unkeepable", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowFatalError",
        message: terminated(
          "link",
          "returned a value which is not serialisable"
        ),
      },
    });
    const { steps } = await journalOf("unkeepable", id);
    expect(steps).toMatchObject([
      { name: "link", state: "fatal", value: null },
    ]);
    expect(steps[0]?.error).toMatch(
      /"detail":"Value returned from step \\"link\\" is not serialisable: /u
    );
    expect(effectsOf(id)).toStrictEqual([]);
  });
});

describe("a sensitive step's result", () => {
  it("is redacted in the run's history before it is written, and the run and the host still get it", async () => {
    const id = newId();
    const secret = `secret-${id}`;
    await workflow("secret").create({ id });

    const status = await ended("secret", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: { token: secret, visible: "shown to observers" },
    });
    await expect(historyOf("secret", id)).resolves.toMatchObject([
      { step: { name: "token", count: 1 }, output: "[REDACTED]" },
      { step: { name: "visible", count: 1 }, output: "shown to observers" },
      {
        step: { name: "use", count: 1 },
        output: effectsOf(id, "use")[0]?.receipt,
      },
    ]);
    // Not anywhere in what was written for observers.
    const rows = await runInDurableObject(runObject("secret", id), (_, state) =>
      state.storage.sql.exec("SELECT * FROM history").toArray()
    );
    expect(JSON.stringify(rows)).not.toContain(secret);
    await expect(outputOf("secret", id, "token")).resolves.toStrictEqual({
      kind: "value",
      value: secret,
    });
  });

  it("is the raw value again when another activation replays the step, and is recorded for observers once", async () => {
    const id = newId();
    const use = hold(id, "use");
    await workflow("secret").create({ id });
    await within("use to be held", use.held);

    await deliverAlarm("secret", id);
    const status = await ended("secret", id);
    use.release();
    await firstActivationEnded("secret", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { token: `secret-${id}` },
    });
    const history = await historyOf("secret", id);
    expect(
      history.filter((event) => event.step.name === "token")
    ).toMatchObject([{ output: "[REDACTED]" }]);
  });

  it("shows observers neither the bytes nor the hash of a sensitive stream", async () => {
    const id = newId();
    await workflow("secret-stream").create({ id });

    await expect(ended("secret-stream", id)).resolves.toStrictEqual({
      status: "complete",
      output: {
        sha256: await sha256(patterned(100)),
        length: 100,
        fresh: true,
      },
    });
    const [file] = await historyOf("secret-stream", id);
    expect(file).toMatchObject({ output: "[REDACTED]" });
    expect(file).not.toHaveProperty("streamOutput");
  });
});

describe("a sensitive step's error", () => {
  it("is kept and thrown with its message redacted, the same on every replay, its name kept", async () => {
    const id = newId();
    await workflow("secret-throws").create({ id, params: { caught: true } });

    const status = await ended("secret-throws", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: { name: "Error", message: "[REDACTED]" },
    });
    const { steps } = await journalOf("secret-throws", id);
    expect(steps[0]?.error).toBe(
      JSON.stringify({ name: "Error", message: "[REDACTED]" })
    );
  });

  it("ends the run with its message redacted when the definition doesn't catch it", async () => {
    const id = newId();
    await workflow("secret-throws").create({ id, params: { caught: false } });

    await expect(ended("secret-throws", id)).resolves.toStrictEqual({
      status: "errored",
      error: { name: "Error", message: "[REDACTED]" },
    });
  });

  it("redacts a failing stream's own reason from the run's error and the step's", async () => {
    const id = newId();
    await workflow("secret-invalid-stream").create({ id });

    const status = await ended("secret-invalid-stream", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowFatalError",
        message: terminated(
          "file",
          "returned an invalid ReadableStream output. [REDACTED]"
        ),
      },
    });
    const { steps } = await journalOf("secret-invalid-stream", id);
    expect(JSON.stringify(steps)).not.toContain(`secret-${id}`);
  });
});

describe("a sensitive step that fails and is retried", () => {
  it("keeps every attempt's error redacted, as the step's and the run's", async () => {
    const id = newId();
    await workflow("secret-retries").create({ id });

    const status = await ended("secret-retries", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: { name: "Error", message: "[REDACTED]" },
    });
    const journal = await journalOf("secret-retries", id);
    expect(journal.attempts.map((attempt) => attempt.error)).toStrictEqual([
      JSON.stringify({ name: "Error", message: "[REDACTED]" }),
      JSON.stringify({ name: "Error", message: "[REDACTED]" }),
    ]);
    expect(JSON.stringify(journal)).not.toContain(`secret-${id}`);
  });
});

describe("a stream upload past its attempt's timeout", () => {
  it("fails the attempt as timed out, keeps none of its chunks, and stores nothing after", async () => {
    const id = newId();
    const stuck = hold(id, "stuck");
    await workflow("stuck-stream").create({ id });

    const status = await ended("stuck-stream", id);
    // The upload's source goes on, late: nothing of it is kept.
    await within("the upload to stall", stuck.held);
    stuck.release();
    await deliverAlarm("stuck-stream", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: "WorkflowTimeoutError",
    });
    await expect(journalOf("stuck-stream", id)).resolves.toMatchObject({
      steps: [{ name: "export", state: "failed" }],
      attempts: [{ attempt: 1, ended: "timed_out" }],
    });
    await expect(chunksOf("stuck-stream", id)).resolves.toStrictEqual([]);
  });
});

describe("a step's sensitivity on replay", () => {
  it("is journaled with the step, and a replay that configures it otherwise ends the run", async () => {
    const id = newId();
    const use = hold(id, "use");
    await workflow("sensitive-toggle").create({ id });
    await within("use to be held", use.held);

    // The next activation reaches "token" not sensitive.
    await deliverAlarm("sensitive-toggle", id);
    const status = await ended("sensitive-toggle", id);
    use.release();
    await firstActivationEnded("sensitive-toggle", id);

    const error = status.status === "errored" ? status.error : undefined;
    expect(error?.name).toBe("WorkflowReplayMismatchError");
    // Its config as journaled, sensitivity with it, and as replayed.
    expect(error?.message).toMatch(
      /the do "token" was configured \{[^}]*"sensitive":true\}, and is now configured \{[^}]*"sensitive":false\}/u
    );
    const { steps } = await journalOf("sensitive-toggle", id);
    expect(steps[0]?.config).toContain('"sensitive":true');
  });
});

describe("an event delivered again", () => {
  it("is the same event with its payload's keys in another order, and another event if it shares its parts otherwise", async () => {
    const id = newId();
    const use = hold(id, "use");
    await workflow("secret").create({ id });
    await within("use to be held", use.held);
    const instance = await workflow("secret").get(id);
    const shared = { y: 1, x: [2] };
    const key = `delivery-${newId()}`;

    const first = await instance.deliverEvent({
      type: "note",
      payload: { a: shared, b: shared },
      key,
    });
    const reordered = { x: [2], y: 1 };
    const again = await instance.deliverEvent({
      type: "note",
      payload: { b: reordered, a: reordered },
      key,
    });
    const copies = instance.deliverEvent({
      type: "note",
      payload: { a: { y: 1, x: [2] }, b: { y: 1, x: [2] } },
      key,
    });
    await expect(copies).rejects.toThrow(/was sent before with another/u);

    use.release();
    await ended("secret", id);

    expect({ first, again }).toStrictEqual({
      first: { accepted: true },
      again: { accepted: false },
    });
    const { events } = await journalOf("secret", id);
    expect(events).toHaveLength(1);
  });
});

describe("a step's config read as JavaScript reads it", () => {
  it("takes a sensitivity its class defines with a getter", async () => {
    const id = newId();
    await workflow("class-config").create({ id });

    await expect(ended("class-config", id)).resolves.toStrictEqual({
      status: "complete",
      output: `secret-${id}`,
    });
    await expect(historyOf("class-config", id)).resolves.toMatchObject([
      { step: { name: "token" }, output: "[REDACTED]" },
    ]);
    const { steps } = await journalOf("class-config", id);
    expect(steps[0]?.config).toContain('"sensitive":true');
  });

  it.each([
    [
      "one whose setting throws when read",
      "throws",
      "A step's config can't be read",
    ],
    [
      "one with a setting it inherits that doesn't exist",
      "inherited",
      `A step's config has no setting "verbose"`,
    ],
  ])("refuses %s", async (_, kind, message) => {
    const id = newId();
    await workflow("odd-config").create({ id, params: { kind } });

    await expect(ended("odd-config", id)).resolves.toStrictEqual({
      status: "errored",
      error: { name: "TypeError", message },
    });
  });
});

describe("params with a shared chain a sorted key reaches deeper", () => {
  it("finds the run when the same start is delivered again", async () => {
    const id = newId();
    let shared: unknown = "core";
    for (let level = 0; level < 510; level += 1) {
      shared = [shared];
    }
    const params = { m: [shared], aaa: [[shared]] };
    const key = `start-${newId()}`;

    const first = await workflow("echo").admit({ id, key, params });
    const again = await workflow("echo").admit({ id, key, params });
    await ended("echo", id);

    expect([first.created, again.created]).toStrictEqual([true, false]);
  });
});

describe("a large array", () => {
  it("is a run's params, and the same start delivered again finds the run", async () => {
    const id = newId();
    const params = Array.from({ length: 300_000 }, () => null);
    const key = `start-${newId()}`;

    const first = await workflow("echo").admit({ id, key, params });
    const again = await workflow("echo").admit({ id, key, params });
    const status = await ended("echo", id);

    expect([first.created, again.created]).toStrictEqual([true, false]);
    expect(
      status.status === "complete" &&
        typeof status.output === "object" &&
        status.output !== null &&
        "payload" in status.output &&
        Array.isArray(status.output.payload) &&
        status.output.payload.length
    ).toBe(300_000);
  });
});

describe("a journal of another schema", () => {
  it("is refused clearly, not read", async () => {
    const id = newId();
    await workflow("echo").create({ id });
    await ended("echo", id);

    await exec("echo", id, "UPDATE run SET schema = 1");

    // In the object: nothing crosses RPC to be logged.
    await expect(
      runInDurableObject(runObject("echo", id), (run) =>
        run instanceof TestRuns ? run.status() : undefined
      )
    ).rejects.toThrow(/schema 1, where this engine reads only schema 2/u);
  });
});

describe("a step's config", () => {
  it("takes sensitive: undefined as no setting", async () => {
    const id = newId();
    await workflow("misconfigured").create({
      id,
      params: { config: { sensitive: undefined } },
    });

    await expect(ended("misconfigured", id)).resolves.toStrictEqual({
      status: "complete",
      output: "ran",
    });
  });

  it.each([
    [
      "another sensitivity",
      { sensitive: "input" },
      `A step's sensitive setting is "output", not "input"`,
    ],
    [
      "a setting that doesn't exist",
      { verbose: true },
      `A step's config has no setting "verbose"`,
    ],
  ])("refuses %s before the step runs", async (_, config, message) => {
    const id = newId();
    await workflow("misconfigured").create({ id, params: { config } });

    await expect(ended("misconfigured", id)).resolves.toStrictEqual({
      status: "errored",
      error: { name: "TypeError", message },
    });
    const { steps } = await journalOf("misconfigured", id);
    expect(steps).toStrictEqual([]);
  });
});

describe("a step's error across the journal", () => {
  it("keeps its name, message and a code in the safe shape, and the definition catches it with them", async () => {
    const id = newId();
    await workflow("coded-caught").create({ id });

    const status = await ended("coded-caught", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: [
        {
          name: "WorkflowError(workflow.invalid_input)",
          message: "No such input",
          code: "workflow.invalid_input",
        },
        // A host's own code isn't kept.
        { name: "Error", message: "socket hang up", code: undefined },
      ],
    });
    const { steps } = await journalOf("coded-caught", id);
    expect(steps.map((step) => step.error)).toStrictEqual([
      JSON.stringify({
        name: "WorkflowError(workflow.invalid_input)",
        message: "No such input",
        code: "workflow.invalid_input",
      }),
      JSON.stringify({ name: "Error", message: "socket hang up" }),
    ]);
  });

  it("reports the code with the error of the run it ended", async () => {
    const id = newId();
    await workflow("coded-uncaught").create({ id });

    await expect(ended("coded-uncaught", id)).resolves.toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowError(workflow.invalid_input)",
        message: "No such input",
        code: "workflow.invalid_input",
      },
    });
  });
});
