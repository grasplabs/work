import { brainReceiptIdSchema, memoryIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { brain, brainErrors } from "../src/brain.ts";
import type {
  BrainBinding,
  CommandReceipt,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
} from "../src/brain.ts";

// The Brain as a caller uses it, over a binding the host gave it: each
// call's input is checked before anything reaches the host, an operation
// the binding wasn't granted is refused, and what the host answers comes
// back as it was. Core checks every call again; that is core's test.

/** How a call ended: `answered`, or the code it was refused with. */
const outcome = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "answered";
  } catch (error) {
    return brainErrors.codeOf(error) ?? "failed";
  }
};

/** `value` passed where the types refuse it, on purpose. */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; the facade must refuse it at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

const pack: MemoryPack = {
  id: "pack-1",
  contractVersion: 1,
  retrievalPolicyVersion: "fulltext@2",
  items: [],
  sourceVersions: [],
  conflicts: [],
  gaps: [{ about: "Who owns onboarding" }],
  coverage: {
    state: "complete",
    queriedRoutes: ["fulltext"],
    omittedRoutes: [],
  },
  truncated: false,
  warnings: [],
  tokenCount: 0,
  accessRevision: "rev-1",
  indexGeneration: "gen-1",
  createdAt: "2026-10-21T08:00:00.000Z",
};

const receipt: CommandReceipt = {
  id: brainReceiptIdSchema.parse("receipt-1"),
  contractVersion: 1,
  operation: "remember",
  requestHash: "hash",
  status: "committed",
  resourceRefs: [],
  indexingState: "pending",
  retentionUntil: "2026-11-21T08:00:00.000Z",
  createdAt: "2026-10-21T08:00:00.000Z",
};

const record: MemoryRecord = {
  id: memoryIdSchema.parse("mem-1"),
  revision: 2,
  kind: "lesson",
  scope: "team",
  statement: "Ask the owner first.",
  sourceRefs: [],
  state: "accepted",
  validFrom: null,
  validTo: null,
  recordedAt: "2026-10-21T08:00:00.000Z",
  reviewAt: null,
};

const page: MemoryPage = { records: [record], cursor: null };

/**
 * A host's binding as a class whose methods read its own state, as a host
 * object would: every call is recorded with its operation's name.
 */
class RecordingHost implements BrainBinding {
  readonly asked: unknown[][] = [];

  async recall(input: unknown) {
    this.asked.push(["recall", input]);
    return await Promise.resolve(pack);
  }

  async remember(input: unknown, options: unknown) {
    this.asked.push(["remember", input, options]);
    return await Promise.resolve(receipt);
  }

  async receiptsGet(input: unknown) {
    this.asked.push(["receipts.get", input]);
    return await Promise.resolve(receipt);
  }

  async memoriesGet(input: unknown) {
    this.asked.push(["memories.get", input]);
    return await Promise.resolve(record);
  }

  async memoriesList(input: unknown) {
    this.asked.push(["memories.list", input]);
    return await Promise.resolve(page);
  }

  async memoriesProposeChange(input: unknown, options: unknown) {
    this.asked.push(["memories.proposeChange", input, options]);
    return await Promise.resolve(receipt);
  }
}

describe("the Brain, as a caller uses it", () => {
  it("sends the host what it was given, checked, and returns what the host answers", async () => {
    const asked: unknown[] = [];
    const binding: BrainBinding = {
      recall: async (input) => {
        asked.push(input);
        return await Promise.resolve(pack);
      },
    };
    const answered = await brain(binding).recall({
      query: "  Who owns onboarding?  ",
      budget: { maxTokens: 4000 },
    });
    expect({ answered, asked }).toStrictEqual({
      answered: pack,
      asked: [{ query: "Who owns onboarding?", budget: { maxTokens: 4000 } }],
    });
  });

  it("calls each operation on the host's own binding, checked, and returns what it answers", async () => {
    const host = new RecordingHost();
    const memory = brain(host);
    const key = { idempotencyKey: "effect-0001" };
    const answers = [
      await memory.remember(
        { kind: "lesson", text: " Ask the owner first. " },
        key
      ),
      await memory.receipts.get({ receiptId: "receipt-1" }),
      await memory.memories.get({ memoryId: "mem-1" }),
      await memory.memories.list(),
      await memory.memories.proposeChange(
        { memoryId: "mem-1", statement: "Ask Jan first." },
        { ...key, expectedRevision: 2 }
      ),
    ];
    expect({ answers, asked: host.asked }).toStrictEqual({
      answers: [receipt, receipt, record, page, receipt],
      asked: [
        ["remember", { kind: "lesson", text: "Ask the owner first." }, key],
        ["receipts.get", { receiptId: "receipt-1" }],
        ["memories.get", { memoryId: "mem-1" }],
        ["memories.list", {}],
        [
          "memories.proposeChange",
          { memoryId: "mem-1", statement: "Ask Jan first." },
          { ...key, expectedRevision: 2 },
        ],
      ],
    });
  });

  it("refuses, sending nothing, each operation's input the contract refuses", async () => {
    const host = new RecordingHost();
    const memory = brain(host);
    const key = { idempotencyKey: "effect-0001" };
    const refused = await Promise.all([
      outcome(memory.remember({ kind: "lesson", text: "" }, key)),
      outcome(memory.remember({ kind: "lesson", text: "Hi" }, unchecked({}))),
      outcome(memory.receipts.get(unchecked({ receiptId: "" }))),
      outcome(
        memory.memories.get(unchecked({ memoryId: "mem-1", owner: "x" }))
      ),
      outcome(memory.memories.list({ limit: 1000 })),
      // A correction names the revision it was made against.
      outcome(
        memory.memories.proposeChange(
          { memoryId: "mem-1", statement: "Ask Jan first." },
          unchecked(key)
        )
      ),
    ]);
    expect({ refused, asked: host.asked }).toStrictEqual({
      refused: Array.from({ length: 6 }, () => "brain.invalid"),
      asked: [],
    });
  });

  it("refuses, sending nothing, input the contract refuses and operations the binding wasn't granted", async () => {
    let sent = 0;
    const binding: BrainBinding = {
      recall: async () => {
        sent += 1;
        return await Promise.resolve(pack);
      },
    };
    const memory = brain(binding);
    const results = {
      forgedActor: await outcome(
        memory.recall(unchecked({ query: "Who?", actor: "user-admin" }))
      ),
      overBudget: await outcome(
        memory.recall({ query: "Who?", budget: { maxItems: 1000 } })
      ),
      remember: await outcome(
        memory.remember(
          { kind: "lesson", text: "Ask the owner first." },
          { idempotencyKey: "effect-0001" }
        )
      ),
      receipts: await outcome(memory.receipts.get({ receiptId: "receipt-1" })),
    };
    expect({ results, sent }).toStrictEqual({
      results: {
        forgedActor: "brain.invalid",
        overBudget: "brain.invalid",
        remember: "brain.denied",
        receipts: "brain.denied",
      },
      sent: 0,
    });
  });
});
