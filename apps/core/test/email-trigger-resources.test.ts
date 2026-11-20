import {
  sha256Hex,
  sha256HexOfBytes,
  toBase64,
} from "@grasp-os/shared/encoding";
import {
  mailFromHeader,
  mailIngressPath,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  signMail,
} from "@grasp-os/shared/mail-ingress";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { runFileLimits } from "@grasp-os/shared/run-files";
import { inboundEmailMaxBytes } from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { revokePermission } from "../src/permissions.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { stampedMail } from "../src/workflows/mail-stamps.ts";
import { resultOf, runOf } from "../src/workflows/resource-runs.ts";
import { triggeredRunsPerHour } from "../src/workflows/runs.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  addedSince,
  attachment,
  deliver,
  definitionOf,
  emailTriggerFor,
  inputOf,
  invoiceMail,
  mapping,
  objectOf,
  own,
  runsOf,
  storedObjects,
} from "./email-triggers.ts";
import type { Person, Starting } from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { configuredLimits } from "./quota-limits.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// Independent workflows' email triggers (workflows/inbound-email.ts), from
// their threat model: mail reaches a trigger only through the signed
// ingress (or Email Routing), at its own address; a forged delivery, mail
// that may loop (sent automatically, from the deployment's own domain, or
// a run's own mail past its lineage's limits, or another kind of run's), an
// oversized message or one whose attachments would be kept, a sender
// writing someone else's address, a trigger whose creator lost access and
// the same message delivered twice each start nothing more than they
// should, and every refusal is audited.

const idp = mockIdp();

/**
 * A builder's workflow with an email trigger of theirs on it
 * (`emailTriggerFor`), signed in for this file.
 */
const emailTrigger = async (starting: Starting = {}) =>
  await emailTriggerFor(await signedInApi(idp, "builder"), starting);

/**
 * Core's database, with `first` run once, just before the first statement
 * whose query `at` matches is run: another writer getting there between
 * what core read before and that statement.
 */
const racedAt = (at: RegExp, first: () => Promise<unknown>): D1Database => {
  const real = env.DB;
  let raced = false;
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property, receiver) => {
        if (property === "bind") {
          return (...values: unknown[]) => racing(target.bind(...values));
        }
        if (
          property === "first" ||
          property === "all" ||
          property === "raw" ||
          property === "run"
        ) {
          return async (...args: unknown[]) => {
            await first();
            const run: unknown = Reflect.get(target, property, target);
            if (typeof run !== "function") {
              throw new TypeError(`No ${property} on a statement`);
            }
            const result: unknown = await Reflect.apply(run, target, args);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      if (raced || !at.test(query)) {
        return statement;
      }
      raced = true;
      return racing(statement);
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** How a test posts to the raw-mail ingress, when not as the router does. */
interface Posting {
  secret?: string;
  unsigned?: boolean;
  envelopeFrom?: string;
}

/**
 * Posts `raw` for `to` to core's raw-mail ingress, as the router's mail
 * sorter does: signed for its recipient, sender, hash, size and time.
 */
const post = async (
  to: string,
  raw: string,
  posting: Posting = {}
): Promise<Response> => {
  const bytes = new TextEncoder().encode(raw);
  const mail = {
    to,
    from: posting.envelopeFrom ?? "bounces@acme.test",
    sha256: await sha256HexOfBytes(bytes),
    size: bytes.byteLength,
    sentAt: new Date().toISOString(),
  };
  const signature = await signMail(posting.secret ?? env.ROUTER_SECRET, mail);
  return await worker.fetch(
    new Request(`https://core${mailIngressPath}`, {
      method: "POST",
      headers: {
        [routerSecretHeader]: env.ROUTER_SECRET,
        [mailToHeader]: mail.to,
        [mailFromHeader]: mail.from,
        [mailSha256Header]: mail.sha256,
        [mailSizeHeader]: String(mail.size),
        [mailSentAtHeader]: mail.sentAt,
        ...(posting.unsigned === true
          ? {}
          : { [mailSignatureHeader]: signature }),
      },
      body: raw,
    }),
    env,
    createExecutionContext()
  );
};

/** How many runs trigger `id` started. */
const runCount = async (id: string): Promise<number> => {
  const runs = await runsOf(id);
  return runs.length;
};

/** What the log holds of trigger `id`'s messages, refused or dropped, as `action`. */
const auditedOf = async (id: string, action: string) => {
  const logged = await allEvents();
  return logged
    .filter(({ action: was, target }) => was === action && target?.id === id)
    .map(({ detail }) => detail);
};

/** Why each of trigger `id`'s messages was refused, as audited. */
const refusalsOf = async (id: string) => {
  const refused = await auditedOf(id, "workflow.email.refused");
  return refused.map(({ code }) => code);
};

/**
 * Fills trigger `id`'s hourly room, but for `left` places: places taken by
 * events of their own this hour (trigger_hour_slots).
 */
const fillHour = async (id: string, left = 0): Promise<void> => {
  await env.DB.batch(
    Array.from({ length: triggeredRunsPerHour - left }, () =>
      env.DB.prepare(
        "INSERT INTO trigger_hour_slots (trigger_id, event_key, taken_at) VALUES (?, ?, ?)"
      ).bind(id, `filler-${unique()}`, Date.now())
    )
  );
};

/** A native mail connection in connect's registry, of `account`. */
const connection = async (account: string): Promise<string> => {
  const id = `connection-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, account_name, account_email, created_at, updated_at) VALUES (?, 'microsoft', 'shared', NULL, 'active', 'native', 'microsoft-365', '[]', ?, ?, ?, ?)"
    )
    .bind(id, account, account, now, now)
    .run();
  return id;
};

/**
 * The stamp run `run` puts on its
 * mail from `mailbox`, through `connectionId`, to `to`, as its step's call
 * records it (mail-stamps.ts).
 */
const stampOf = async (
  run: string,
  connectionId: string,
  mailbox: string,
  to: string
): Promise<string> => {
  const { stamp } = await stampedMail(
    env,
    { run, stepKey: `step-${unique()}` },
    {
      connectionId,
      action: "mail.send",
      input: { mailbox, to: [to], subject: "Again", body: "Again." },
    }
  );
  if (stamp === undefined) {
    throw new Error("Expected the mail stamped");
  }
  return stamp;
};

/** Run `runId`'s files, as core keeps them, oldest first. */
const runFilesOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, size, state FROM workflow_run_files WHERE run_id = ? ORDER BY created_at, name"
  )
    .bind(runId)
    .all<{
      id: string;
      name: string;
      type: string;
      size: number;
      state: string;
    }>();
  return results;
};

describe("independent workflows' email triggers", { timeout: 120_000 }, () => {
  it("start one run per message, mapped into its input and acting for the trigger's creator, however often it is delivered, at an address shown with the trigger", async () => {
    const { builder, workflow, trigger, address } = await emailTrigger();
    const message = invoiceMail({
      to: address,
      messageId: `m-${unique()}@acme.test`,
    });

    const first = await post(address, message);
    // Delivered again, with a hop's header added: the same message.
    const again = await post(
      address,
      `Received: from mx2.acme.test; Mon, 28 Sep 2026 08:00:02 +0000\r\n${message}`
    );
    // And once more through Email Routing.
    const routed = await deliver(address, message);
    const listed = await builder.api.workflowResources.triggers.list(workflow);
    const runs = await runsOf(trigger.id);
    const [file] = await runFilesOf(runs[0]?.id ?? "");

    expect({
      statuses: [first.status, again.status],
      routed: routed.rejected,
      // Random, its own: nothing of its ID in it.
      addressOwn:
        /^trigger-[0-9a-f]{32}$/u.test(trigger.address ?? "") &&
        !(trigger.address ?? "").includes(trigger.id),
      shown: listed.map(({ id, kind, address: at, config }) => ({
        id,
        kind,
        address: at,
        config,
      })),
      runs: runs.map(({ key, principal, input }) => ({
        key: /^grasp:email:[\w-]+:[0-9a-f]{64}$/u.test(key),
        principal,
        input: inputOf(input),
      })),
    }).toStrictEqual({
      statuses: [202, 202],
      routed: undefined,
      addressOwn: true,
      shown: [
        {
          id: trigger.id,
          kind: "email",
          address: trigger.address,
          config: { input: mapping },
        },
      ],
      runs: [
        {
          key: true,
          principal: builder.userId,
          // Never kept as a message: its attachment is a file of the run.
          input: {
            subject: "Invoice INV-7",
            from: "ben@acme.test",
            stored: null,
            attachments: [
              {
                filename: "inv-7.pdf",
                mimeType: "application/pdf",
                size: 5,
                file: { id: file?.id },
              },
            ],
          },
        },
      ],
    });
  });

  it("start nothing for a delivery that isn't signed by the router", async () => {
    const { trigger, address } = await emailTrigger();

    const forged = await post(address, invoiceMail({ to: address }), {
      secret: "not-the-router-secret",
    });
    const unsigned = await post(address, invoiceMail({ to: address }), {
      unsigned: true,
    });
    const runs = await runsOf(trigger.id);

    expect({
      statuses: [forged.status, unsigned.status],
      runs: runs.length,
    }).toStrictEqual({ statuses: [403, 403], runs: 0 });
  });

  it("bounce mail to a trigger that is turned off, deleted or doesn't exist, and to a look-alike of its address", async () => {
    const { builder, trigger, address } = await emailTrigger();
    const deleted = await emailTrigger();
    await builder.api.workflowResources.triggers.setEnabled(trigger.id, false);
    await deleted.builder.api.workflowResources.triggers.delete(
      deleted.trigger.id
    );
    const nobody = `trigger-${"0".repeat(32)}@${own}`;
    const lookAlike = address.replace("@", "x@");

    const responses = await Promise.all(
      [address, deleted.address, nobody, lookAlike].map(
        async (to) => await post(to, invoiceMail({ to }))
      )
    );
    const bodies = await Promise.all(
      responses.map(async (response) => await response.json())
    );

    expect({
      statuses: responses.map(({ status }) => status),
      bodies,
      runs: await runCount(trigger.id),
    }).toStrictEqual({
      statuses: [422, 422, 422, 422],
      bodies: Array.from({ length: 4 }, () => ({
        reason: "No such address.",
      })),
      runs: 0,
    });
  });

  it("start nothing for mail to an address made from the trigger's ID, which builders, admins and the audit log see", async () => {
    const { trigger, address } = await emailTrigger();

    const responses = await Promise.all(
      [`trigger-${trigger.id}@${own}`, `${trigger.id}@${own}`].map(
        async (to) => await post(to, invoiceMail({ to }))
      )
    );
    const logged = await allEvents();
    const mentioned = logged.filter(({ detail }) =>
      JSON.stringify(detail).includes(address.split("@")[0] ?? "")
    );

    expect({
      statuses: responses.map(({ status }) => status),
      runs: await runCount(trigger.id),
      addressAudited: mentioned.length,
    }).toStrictEqual({ statuses: [422, 422], runs: 0, addressAudited: 0 });
  });

  it("drop mail sent automatically or from the deployment's own domain, audited, never bounced, and take a forged From for untrusted data only", async () => {
    const { trigger, address } = await emailTrigger();

    const automatic = await post(
      address,
      invoiceMail({ to: address, headers: ["Auto-Submitted: auto-replied"] })
    );
    const ownFrom = await post(
      address,
      invoiceMail({ to: address, from: `Grasp <runs@${own}>` })
    );
    const ownEnvelope = await post(address, invoiceMail({ to: address }), {
      envelopeFrom: `bounces@${own}`,
    });
    // The client's CEO, written in by anyone: a root, the address only
    // what the run reads.
    const spoofed = await post(
      address,
      invoiceMail({ to: address, from: "CEO <ceo@acme.test>" })
    );
    const runs = await runsOf(trigger.id);
    const [file] = await runFilesOf(runs[0]?.id ?? "");

    expect({
      statuses: [automatic, ownFrom, ownEnvelope, spoofed].map(
        ({ status }) => status
      ),
      refused: await refusalsOf(trigger.id),
      runs: runs.map(({ depth, input }) => ({
        depth,
        input: inputOf(input),
      })),
    }).toStrictEqual({
      statuses: [202, 202, 202, 202],
      refused: ["auto_submitted", "own_domain", "own_domain"],
      runs: [
        {
          depth: 0,
          input: {
            subject: "Invoice INV-7",
            from: "ceo@acme.test",
            stored: null,
            attachments: [
              {
                filename: "inv-7.pdf",
                mimeType: "application/pdf",
                size: 5,
                file: { id: file?.id },
              },
            ],
          },
        },
      ],
    });
  });

  it("bounce a message over the size limit, and keep nothing of a message but its run's files", async () => {
    const { trigger, address } = await emailTrigger();
    const before = await storedObjects();

    const oversized = await deliver(
      address,
      invoiceMail({ to: address, text: "x".repeat(inboundEmailMaxBytes) })
    );
    const withAttachment = await deliver(address, invoiceMail({ to: address }));
    const after = await storedObjects();

    expect({
      oversized: oversized.rejected,
      withAttachment: withAttachment.rejected,
      runs: await runCount(trigger.id),
      kept: after.filter((object) => !before.includes(object)),
    }).toStrictEqual({
      oversized: "The message is too large.",
      withAttachment: undefined,
      runs: 1,
      kept: [],
    });
  });

  it("start nothing once the trigger's creator lost access or its grant is revoked, audited", async () => {
    const left = await emailTrigger();
    const revoked = await emailTrigger();
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(left.builder.userId)
      .run();
    await revokePermission(env, revoked.admin, revoked.start);

    const statuses = await Promise.all(
      [left, revoked].map(async ({ address }) => {
        const response = await post(address, invoiceMail({ to: address }));
        return response.status;
      })
    );

    expect({
      statuses,
      runs: [
        await runCount(left.trigger.id),
        await runCount(revoked.trigger.id),
      ],
      refused: [
        await refusalsOf(left.trigger.id),
        await refusalsOf(revoked.trigger.id),
      ],
    }).toStrictEqual({
      statuses: [202, 202],
      runs: [0, 0],
      refused: [["workflow.start_denied"], ["workflow.start_denied"]],
    });
  });

  it("join the lineage of the independent run whose mail it is, until the lineage's limit refuses it, audited", async () => {
    const { trigger, address } = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    env.TEST_QUOTA_LIMITS = { workflowNestingLevels: 3 };
    try {
      // Mail from outside: a root.
      await post(address, invoiceMail({ to: address }));
      // Each new run mails the trigger's address; its message carries the
      // run's stamp, from the run's mailbox.
      let mailed = 0;
      for (let hop = 0; hop < 5; hop += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        const runs = await runsOf(trigger.id);
        const last = runs.at(-1);
        if (last === undefined || runs.length === mailed) {
          break;
        }
        mailed = runs.length;
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        const stamp = await stampOf(last.id, shared, mailbox, address);
        // oxlint-disable-next-line no-await-in-loop -- one hop after another
        await post(
          address,
          invoiceMail({
            to: address,
            from: mailbox,
            messageId: `hop-${unique()}@acme.test`,
            headers: [`X-Grasp-Stamp: ${stamp}`],
          }),
          { envelopeFrom: mailbox }
        );
      }
    } finally {
      env.TEST_QUOTA_LIMITS = configuredLimits;
    }
    const runs = await runsOf(trigger.id);
    const [root] = runs;

    expect({
      depths: runs.map(({ depth }) => depth),
      oneLineage: runs.slice(2).every(({ root: of }) => of === runs[1]?.root),
      rootFirst: root?.depth,
      refused: await refusalsOf(trigger.id),
    }).toStrictEqual({
      // The root, then two levels under it: the third is past the limit.
      depths: [0, 1, 2],
      oneLineage: true,
      rootFirst: 0,
      refused: ["workflow.lineage_limit"],
    });
  });

  it("take a run's stamp only from that run's own sender, to the address it mailed", async () => {
    const { trigger, address } = await emailTrigger();
    const other = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    await post(address, invoiceMail({ to: address }));
    const [first] = await runsOf(trigger.id);
    const stamp = await stampOf(first?.id ?? "", shared, mailbox, address);
    const stamped = (to: string) =>
      invoiceMail({
        to,
        from: mailbox,
        messageId: `copy-${unique()}@acme.test`,
        headers: [`X-Grasp-Stamp: ${stamp}`],
      });

    // Its From written as the run's mailbox, sent from elsewhere.
    await post(address, stamped(address), { envelopeFrom: "eve@evil.test" });
    // The run's own mail, carried on to another trigger's address.
    await post(other.address, stamped(other.address), {
      envelopeFrom: mailbox,
    });
    const runs = await runsOf(trigger.id);
    const others = await runsOf(other.trigger.id);

    expect({
      depths: runs.map(({ depth }) => depth),
      others: others.map(({ depth }) => depth),
    }).toStrictEqual({ depths: [0, 0], others: [0] });
  });

  it("hold mail past the trigger's hourly limit, refusals and loop drops included, and drop it after a day, audited once", async () => {
    const { trigger, address } = await emailTrigger();
    await post(address, invoiceMail({ to: address }));
    await fillHour(trigger.id);
    const warned = vi.spyOn(console, "warn").mockReturnValue();
    const failed = vi.spyOn(console, "error").mockReturnValue();
    const late = invoiceMail({
      to: address,
      messageId: `late-${unique()}@acme.test`,
    });

    const over = await post(address, late);
    // Mail that would be dropped as a loop takes the hour's room too, so
    // it writes no audit row past it.
    const loop = await post(
      address,
      invoiceMail({ to: address, headers: ["Auto-Submitted: auto-replied"] })
    );
    // Held back for over a day, then delivered again: dropped, audited.
    await env.DB.prepare(
      "UPDATE connector_trigger_holds SET held_since = ? WHERE trigger_id = ?"
    )
      .bind(Date.now() - 25 * 60 * 60 * 1000, trigger.id)
      .run();
    const dropped = await post(address, late);
    const again = await post(address, late);
    warned.mockRestore();
    failed.mockRestore();
    const drops = await auditedOf(trigger.id, "workflow.email.dropped");

    expect({
      held: [over.status, loop.status].map((status) => status >= 500),
      dropped: [dropped.status, again.status],
      runs: await runCount(trigger.id),
      refused: await refusalsOf(trigger.id),
      drops: drops.map(({ reason }) => reason),
    }).toStrictEqual({
      held: [true, true],
      dropped: [202, 202],
      runs: 1,
      refused: [],
      drops: ["hourly_limit"],
    });
  });

  it("let a run's stamp claim only a few messages at the address, the rest roots", async () => {
    const { trigger, address } = await emailTrigger();
    const mailbox = `ops-${unique()}@acme.test`;
    const shared = await connection(mailbox);
    await post(address, invoiceMail({ to: address }));
    const [first] = await runsOf(trigger.id);
    const stamp = await stampOf(first?.id ?? "", shared, mailbox, address);

    for (let copy = 0; copy < 6; copy += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one copy after another
      await post(
        address,
        invoiceMail({
          to: address,
          from: mailbox,
          messageId: `copy-${copy}-${unique()}@acme.test`,
          headers: [`X-Grasp-Stamp: ${stamp}`],
        }),
        { envelopeFrom: mailbox }
      );
    }
    const runs = await runsOf(trigger.id);

    expect(
      runs.map(({ depth }) => depth).toSorted((a, b) => a - b)
    ).toStrictEqual([0, 0, 1, 1, 1, 1, 1]);
  });

  it("write no audit row for a message held back at the hourly limit, however often it is delivered again", async () => {
    const { workflow, trigger, address } = await emailTrigger();
    await fillHour(trigger.id);
    const warned = vi.spyOn(console, "warn").mockReturnValue();
    const about = async () => {
      const logged = await allEvents();
      return logged.filter(
        ({ target, detail }) =>
          target?.id === trigger.id ||
          target?.id === workflow ||
          JSON.stringify(detail).includes(trigger.id)
      ).length;
    };
    const before = await about();
    const held = invoiceMail({
      to: address,
      messageId: `held-${unique()}@acme.test`,
    });
    // One that may loop: refused for good, audited, given a place.
    const looping = invoiceMail({
      to: address,
      headers: ["Auto-Submitted: auto-replied"],
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const raw of [held, looping]) {
        // oxlint-disable-next-line no-await-in-loop -- one delivery after another
        const response = await post(address, raw);
        statuses.push(response.status);
      }
    }
    warned.mockRestore();

    expect({
      held: statuses.every((status) => status >= 500),
      written: (await about()) - before,
      runs: await runCount(trigger.id),
    }).toStrictEqual({ held: true, written: 0, runs: 0 });
  });

  it("let only one of two messages arriving at once take the hour's last place", async () => {
    const { trigger, address } = await emailTrigger();
    await fillHour(trigger.id, 1);
    const warned = vi.spyOn(console, "warn").mockReturnValue();

    const responses = await Promise.all(
      [`a-${unique()}`, `b-${unique()}`].map(
        async (id) =>
          await post(
            address,
            invoiceMail({ to: address, messageId: `${id}@acme.test` })
          )
      )
    );
    warned.mockRestore();

    expect({
      held: responses.filter(({ status }) => status >= 500).length,
      runs: await runCount(trigger.id),
    }).toStrictEqual({ held: 1, runs: 1 });
  });

  it("count a message's place only within its hour, so one delivered again later waits for room like any other", async () => {
    const { trigger, address } = await emailTrigger();
    const messageId = `late-${unique()}@acme.test`;
    const late = invoiceMail({ to: address, messageId });
    // Its place from two hours ago, as a delivery whose start failed then
    // left it, and a full hour since.
    await env.DB.prepare(
      "INSERT INTO trigger_hour_slots (trigger_id, event_key, taken_at) VALUES (?, ?, ?)"
    )
      .bind(
        trigger.id,
        await sha256Hex(`<${messageId}>`),
        Date.now() - 2 * 60 * 60 * 1000
      )
      .run();
    await fillHour(trigger.id);
    const warned = vi.spyOn(console, "warn").mockReturnValue();

    const full = await post(address, late);
    const runsWhileFull = await runCount(trigger.id);
    // A place frees up: it takes it, anew.
    await env.DB.prepare(
      "DELETE FROM trigger_hour_slots WHERE rowid = (SELECT rowid FROM trigger_hour_slots WHERE trigger_id = ? AND event_key LIKE 'filler-%' LIMIT 1)"
    )
      .bind(trigger.id)
      .run();
    const freed = await post(address, late);
    warned.mockRestore();

    expect({
      full: full.status >= 500,
      runsWhileFull,
      freed: freed.status,
      runs: await runCount(trigger.id),
    }).toStrictEqual({ full: true, runsWhileFull: 0, freed: 202, runs: 1 });
  });

  it("start a message on the version published as it starts, once, however often it comes", async () => {
    const { builder, workflow, trigger, address } = await emailTrigger();
    const message = invoiceMail({
      to: address,
      messageId: `published-${unique()}@acme.test`,
    });
    // Version 2 published after core read the live version, just as the
    // start checks what the trigger may do.
    const moving = racedAt(/trigger_resources AS live/u, async () => {
      await publishOverRpc(
        builder.api,
        workflow,
        definitionOf("args.subject.trim()")
      );
    });
    const raced = await outcome(
      deliver(address, message, { changes: { DB: moving } })
    );
    const again = await deliver(address, message);
    const versions = await env.DB.prepare(
      "SELECT workflow_resource_version AS version FROM workflow_start_receipts WHERE invoker_type = 'trigger' AND invoker_id = ?"
    )
      .bind(trigger.id)
      .all<{ version: number }>();

    expect({
      raced: raced === "ok",
      again: again.rejected,
      versions: versions.results.map(({ version }) => version),
      refused: await refusalsOf(trigger.id),
    }).toStrictEqual({
      // The live version as the start is admitted: the one published.
      raced: true,
      again: undefined,
      versions: [2],
      refused: [],
    });
  });
});

/** A PNG's bytes: its signature, then `size` bytes in all. */
const png = (size = 40): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

/** `value` as UTF-8 bytes. */
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** An attachment of a test's message: its bytes, and what its sender says of them. */
interface Part {
  type: string;
  name: string;
  bytes: Uint8Array;
  inline?: true;
}

/** A message from Ben to `to` with `parts` attached, as it goes over the wire. */
const mailWith = (to: string, parts: readonly Part[]): string =>
  [
    "From: Ben <ben@acme.test>",
    `To: ${to}`,
    `Message-ID: <m-${unique()}@acme.test>`,
    "Subject: Scans",
    "Date: Mon, 28 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Scans attached.",
    ...parts.flatMap(({ type, name, bytes, inline }) => [
      "--b",
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: ${inline === true ? "inline" : "attachment"}; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      toBase64(bytes),
    ]),
    "--b--",
    "",
  ].join("\r\n");

/** A workflow taking a message's attachments as each of `fields`. */
const takingAttachments = (fields: readonly string[]) => (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectOf(
      Object.fromEntries(
        fields.map((field) => [field, { kind: "array", item: attachment }])
      )
    ),
    returns: objectOf({ subject: { kind: "string" } }),
    result: { subject: "Read" },
    steps: [],
  });

/** A mapping of a message's attachments into each of `fields`. */
const attachmentsAs = (...fields: string[]) => ({
  fields: Object.fromEntries(fields.map((field) => [field, "/attachments"])),
  defaults: {},
});

/** What run `runId` returned, once it completed. */
const outputOf = async (runId: string): Promise<unknown> =>
  await vi.waitFor(
    async () => {
      const row = await runOf(env, runId);
      if (row?.status !== "completed") {
        throw new Error(`Run ${runId} is ${row?.status ?? "missing"}`);
      }
      const { result: output } = await resultOf(env, row);
      return output;
    },
    { timeout: 30_000, interval: 100 }
  );

/** Whether each attachment of a run's input is a file of the run. */
const filedOf = (input: string | null): boolean[] =>
  z
    .object({
      attachments: z.array(z.object({ file: z.unknown().optional() })),
    })
    .parse(inputOf(input))
    .attachments.map(({ file }) => file !== undefined);

/** A workflow of `builder`'s, published, to put a trigger on. */
const publishedWorkflow = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.workflowResources.create(
    `named-${unique()}`
  );
  await publishOverRpc(builder.api, id, definitionOf());
  return id;
};

/** An email trigger on `workflow` for `builder`, at `address` if named. */
const createEmailTrigger = async (
  builder: Person,
  workflow: string,
  address?: string
) =>
  await builder.api.workflowResources.triggers.create({
    kind: "email",
    workflowId: workflow,
    config: {
      input: mapping,
      ...(address === undefined ? {} : { address }),
    },
  });

/** How many live triggers receive at `address`. */
const holdersOf = async (address: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM trigger_resources WHERE email_address = ? AND deleted_at IS NULL"
  )
    .bind(address)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

describe(
  "names chosen for independent workflows' email triggers",
  { timeout: 120_000 },
  () => {
    it("receive mail at the name their builder chose, which starts the run, audited with the trigger", async () => {
      const name = `invoices-${unique()}`;
      const { trigger, address } = await emailTrigger({ address: name });

      const delivered = await post(
        address,
        invoiceMail({ to: address, messageId: `m-${unique()}@acme.test` })
      );
      const runs = await runsOf(trigger.id);
      const created = await auditedOf(trigger.id, "trigger.created");

      expect({
        address: trigger.address,
        status: delivered.status,
        runs: runs.map(({ input }) => inputOf(input)),
        created: created.map((detail) => detail.address),
      }).toMatchObject({
        address: name,
        status: 202,
        runs: [{ subject: "Invoice INV-7", from: "ben@acme.test" }],
        created: [name],
      });
    });

    it("refuse a name another trigger receives at, or that isn't one; and free it once its trigger is deleted", async () => {
      const name = `intake-${unique()}`;
      const first = await emailTrigger({ address: name });
      const random = await emailTrigger();
      const other = await signedInApi(idp, "builder");
      const workflow = await publishedWorkflow(other);

      const outcomes = {
        trigger: await outcome(createEmailTrigger(other, workflow, name)),
        copied: await outcome(
          createEmailTrigger(other, workflow, random.trigger.address ?? "")
        ),
        notAName: await outcome(createEmailTrigger(other, workflow, "In@x")),
      };
      await first.builder.api.workflowResources.triggers.delete(
        first.trigger.id
      );
      const taken = await createEmailTrigger(other, workflow, name);

      expect({ outcomes, after: taken.address }).toStrictEqual({
        outcomes: {
          trigger: "workflow.email_taken",
          copied: "workflow.email_taken",
          notAName: "workflow.resource_invalid",
        },
        after: name,
      });
    });

    it("go to one of two triggers taking a name at once", async () => {
      const name = `both-${unique()}`;
      const builder = await signedInApi(idp, "builder");
      const workflow = await publishedWorkflow(builder);

      const results = await Promise.all([
        outcome(createEmailTrigger(builder, workflow, name)),
        outcome(createEmailTrigger(builder, workflow, name)),
      ]);

      expect({
        results: results.toSorted(),
        holders: await holdersOf(name),
      }).toStrictEqual({
        results: ["ok", "workflow.email_taken"],
        holders: 1,
      });
    });

    it("refuse a name another trigger took after the trigger checked it was free, before its batch landed", async () => {
      const builder = await signedInApi(idp, "builder");
      const workflow = await publishedWorkflow(builder);
      const byTrigger = `raced-${unique()}`;
      // Someone takes the name just before the trigger's batch lands.
      const racedBy = async (name: string, take: () => Promise<unknown>) =>
        await outcome(
          createTriggerResource(
            {
              ...env,
              DB: racingDb(take, /insert into "trigger_resources"/iu),
            },
            await builder.api.whoami(),
            {
              kind: "email",
              workflowId: workflow,
              config: { input: mapping, address: name },
            }
          )
        );

      const refused = await racedBy(
        byTrigger,
        async () =>
          await env.DB.prepare(
            "INSERT INTO trigger_resources (id, owner_id, kind, current_version, enabled, created_at, email_address) VALUES (?, ?, 'email', 1, 1, ?, ?)"
          )
            .bind(crypto.randomUUID(), builder.userId, Date.now(), byTrigger)
            .run()
      );

      expect({ refused, holders: await holdersOf(byTrigger) }).toStrictEqual({
        refused: "workflow.email_taken",
        // The one trigger that got there first.
        holders: 1,
      });
    });
  }
);

describe(
  "attachments of mail to independent workflows' email triggers",
  { timeout: 120_000 },
  () => {
    it("are files of the run they start, named in its input by reference, each copied and audited once however often the message comes", async () => {
      const { trigger, workflow, address } = await emailTrigger({
        definition: takingAttachments(["attachments"]),
        input: attachmentsAs("attachments"),
      });
      const before = await storedObjects();
      const message = invoiceMail({
        to: address,
        messageId: `m-${unique()}@acme.test`,
      });

      const first = await deliver(address, message);
      const again = await deliver(address, message);
      const runs = await runsOf(trigger.id);
      const run = runs[0]?.id ?? "";
      await outputOf(run);
      const files = await runFilesOf(run);

      expect({
        delivered: [first.rejected, again.rejected],
        runs: runs.length,
        input: inputOf(runs[0]?.input ?? null),
        files: files.map(({ name, type, size, state }) => ({
          name,
          type,
          size,
          state,
        })),
        sent: await auditedOf(trigger.id, "workflow.email.attachment.sent"),
        // Nothing waits in R2 once its start is decided.
        left: await addedSince(before),
      }).toStrictEqual({
        delivered: [undefined, undefined],
        runs: 1,
        // The message names the run's own copy, by the same shape.
        input: {
          attachments: [
            {
              filename: "inv-7.pdf",
              mimeType: "application/pdf",
              size: 5,
              file: { id: files[0]?.id },
            },
          ],
        },
        files: [
          {
            name: "inv-7.pdf",
            type: "application/pdf",
            size: 5,
            state: "done",
          },
        ],
        // Never its name.
        sent: [
          {
            message: await sha256HexOfBytes(new TextEncoder().encode(message)),
            attachment: "attachment-0",
            workflow,
            run,
            type: "application/pdf",
            size: 5,
          },
        ],
        left: [],
      });
    });

    it("are files only when a run file may be one, by its bytes and never its label: not an unknown type, a lying label, text that isn't UTF-8 or an inline one", async () => {
      const { trigger, address } = await emailTrigger();

      const delivered = await deliver(
        address,
        mailWith(address, [
          // A PNG said to be anything: a PNG.
          { type: "application/octet-stream", name: "scan.bin", bytes: png() },
          { type: "application/pdf", name: "fake.pdf", bytes: utf8("no pdf") },
          {
            type: "application/zip",
            name: "a.zip",
            bytes: new Uint8Array([0, 1, 2]),
          },
          {
            type: "text/plain",
            name: "bad.txt",
            bytes: new Uint8Array([0xff, 0xfe, 0x41]),
          },
          { type: "image/png", name: "logo.png", bytes: png(), inline: true },
          { type: "text/csv", name: "totals.csv", bytes: utf8("a,b\r\n1,2") },
        ])
      );
      const [run] = await runsOf(trigger.id);
      await outputOf(run?.id ?? "");
      const files = await runFilesOf(run?.id ?? "");

      expect({
        delivered: delivered.rejected,
        filed: filedOf(run?.input ?? null),
        files: files.map(({ name, type }) => ({ name, type })),
      }).toStrictEqual({
        delivered: undefined,
        filed: [true, false, false, false, false, true],
        files: [
          { name: "scan.bin", type: "image/png" },
          { name: "totals.csv", type: "text/csv" },
        ],
      });
    });

    it("are files for at most as many as a start hands its run, and a mapping handing it more is refused for good, audited", async () => {
      const many = Array.from(
        { length: runFileLimits.startFiles + 2 },
        (_, at) => ({
          type: "application/pdf",
          name: `inv-${String(at)}.pdf`,
          bytes: utf8("%PDF-"),
        })
      );
      const once = await emailTrigger();
      const twice = await emailTrigger({
        definition: takingAttachments(["attachments", "again"]),
        input: attachmentsAs("attachments", "again"),
      });

      const first = await deliver(once.address, mailWith(once.address, many));
      const second = await deliver(
        twice.address,
        mailWith(twice.address, many)
      );
      const [run] = await runsOf(once.trigger.id);
      await outputOf(run?.id ?? "");
      const files = await runFilesOf(run?.id ?? "");

      expect({
        delivered: [first.rejected, second.rejected],
        filed: filedOf(run?.input ?? null),
        files: files.length,
        refused: await runCount(twice.trigger.id),
        codes: await refusalsOf(twice.trigger.id),
      }).toStrictEqual({
        delivered: [undefined, undefined],
        filed: many.map((_, at) => at < runFileLimits.startFiles),
        files: runFileLimits.startFiles,
        refused: 0,
        codes: ["file.start_files"],
      });
    });

    it("past the workflow's room for run files refuse their message for good, audited, keeping no copy", async () => {
      const { trigger, workflow, address } = await emailTrigger();
      // The workflow's other runs hold all of its room but four bytes.
      await env.DB.prepare(
        "INSERT INTO workflow_run_files (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at) VALUES (?, ?, ?, 'test', ?, 'big.pdf', 'application/pdf', ?, 'done', ?)"
      )
        .bind(
          crypto.randomUUID(),
          crypto.randomUUID(),
          workflow,
          unique(),
          runFileLimits.workflowBytes - 4,
          Date.now()
        )
        .run();
      const before = await storedObjects();

      const delivered = await deliver(address, invoiceMail({ to: address }));
      const again = await deliver(address, invoiceMail({ to: address }));
      const { results: copies } = await env.DB.prepare(
        "SELECT state FROM workflow_run_files WHERE workflow_resource_id = ? AND name = 'inv-7.pdf'"
      )
        .bind(workflow)
        .all<{ state: string }>();

      expect({
        delivered: [delivered.rejected, again.rejected],
        runs: await runCount(trigger.id),
        codes: await refusalsOf(trigger.id),
        copies: copies.map(({ state }) => state),
        left: await addedSince(before),
      }).toStrictEqual({
        delivered: [undefined, undefined],
        runs: 0,
        // Once: the message delivered again is settled already.
        codes: ["file.workflow_quota"],
        copies: [],
        left: [],
      });
    });

    it("are no one else's by their reference: a start by hand naming one is refused", async () => {
      const { builder, workflow } = await emailTrigger();

      const refused = await outcome(
        builder.api.workflowResources.start(workflow, {
          expected: 1,
          args: {
            subject: "Invoice",
            from: "ben@acme.test",
            stored: null,
            attachments: [
              {
                filename: "inv-7.pdf",
                mimeType: "application/pdf",
                size: 5,
                file: { id: "attachment-0" },
              },
            ],
          },
          key: unique(),
        })
      );

      expect(refused).toBe("file.start_files");
    });
  }
);
