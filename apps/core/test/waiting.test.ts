import type { WaitingFeed, WaitingKind } from "@grasp-os/shared/waiting";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { chatOf, codeStep, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { asking, week } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// What waits on a person, in one feed (waiting-rpc.ts). Its threat model
// comes first: an item reaches someone it doesn't wait on (another
// person's held write, a permission request for someone who can't grant
// it); a verdict given through the feed reaches past the checks of its
// kind's own call, or skips its record; reading the feed changes what it
// reads (marks failures read); a verdict that isn't one is taken.

const idp = mockIdp();

/** Signing people in, chats and runs can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/** The feed's items of `kind`, for `person`. */
const itemsOf = async <Kind extends WaitingKind>(
  person: Person,
  kind: Kind
): Promise<Extract<WaitingFeed["items"][number], { kind: Kind }>[]> => {
  const { items } = await person.api.waiting.list();
  return items.filter(
    (item): item is Extract<WaitingFeed["items"][number], { kind: Kind }> =>
      item.kind === kind
  );
};

/** The feed's request for `permission`, if it lists one for `person`. */
const requestsOf = async (person: Person, permission: string) => {
  const requests = await itemsOf(person, "permissionRequest");
  return requests.filter(({ request }) => request.id === permission);
};

/** A chat of `person`'s whose agent, granted mail, holds a mail for them to approve. */
const heldMail = async (person: Person, admin: Person) => {
  const mail = await mailConnection([], mailWithSearch);
  const chat = await chatOf(
    person.userId,
    codeStep(
      `export default async (self, env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)});`
    ),
    says("It waits for you to approve it.")
  );
  const { id } = await admin.api.permissions.request({
    subject: chat.agent,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send", "mail.search"],
    binding: "MAIL",
  });
  return { mail, chat, permission: id };
};

/** A workflow that fails in its one step. */
const failing = workflowFiles(
  "nightly",
  `  await step.do("check", { description: "Check" }, async () => {
    throw new Error("Customer c-1 is blocked");
  });`,
  { check: null }
);

describe("what waits", slow, () => {
  afterEach(endLiveRuns);

  it("holds a person's write for them alone, and runs it once on their approval through the feed", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { mail, chat, permission } = await heldMail(person, admin);
    await admin.api.waiting.settle({
      kind: "permissionRequest",
      id: permission,
      verdict: "grant",
      reviewed: { version: null },
    });
    await chat.ask("Send Ben the invoice.");

    const [held, ...others] = await itemsOf(person, "heldWrite");
    expect({
      kind: held?.kind,
      urgent: held?.urgent,
      waitsOn: held?.waitsOn,
      verdicts: held?.verdicts,
      input: held?.action.input,
      others: others.length,
      admin: await itemsOf(admin, "heldWrite"),
    }).toStrictEqual({
      kind: "heldWrite",
      urgent: true,
      waitsOn: { type: "person", userId: person.userId },
      verdicts: ["approve", "decline"],
      input: JSON.stringify(invoiceMail),
      others: 0,
      admin: [],
    });

    const id = held?.action.id ?? "";
    const inputHash = held?.action.inputHash ?? "";
    // Someone else's verdict is refused as their own call refuses it.
    await expect(
      outcome(
        admin.api.waiting.settle({ kind: "heldWrite", id, verdict: "decline" })
      )
    ).resolves.toBe("connect.pending_not_found");
    await person.api.waiting.settle({
      kind: "heldWrite",
      id,
      verdict: "approve",
      inputHash,
    });
    await expect(
      outcome(
        person.api.waiting.settle({
          kind: "heldWrite",
          id,
          verdict: "approve",
          inputHash,
        })
      )
    ).resolves.toBe("connect.pending_not_found");
    expect({
      waiting: await itemsOf(person, "heldWrite"),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [],
      sent: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("puts a permission request before the organization's own admins alone, and grants it through the feed, recorded", async () => {
    const member = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const { permission } = await heldMail(member, admin);

    const [request] = await requestsOf(admin, permission);
    expect({
      waitsOn: request?.waitsOn,
      verdicts: request?.verdicts,
      reviewedVersion: request?.reviewedVersion,
      // A builder lists permissions, but can't grant them: none waits on them.
      builder: await itemsOf(builder, "permissionRequest"),
      member: await itemsOf(member, "permissionRequest"),
    }).toStrictEqual({
      waitsOn: { type: "admin" },
      verdicts: ["grant", "reject"],
      reviewedVersion: null,
      builder: [],
      member: [],
    });

    const grant = {
      kind: "permissionRequest",
      id: permission,
      verdict: "grant",
      reviewed: { version: null },
    } as const;
    await expect(outcome(builder.api.waiting.settle(grant))).resolves.toBe(
      "role.forbidden"
    );
    await admin.api.waiting.settle(grant);

    const [events, permissions] = await Promise.all([
      allEvents(),
      admin.api.permissions.list(),
    ]);
    expect({
      status: permissions.find(({ id }) => id === permission)?.status,
      waiting: await requestsOf(admin, permission),
      by: events
        .filter(
          ({ action, target }) =>
            action === "permission.granted" && target?.id === permission
        )
        .map(({ actor }) => actor),
    }).toStrictEqual({
      status: "active",
      waiting: [],
      by: [{ type: "person", userId: admin.userId }],
    });
  });

  it("lists a failed run for the person it acted for, without marking it read", async () => {
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const app = await appWith(builder, failing);
    const run = await builder.api.workflows.start(app, "nightly");
    await finished(run.id);

    // Core records the failure once the engine tells it (runs.ts).
    const failed = await vi.waitFor(
      async () => {
        const items = await itemsOf(builder, "failedRun");
        expect(items).toHaveLength(1);
        return items;
      },
      { timeout: 20_000, interval: 100 }
    );
    const { notifications, unread } = await builder.api.notifications.list();
    expect({
      run: failed[0]?.notification.run,
      waitsOn: failed[0]?.waitsOn,
      other: await itemsOf(other, "failedRun"),
      read: notifications.map(({ read }) => read),
      unread,
    }).toStrictEqual({
      run: run.id,
      waitsOn: { type: "person", userId: builder.userId },
      other: [],
      read: [false],
      unread: 1,
    });
  });

  it("puts a version up for review before the member who answers for its App, not every admin who sees it", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const { id } = await builder.api.apps.create({ name: "Invoices" });
    await builder.api.apps.files.commit(
      id,
      { "AGENTS.md": "# Invoices\n" },
      "First"
    );
    await builder.api.apps.versions.propose(id, 1);

    const [mine, admins] = await Promise.all([
      itemsOf(builder, "goLive"),
      itemsOf(admin, "goLive"),
    ]);
    expect({
      builder: mine.map(({ app, version, verdicts }) => ({
        app,
        version,
        verdicts,
      })),
      admin: admins.filter(({ app }) => app.id === id),
    }).toStrictEqual({
      builder: [{ app: { id, name: "Invoices" }, version: 1, verdicts: [] }],
      admin: [],
    });
  });

  it("lists a decision a run waits on for the person it is from, urgent, to answer on its page", async () => {
    const builder = await signedInApi(idp, "builder");
    const decider = await signedInApi(idp, "user");
    const { decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });

    const [item] = await itemsOf(decider, "decision");
    expect({
      id: item?.decision.id,
      urgent: item?.urgent,
      verdicts: item?.verdicts,
      builder: await itemsOf(builder, "decision"),
    }).toStrictEqual({
      id: decision,
      urgent: true,
      verdicts: [],
      builder: [],
    });
  });

  it("refuses what isn't a verdict, and a verdict a kind settled on its own page doesn't take", async () => {
    const person = await signedInApi(idp, "user");
    const notVerdicts = [
      // Approving a held write names the input approved.
      { kind: "heldWrite", id: "held-1", verdict: "approve" },
      // A decision is confirmed on its own page.
      { kind: "decision", id: "decision-1", verdict: "approve" },
    ];
    await expect(
      Promise.all(
        notVerdicts.map(
          async (verdict) =>
            await outcome(
              person.api.waiting.settle(
                // SAFETY: invalid on purpose: anything a client can send, as
                // Cap'n Web checks no types, so core must.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                verdict as never
              )
            )
        )
      )
    ).resolves.toStrictEqual([
      "waiting.invalid_verdict",
      "waiting.invalid_verdict",
    ]);
  });
});
