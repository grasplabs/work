import { FormApi } from "@tanstack/react-form";
import { describe, expect, it } from "vite-plus/test";

import { clientError, GraspError } from "../src/client-error.ts";
import { FormBinding } from "../src/form.ts";
import type { FormApiOf } from "../src/form.ts";
import { api } from "./notes/.grasp/references.ts";

// A form's submission state against what the session client answers: an
// outcome it can't tell, given up only by the person, and records the
// parent supplies, adopted while the draft holds what the record holds.

type Target = ConstructorParameters<typeof FormBinding>[0];

/** `binding` connected to a TanStack form of its initial values, as `useForm` does. */
const mounted = (binding: FormBinding) => {
  const form = new FormApi({ defaultValues: binding.initialValues });
  form.mount();
  // SAFETY: the binding reads the form's values, validation and reset,
  // which a plain FormApi has; the React parts it never touches here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  binding.attach(form as unknown as FormApiOf<Record<string, unknown>>);
  return form;
};

/** Why `promise` rejected, or that it resolved. */
const settle = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
};

describe("a form whose submission's outcome is unknown", () => {
  it("keeps the fields locked and sends it again under its key, until the person discards it", async () => {
    const keys: string[] = [];
    const target: Target = {
      kind: "operation",
      args: api.notes.create.args,
      send: async (_input, { idempotencyKey }) => {
        await Promise.resolve();
        keys.push(idempotencyKey ?? "");
        if (keys.length <= 2) {
          throw clientError("submission.outcome_unknown", { idempotencyKey });
        }
        return "saved";
      },
    };
    const binding = new FormBinding(target, { title: "Once", body: "" }, {});
    mounted(binding);

    await settle(binding.submit());
    expect(binding.status().phase).toBe("uncertain");
    // Asking again sends the same submission, under its key.
    await settle(binding.submit());
    expect(keys[1]).toBe(keys[0]);

    // Given up, knowingly: the fields unlock and the next is new.
    binding.discard();
    expect(binding.status()).toMatchObject({ phase: "idle" });
    await expect(binding.submit()).resolves.toBe("saved");
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("never discards a submission still in flight", async () => {
    const { promise: held, resolve } = Promise.withResolvers<string>();
    const binding = new FormBinding(
      {
        kind: "operation",
        args: api.notes.create.args,
        send: async () => await held,
      },
      { title: "Held", body: "" },
      {}
    );
    mounted(binding);
    const submitting = binding.submit();
    await expect.poll(() => binding.status().phase).toBe("submitting");
    binding.discard();
    expect(binding.status().phase).toBe("submitting");
    resolve("saved");
    await expect(submitting).resolves.toBe("saved");
  });
});

describe("a record form and the records it is supplied", () => {
  it("adopts a newer record while the draft holds what the record does, in whatever order", () => {
    const record = {
      _id: "n1",
      _rev: 1,
      title: "First",
      meta: { color: "blue", size: 2 },
    };
    const binding = new FormBinding(
      {
        kind: "record",
        args: api.notes.update.args,
        fields: ["title", "meta"],
        send: async () => await Promise.resolve(null),
      },
      { title: record.title, meta: record.meta },
      { record }
    );
    const form = mounted(binding);
    // The same value, its keys in another order: no edit.
    form.setFieldValue("meta", { size: 2, color: "blue" });
    binding.supply({ ...record, _rev: 2, title: "Second" });
    expect(binding.status().newer).toBeFalsy();
    expect(form.state.values).toMatchObject({ title: "Second" });
  });
});

describe("a form whose values don't pass", () => {
  it("rejects its submit with the issues it found, sending nothing", async () => {
    let sent = 0;
    const binding = new FormBinding(
      {
        kind: "operation",
        args: api.notes.create.args,
        send: async () => {
          await Promise.resolve();
          sent += 1;
          return "saved";
        },
      },
      { title: 5, body: "" },
      {}
    );
    mounted(binding);
    const failure = await settle(binding.submit());
    expect(failure).toMatchObject({
      rejected: {
        code: "contract.invalid_args",
        details: { issues: [{ path: ["title"] }] },
      },
    });
    expect(sent).toBe(0);
  });
});

describe("a record form whose save answers no record", () => {
  const record = {
    _id: "01890000-0000-7000-8000-000000000001",
    _rev: 3,
    title: "Same",
    body: "",
  };

  /** A record form over `record` whose save succeeds without answering it. */
  const recordForm = () => {
    const binding = new FormBinding(
      {
        kind: "record",
        args: api.notes.update.args,
        fields: ["title", "body"],
        send: async () => await Promise.resolve(null),
      },
      { title: record.title, body: record.body },
      {
        record,
        args: () => ({ id: record._id, expectedRevision: record._rev }),
      }
    );
    return { binding, form: mounted(binding) };
  };

  it("is done at once when it saved what the record held", async () => {
    const { binding } = recordForm();
    await binding.submit();
    expect(binding.status().phase).toBe("idle");
  });

  it("is done at once when what it saved normalizes to what the record held", async () => {
    const { binding, form } = recordForm();
    // The title trims to the stored one: nothing is written.
    form.setFieldValue("title", "  Same  ");
    await binding.submit();
    expect(binding.status().phase).toBe("idle");
  });

  it("waits past a read sent before the save, for the commit's revision", async () => {
    const { binding, form } = recordForm();
    form.setFieldValue("title", "Edited");
    await binding.submit();
    // A read sent before the save answers after it: the old record, at
    // the revision the save was made against.
    binding.supply({ ...record });
    expect(binding.status().phase).toBe("syncing");
    binding.supply({ ...record, _rev: 4, title: "Edited" });
    expect(binding.status().phase).toBe("idle");
    expect(form.state.values).toMatchObject({ title: "Edited" });
  });
});

describe("a local form whose callback throws", () => {
  it("rejects its submit with a structured error carrying the callback's message", async () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    } as const;
    const binding = new FormBinding(
      { kind: "schema", schema },
      { name: "x" },
      {
        onSubmit: () => {
          throw new Error("The printer is out of paper.");
        },
      }
    );
    mounted(binding);
    const failure = await settle(binding.submit());
    expect(failure).toMatchObject({
      rejected: {
        code: "form.failed",
        category: "operational",
        message: "The printer is out of paper.",
      },
    });
  });
});

describe("an operation form's fields without a default", () => {
  it("shows the server's issue beside an argument the defaults left out", async () => {
    const binding = new FormBinding(
      {
        kind: "operation",
        args: api.notes.create.args,
        send: async () => {
          await Promise.resolve();
          throw new GraspError({
            code: "contract.invalid_args",
            message: "Invalid arguments.",
            category: "contract",
            retryable: false,
            requestId: "r",
            details: { issues: [{ message: "Too long.", path: ["body"] }] },
          });
        },
      },
      { title: "Only a title" },
      {}
    );
    mounted(binding);
    await settle(binding.submit());
    expect(binding.status()).toMatchObject({
      fieldIssues: { body: "Too long." },
      failure: undefined,
    });
  });
});
