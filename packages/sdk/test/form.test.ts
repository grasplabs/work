import { FormApi } from "@tanstack/react-form";
import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import type { ClientTransport } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import { bindForm } from "../src/form.ts";
import type { FormApiOf, FormBinding, FormOptionsInput } from "../src/form.ts";
import type { Id } from "../src/index.ts";
import { api } from "./notes/.grasp/references.ts";

// A form's submission state through the real session client, against the
// network it reaches the host through: an outcome it can't tell, given up
// only by the person, and never sent again as anyone else; server issues
// where they belong; records the parent supplies, adopted while the draft
// holds what the record holds; and its callback's own failures.

/** What the host answers one call: core's `{ result }`, a refusal, or nothing. */
type Answer =
  | { readonly value: unknown }
  | {
      readonly failed: string;
      readonly category?: string;
      readonly details?: unknown;
    }
  | { readonly refused: string }
  | "lost";

/** One request the host was sent, as the client wrote it. */
interface Sent {
  readonly contractId: string;
  readonly input: unknown;
  readonly idempotencyKey: string | undefined;
}

/** What `body` names: its function, input and key. */
const sentOf = (body: string): Sent => {
  const parsed: unknown = JSON.parse(body);
  const read = (key: string): unknown =>
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, key)
      : undefined;
  const reference = read("reference");
  const contractId: unknown =
    typeof reference === "object" && reference !== null
      ? Reflect.get(reference, "contractId")
      : undefined;
  const key = read("idempotencyKey");
  return {
    contractId: typeof contractId === "string" ? contractId : "",
    input: read("input"),
    idempotencyKey: typeof key === "string" ? key : undefined,
  };
};

/**
 * A session client over the page's transport, the host answering each call
 * as `answer` says; and every request sent, in order.
 */
const host = (answer: (sent: Sent) => Answer | Promise<Answer>) => {
  const sent: Sent[] = [];
  const transport: ClientTransport = {
    call: async (request) => {
      const call = sentOf(request);
      sent.push(call);
      const answered = await answer(call);
      if (answered === "lost") {
        throw new Error("The connection was reset.");
      }
      if ("refused" in answered) {
        throw Object.assign(new Error(answered.refused), {
          code: answered.refused,
        });
      }
      if ("failed" in answered) {
        return {
          result: {
            ok: false,
            error: {
              code: answered.failed,
              message: answered.failed,
              category: answered.category ?? "domain",
              retryable: false,
              requestId: "r",
              ...(answered.details === undefined
                ? {}
                : { details: answered.details }),
            },
          },
        };
      }
      return { result: { ok: true, value: answered.value } };
    },
  };
  return { client: new GraspClient(transport), sent };
};

/** A form of `target` through `client`, connected to a TanStack form as `useForm` does. */
const formOf = (
  client: GraspClient,
  target: unknown,
  options: FormOptionsInput
) => {
  const binding: FormBinding = bindForm(client, target, options);
  const form = new FormApi({
    defaultValues: binding.initialValues,
    validators: {
      onChange: binding.validate,
      onSubmit: binding.validate,
    },
  });
  form.mount();
  // SAFETY: the binding reads the form's values, validation and reset,
  // which a plain FormApi has; the React parts it never touches here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  binding.attach(form as unknown as FormApiOf<Record<string, unknown>>);
  return { binding, form };
};

/** Why `promise` rejected, or that it resolved. */
const settle = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
};

/** Resolves once the loop's queued turns have run. */
const turns = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 0);
  await promise;
};

/** A local form's schema: whatever it is given, as it was given. */
const anything = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const noteId =
  // SAFETY: the form of the store's IDs; nothing here reads it further.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  "01890000-0000-7000-8000-000000000001" as Id<"notes">;

describe("a form whose submission's outcome is unknown", () => {
  it("locks its fields and sends it again under the client's key, until the person discards it", async () => {
    // An action's answers are lost twice: its outcome is unknown each time.
    const { client, sent } = host(({ contractId }) =>
      contractId === "notes.tally" && sent.length <= 2 ? "lost" : { value: 3 }
    );
    const { binding } = formOf(client, api.notes.tally, { defaultValues: {} });

    await settle(binding.submit());
    expect(binding.status()).toMatchObject({
      phase: "uncertain",
      locked: true,
    });
    // Asking again sends the same submission, under the key the client
    // picked for it.
    await settle(binding.submit());
    expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);

    // Given up, knowingly: the fields unlock and the next is new.
    binding.discard();
    expect(binding.status()).toMatchObject({ phase: "idle", locked: false });
    await expect(binding.submit()).resolves.toBe(3);
    expect(sent[2]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
  });

  it("never sends it again once access was lost since, whoever signs in next", async () => {
    let signedOut = false;
    const { client, sent } = host(({ contractId }) => {
      if (contractId === "notes.get") {
        return signedOut
          ? { refused: "auth.unauthenticated" }
          : { value: null };
      }
      return sent.length === 1 ? "lost" : { value: 3 };
    });
    const { binding } = formOf(client, api.notes.tally, { defaultValues: {} });
    await settle(binding.submit());
    // The person's session ended, and someone signs in again.
    signedOut = true;
    await settle(client.query(api.notes.get, { id: noteId }));
    signedOut = false;

    const actions = () =>
      sent.filter(({ contractId }) => contractId === "notes.tally").length;
    const refused = await settle(binding.submit());
    expect({ refused, actions: actions() }).toMatchObject({
      refused: { rejected: { code: "auth.principal_changed" } },
      actions: 1,
    });
    expect(binding.status()).toMatchObject({ phase: "idle", locked: false });
    // The next submit is a submission of its own, under a key of its own.
    await expect(binding.submit()).resolves.toBe(3);
    expect(sent.at(-1)?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
  });

  it("never sends it as whoever signs in after the resend that found the sign-out", async () => {
    let signedOut = false;
    const { client, sent } = host(() => {
      if (sent.length === 1) {
        return "lost";
      }
      return signedOut ? { refused: "auth.unauthenticated" } : { value: 3 };
    });
    const { binding } = formOf(client, api.notes.tally, { defaultValues: {} });
    await settle(binding.submit());
    // The resend finds the session ended: refused before it ran, so the
    // form keeps it, unknown as it was.
    signedOut = true;
    await settle(binding.submit());
    const found = binding.status();
    // Someone signs in: what the form kept is never sent as them.
    signedOut = false;
    const refused = await settle(binding.submit());
    expect({
      found: { phase: found.phase, locked: found.locked },
      refused,
      sent: sent.length,
      after: binding.status().phase,
    }).toMatchObject({
      found: { phase: "uncertain", locked: true },
      refused: { rejected: { code: "auth.principal_changed" } },
      sent: 2,
      after: "idle",
    });
  });

  it.each([
    "operation.sandbox_busy",
    "operation.sandbox_unavailable",
    "mutation.concurrent_change",
    "submission.superseded",
  ])(
    "never sends it as whoever signs in after a resend refused with %s",
    async (code) => {
      let signedOut = false;
      const { client, sent } = host(({ contractId }) => {
        if (contractId === "notes.get") {
          return signedOut
            ? { refused: "auth.unauthenticated" }
            : { value: null };
        }
        if (sent.length === 1) {
          return "lost";
        }
        return sent.filter((call) => call.contractId === "notes.tally")
          .length === 2
          ? { failed: code, category: "operational" }
          : { value: 3 };
      });
      const { binding } = formOf(client, api.notes.tally, {
        defaultValues: {},
      });
      await settle(binding.submit());
      // The resend may not have run: the form keeps it, key and all.
      await settle(binding.submit());
      const kept = binding.status().phase;
      // A's session ends, and B signs in and submits.
      signedOut = true;
      await settle(client.query(api.notes.get, { id: noteId }));
      signedOut = false;
      const refused = await settle(binding.submit());
      expect({
        kept,
        refused,
        actions: sent.filter((call) => call.contractId === "notes.tally")
          .length,
      }).toMatchObject({
        kept: "uncertain",
        refused: { rejected: { code: "auth.principal_changed" } },
        actions: 2,
      });
    }
  );

  it("sends it again under its key after a resend refused before it ran, never anew", async () => {
    const { client, sent } = host(() => {
      if (sent.length === 1) {
        return "lost";
      }
      // The host has no token to give for a moment: nothing ran.
      return sent.length === 2
        ? { refused: "auth.token_unavailable" }
        : { value: 3 };
    });
    const { binding } = formOf(client, api.notes.tally, { defaultValues: {} });
    await settle(binding.submit());
    await settle(binding.submit());
    const refused = binding.status();
    await expect(binding.submit()).resolves.toBe(3);
    expect({
      refused: { phase: refused.phase, locked: refused.locked },
      keys: new Set(sent.map(({ idempotencyKey }) => idempotencyKey)).size,
    }).toStrictEqual({
      refused: { phase: "uncertain", locked: true },
      keys: 1,
    });
  });

  it("never discards a submission still in flight", async () => {
    const { promise: held, resolve } = Promise.withResolvers<null>();
    const { client } = host(async () => {
      await held;
      return { value: noteId };
    });
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: "Held", body: "" },
    });
    const submitting = binding.submit();
    await expect.poll(() => binding.status().phase).toBe("submitting");
    binding.discard();
    expect(binding.status()).toMatchObject({
      phase: "submitting",
      locked: true,
    });
    resolve(null);
    await expect(submitting).resolves.toBe(noteId);
  });
});

describe("a form's issues", () => {
  it("rejects values that don't pass with the issues found, sending nothing", async () => {
    const { client, sent } = host(() => ({ value: noteId }));
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: 5, body: "" },
    });
    await expect(settle(binding.submit())).resolves.toMatchObject({
      rejected: {
        code: "contract.invalid_args",
        details: { issues: [{ path: ["title"] }] },
      },
    });
    expect(sent).toHaveLength(0);
  });

  it("shows the server's issue beside an argument the defaults left out, and clears it once a save goes through", async () => {
    const { client, sent } = host(() =>
      sent.length === 1
        ? {
            failed: "contract.invalid_args",
            category: "contract",
            details: { issues: [{ message: "Too long.", path: ["body"] }] },
          }
        : { value: noteId }
    );
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: "Only a title" },
    });
    await settle(binding.submit());
    expect(binding.status()).toMatchObject({
      fieldIssues: { body: "Too long." },
      failure: undefined,
    });
    await binding.submit();
    expect(binding.status().fieldIssues).toStrictEqual({});
  });

  it("names an array item's field as TanStack does, so the issue shows beside it", async () => {
    const { client } = host(() => ({ value: null }));
    const { binding } = formOf(client, anything, {
      defaultValues: { items: [{ name: "" }] },
      onSubmit: () => {
        throw new GraspError({
          code: "contract.invalid_args",
          message: "Invalid arguments.",
          category: "contract",
          retryable: false,
          requestId: null,
          details: {
            issues: [{ message: "Name it.", path: ["items", 0, "name"] }],
          },
        });
      },
    });
    await settle(binding.submit());
    expect(binding.status().fieldIssues).toStrictEqual({
      "items[0].name": "Name it.",
    });
  });
});

describe("a record form and the records it is supplied", () => {
  const record = { _id: noteId, _rev: 3, title: "Before", body: "" };

  /** A record form over `record`, its title edited and saved, the host answering the save with `answer`. */
  const saved = async (answer: () => unknown) => {
    const { client } = host(() => ({ value: answer() }));
    const { binding, form } = formOf(client, api.notes.update, {
      record,
      fields: ["title", "body"],
      args: () => ({ id: record._id, expectedRevision: record._rev }),
    });
    form.setFieldValue("title", "Edited");
    const outcome = await settle(binding.submit());
    return { binding, form, outcome };
  };

  /** The committed record, as `notes.update` answers it. */
  const committed = () => ({ ...record, _rev: 4, title: "Edited" });

  it("adopts a newer record while the draft holds what the record does, in whatever order", () => {
    const { client } = host(() => ({ value: null }));
    const withMeta = { ...record, meta: { color: "blue", size: 2 } };
    const { binding, form } = formOf(client, api.notes.update, {
      record: withMeta,
      fields: ["title", "meta"],
      args: () => ({ id: record._id, expectedRevision: record._rev }),
    });
    // The same value, its keys in another order: no edit.
    form.setFieldValue("meta", { size: 2, color: "blue" });
    binding.supply({ ...withMeta, _rev: 4, title: "Second" });
    expect(binding.status().newer).toBeFalsy();
    expect(form.state.values).toMatchObject({ title: "Second" });
  });

  it("refuses an answer that isn't the record, keeping the values and adopting nothing", async () => {
    const { binding, form, outcome } = await saved(() => record._id);
    expect(outcome).toMatchObject({
      rejected: { code: "contract.invalid_result" },
    });
    expect(binding.status()).toMatchObject({
      phase: "idle",
      failure: { code: "contract.invalid_result" },
    });
    expect(form.state.values).toMatchObject({ title: "Edited" });
  });

  it("adopts nothing, without failing, when a delete-style save answers null", async () => {
    const { binding, form, outcome } = await saved(() => null);
    expect(outcome).toStrictEqual({ resolved: null });
    expect(binding.status()).toMatchObject({
      phase: "idle",
      failure: undefined,
    });
    expect(form.state.values).toMatchObject({ title: "Edited" });
  });

  it("adopts the committed record, then a newer revision with no edits since", async () => {
    const { binding, form } = await saved(committed);
    binding.supply({ ...committed(), _rev: 5, body: "Set too" });
    expect(binding.status()).toMatchObject({ phase: "idle", newer: false });
    expect(form.state.values).toMatchObject({ body: "Set too" });
  });

  it("keeps edits made since over a newer revision, saying one came", async () => {
    const { binding, form } = await saved(committed);
    form.setFieldValue("title", "Edited again");
    binding.supply({ ...committed(), _rev: 5 });
    expect(binding.status()).toMatchObject({ newer: true });
    expect(form.state.values).toMatchObject({ title: "Edited again" });
  });

  it("ignores a read sent before the save that answers after it", async () => {
    const { binding, form } = await saved(committed);
    binding.supply({ ...record });
    expect(binding.status()).toMatchObject({ newer: false });
    expect(form.state.values).toMatchObject({ title: "Edited" });
  });
});

describe("a form's callbacks", () => {
  it("rejects a local form's submit with a structured error carrying its callback's message", async () => {
    const { client } = host(() => ({ value: null }));
    const { binding } = formOf(client, anything, {
      defaultValues: { name: "x" },
      onSubmit: () => {
        throw new Error("The printer is out of paper.");
      },
    });
    await expect(settle(binding.submit())).resolves.toMatchObject({
      rejected: {
        code: "form.failed",
        category: "operational",
        message: "The printer is out of paper.",
      },
    });
  });

  it("reports what onSuccess threw after a save went through, apart from the save", async () => {
    const { client } = host(() => ({ value: noteId }));
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: "Saved", body: "" },
      onSuccess: () => {
        throw new Error("Couldn't open the note.");
      },
    });
    await expect(binding.submit()).resolves.toBe(noteId);
    await turns();
    expect(binding.status()).toMatchObject({
      phase: "idle",
      failure: undefined,
      applicationError: "Couldn't open the note.",
    });
  });

  it("runs onSuccess only while the form is mounted", async () => {
    let succeeded = 0;
    const { client } = host(() => ({ value: noteId }));
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: "Saved", body: "" },
      onSuccess: () => {
        succeeded += 1;
      },
    });
    await binding.submit();
    binding.setMounted(false);
    await binding.submit();
    await turns();
    expect(succeeded).toBe(1);
  });

  it("never lets an onSuccess that fails late speak over a later submission that went through", async () => {
    const { promise: firstCallback, reject } = Promise.withResolvers<null>();
    const callbacks = [
      async () => {
        await firstCallback;
      },
      async () => {
        await Promise.resolve();
      },
    ];
    const { client } = host(() => ({ value: noteId }));
    const { binding } = formOf(client, api.notes.create, {
      defaultValues: { title: "Twice", body: "" },
      onSuccess: async () => {
        await callbacks.shift()?.();
      },
    });
    await binding.submit();
    await binding.submit();
    reject(new Error("The first one's follow-up failed."));
    await turns();
    expect(binding.status().applicationError).toBeUndefined();
  });
});
