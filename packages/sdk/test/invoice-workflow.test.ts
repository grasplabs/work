/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createTestEngine } from "../src/testing.ts";
import { z } from "../src/workflow.ts";
import { invoice } from "./fakes.ts";
import { invoiceWorkflow } from "./workflows/invoice-approval.ts";
import type { InvoiceSystems } from "./workflows/invoice-approval.ts";

const fakeSystems = (
  overrides: Partial<InvoiceSystems> = {}
): InvoiceSystems & { booked: { invoice: string; total: number }[] } => {
  const booked: { invoice: string; total: number }[] = [];
  return {
    booked,
    findPurchaseOrder: async () => ({ amount: 800_000 }),
    book: async (entry) => {
      booked.push(entry);
      return "ledger-42";
    },
    ...overrides,
  };
};

const small = { ...invoice, total: 400_000 };

const day = 86_400_000;

describe("the sample invoice workflow", () => {
  // Decisions read the clock; a frozen one makes their waits exact.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes its parameters as plain JSON", () => {
    const { metadata } = invoiceWorkflow(fakeSystems());

    expect(metadata).toStrictEqual({
      id: "invoice-approval",
      params: [
        {
          name: "threshold",
          kind: "money",
          label: "Review invoices above",
          default: 500_000,
          sensitive: true,
          currency: "EUR",
        },
        {
          name: "reviewer",
          kind: "person",
          label: "Reviewer",
          default: "team:finance",
          sensitive: false,
        },
      ],
    });
    expect(z.json().safeParse(metadata).success).toBeTruthy();
  });

  it("books an invoice below the threshold without asking anyone", async () => {
    const systems = fakeSystems();
    const { engine, decisions } = createTestEngine();

    const result = await invoiceWorkflow(systems).run(engine, small);

    expect({ result, decisions, booked: systems.booked }).toStrictEqual({
      result: { status: "booked", entry: "ledger-42" },
      decisions: [],
      booked: [{ invoice: "INV-7", total: 400_000 }],
    });
  });

  it("asks the reviewer above the threshold and books once approved", async () => {
    const systems = fakeSystems();
    const { engine, decisions } = createTestEngine({
      decisions: { review: { approved: true, by: "anna" } },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect({
      result,
      decisions: decisions.map(({ step, from }) => ({ step, from })),
      booked: systems.booked,
    }).toStrictEqual({
      result: { status: "booked", entry: "ledger-42" },
      decisions: [{ step: "review", from: "team:finance" }],
      booked: [{ invoice: "INV-7", total: 800_000 }],
    });
  });

  it("doesn't book an invoice the reviewer rejects", async () => {
    const systems = fakeSystems();
    const { engine } = createTestEngine({
      decisions: {
        review: {
          approved: false,
          by: "anna",
          payload: { comment: "Wrong PO" },
        },
      },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "rejected" });
    expect(systems.booked).toStrictEqual([]);
  });

  it("gives up at the timeout, waiting it out once", async () => {
    const systems = fakeSystems();
    const { engine, steps } = createTestEngine({
      // A wait that times out takes its time; move the frozen clock on.
      skipTime: (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds);
      },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect({
      result,
      waits: steps.flatMap((record) =>
        record.type === "wait" ? [record.timeout] : []
      ),
      booked: systems.booked,
    }).toStrictEqual({
      result: { status: "timedOut" },
      waits: [7 * day],
      booked: [],
    });
  });

  it("uses the values people set instead of the defaults", async () => {
    const systems = fakeSystems();
    const { engine, decisions } = createTestEngine({
      params: { threshold: 1_000_000 },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(decisions).toStrictEqual([]);
  });

  it("fails a run whose parameter value doesn't fit its kind, or is empty", async () => {
    for (const threshold of ["lots", null]) {
      const { engine } = createTestEngine({ params: { threshold } });

      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        invoiceWorkflow(fakeSystems()).run(engine, invoice)
      ).rejects.toMatchObject({ code: "workflow.invalid_param" });
    }
  });

  it("keeps the parameter values it started with when it resumes", async () => {
    const systems = fakeSystems();
    const { book } = systems;
    let crashed = false;
    systems.book = async (entry) => {
      if (!crashed) {
        crashed = true;
        throw new Error("Ledger went away mid-call");
      }
      return await book(entry);
    };
    const params: Record<string, unknown> = { threshold: 1_000_000 };
    const { engine, decisions } = createTestEngine({ params });
    const definition = invoiceWorkflow(systems);

    await expect(definition.run(engine, invoice)).rejects.toThrow(
      "Ledger went away"
    );
    params.threshold = 100_000;
    const result = await definition.run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(decisions).toStrictEqual([]);
  });

  it("fails a run whose input doesn't match the input schema", async () => {
    const { engine } = createTestEngine();

    await expect(
      invoiceWorkflow(fakeSystems()).run(engine, { number: "INV-7" })
    ).rejects.toMatchObject({ code: "workflow.invalid_input" });
  });

  it("resumes after a crash without redoing finished steps", async () => {
    let lookups = 0;
    let crashed = false;
    const systems = fakeSystems({
      findPurchaseOrder: async () => {
        lookups += 1;
        return { amount: 400_000 };
      },
    });
    const bookOnce = systems.book;
    systems.book = async (entry) => {
      if (!crashed) {
        crashed = true;
        throw new Error("Ledger went away mid-call");
      }
      return await bookOnce(entry);
    };
    const { engine } = createTestEngine();
    const definition = invoiceWorkflow(systems);

    await expect(definition.run(engine, small)).rejects.toThrow(
      "Ledger went away"
    );
    const result = await definition.run(engine, small);

    expect({ status: result.status, lookups }).toStrictEqual({
      status: "booked",
      lookups: 1,
    });
  });
});
