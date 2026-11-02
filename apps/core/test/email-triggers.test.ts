import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { setCurrentVersion } from "../src/apps.ts";
import { racingDb as racingAppsDb, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  addedSince,
  deliver,
  intake,
  invoiceMail,
  readByRun,
  readByRuns,
  runsOf,
  storedName,
  storedObjects,
} from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Email triggers (email-triggers.ts): which messages start runs, once
// each, for which App. What of a message reaches its run is in
// email-trigger-messages.test.ts, its attachments in
// email-attachments.test.ts, and mail the router posts in
// mail-ingress.test.ts: apart, so CI can run them side by side.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A message's key in the audit log: the App and workflow, and a hash,
 * nothing the message says.
 */
const messageKey = /^email:[\w-]+:intake:[0-9a-f]{64}$/u;

describe("email triggers", () => {
  afterEach(endLiveRuns);

  it("start a run with the message as input, and keep it for the App's runs alone", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake());
    const before = await storedObjects();

    const delivery = await deliver("Invoices@grasp.test", invoiceMail());
    const { id, stored, ...read } = await readByRun(builder, app);

    expect(delivery.rejected).toBeUndefined();
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(read).toMatchObject({
      from: "ben@acme.test",
      subject: "Invoice INV-7",
      text: "Please pay by Friday.\n",
      truncated: false,
      attachments: ["inv-7.pdf:5"],
    });
    // Named by its day and ID, never the App; kept under the App.
    const day = storedName.exec(stored ?? "")?.groups?.day;
    expect(stored).toBe(`${day}/${id}`);
    await expect(addedSince(before)).resolves.toStrictEqual([
      `inbound-email/${day}/${app}/${id}`,
    ]);
  });

  it("show with their workflow, by the part of the address they receive at before the @", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("shown"));

    const { triggers } = await builder.api.workflows.get(app, "intake");

    expect(triggers).toStrictEqual([
      { type: "email", position: 0, localPart: "shown" },
    ]);
  });

  it("start nothing for mail sent automatically or from the deployment's own domain, and audit each refusal, so a run's mail can't loop back into runs", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("loops"));
    const to = "loops@grasp.test";
    const refused = [
      // An auto-reply to a run's mail, in any of RFC 3834's kinds.
      invoiceMail({
        to,
        subject: "A",
        headers: ["Auto-Submitted: auto-replied"],
      }),
      invoiceMail({
        to,
        subject: "B",
        headers: ["Auto-Submitted: Auto-Generated; owner-email=x@acme.test"],
      }),
      // A run's own mail, sent from the deployment's domain.
      invoiceMail({ to, subject: "C", from: "Robot <robot@GRASP.test>" }),
    ];
    const deliveries = [];
    for (const raw of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      deliveries.push(await deliver(to, raw));
    }
    // Its envelope sender at the deployment's domain, whatever its From.
    deliveries.push(
      await deliver(to, invoiceMail({ to, subject: "D" }), {
        envelopeFrom: "bounce-1@grasp.test",
      })
    );
    // A person's mail, saying it wasn't sent automatically.
    const allowed = await deliver(
      to,
      invoiceMail({ to, subject: "E", headers: ["Auto-Submitted: no"] })
    );
    const reads = await readByRuns(builder, app);
    const events = await allEvents();

    expect({
      // Accepted, never bounced: a bounce is mail that can loop too.
      rejected: [...deliveries, allowed].map(({ rejected }) => rejected),
      started: reads.map(({ subject }) => subject),
      refusals: events
        .filter(
          ({ action, target }) =>
            action === "workflow.email.refused" && target?.id === app
        )
        // In the order they were delivered.
        .map(({ detail }) => [detail.address, detail.reason]),
    }).toStrictEqual({
      rejected: [undefined, undefined, undefined, undefined, undefined],
      started: ["E"],
      refusals: [
        ["loops", "auto_submitted"],
        ["loops", "auto_submitted"],
        ["loops", "own_domain"],
        ["loops", "own_domain"],
      ],
    });
  });

  it("start the same message once across a new version of the workflow", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("again"));
    const to = "again@grasp.test";
    const mail = invoiceMail({
      to,
      messageId: `${crypto.randomUUID()}@acme.test`,
    });

    await deliver(to, mail);
    // A new version: its triggers are registered anew.
    await release(builder, app, {
      "workflows/lib/note.ts": "export const note = 2;\n",
    });
    await deliver(to, mail);

    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("start a message's run when delivered again after its start failed, once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("retried"));
    const mail = invoiceMail({
      to: "retried@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const unstartable: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(unstartable);
    let first: string;
    try {
      first = await outcome(deliver("retried@grasp.test", mail));
    } finally {
      uuid.mockRestore();
    }

    const again = await outcome(deliver("retried@grasp.test", mail));
    const third = await outcome(deliver("retried@grasp.test", mail));
    const started = await runsOf(builder, app);
    await Promise.all(
      started
        .filter(({ id }) => id !== unstartable)
        .map(async ({ id }) => {
          await finished(id);
        })
    );
    const runs = await runsOf(builder, app);

    expect({
      first: first === "ok",
      again,
      third,
      runs: runs
        .map(
          ({ id, status }) =>
            `${id === unstartable ? "failed start" : "new"}: ${status}`
        )
        .toSorted(),
    }).toStrictEqual({
      first: false,
      again: "ok",
      third: "ok",
      runs: ["failed start: failed", "new: completed"],
    });
  });

  it("start a workflow once for a message two of its triggers receive", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("doubled", "intake", 2));

    await expect(
      outcome(
        deliver("doubled@grasp.test", invoiceMail({ to: "doubled@grasp.test" }))
      )
    ).resolves.toBe("ok");
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("stop a workflow going over its hourly limit, start the others, and start each run once when the mail comes again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...intake("busy"),
      ...intake("busy", "tally"),
    });
    // The hour's runs from mail, as recorded: `intake` at its 60, `tally`
    // one short, so this message's run is `tally`'s 60th.
    const now = Date.now();
    const hours = [
      ...Array.from({ length: 60 }, (_, index) => ({
        workflow: "intake",
        index,
      })),
      ...Array.from({ length: 59 }, (_, index) => ({
        workflow: "tally",
        index,
      })),
    ].map((run) => ({ ...run, id: crypto.randomUUID() }));
    const seeded = new Set(hours.map(({ id }) => id));
    await env.DB.batch(
      hours.map(({ id, workflow, index }) =>
        env.DB.prepare(
          "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, trigger_key) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?, ?)"
        ).bind(
          id,
          app,
          workflow,
          now - index * 1000,
          now,
          `email:${app}:${workflow}:${index}`
        )
      )
    );
    const mail = invoiceMail({
      to: "busy@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    const started = async () => {
      const runs = await runsOf(builder, app);
      return runs
        .filter(({ id }) => !seeded.has(id))
        .map(({ workflow }) => workflow)
        .toSorted();
    };

    const first = await outcome(deliver("busy@grasp.test", mail));
    const whileCapped = await started();
    // The hour moves on for `intake`; `tally` is at its 60 now, one of
    // them this message's. The sender tries again.
    await env.DB.prepare(
      "UPDATE workflow_runs SET created_at = ? WHERE app_id = ? AND workflow_id = 'intake'"
    )
      .bind(now - 2 * 60 * 60 * 1000, app)
      .run();
    const again = await outcome(deliver("busy@grasp.test", mail));

    expect({
      first: first.includes("over a workflow's hourly limit"),
      whileCapped,
      again,
      afterwards: await started(),
    }).toStrictEqual({
      first: true,
      whileCapped: ["tally"],
      again: "ok",
      afterwards: ["intake", "tally"],
    });
  });

  it("start one run for a message delivered again, by its Message-ID or else its bytes, and keep it once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("twice"));
    const messageId = `${crypto.randomUUID()}@acme.test`;
    const to = "twice@grasp.test";
    const before = await storedObjects();

    // Redelivered through another server: new Received header, same ID.
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx1" }));
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx2" }));
    // Sent again under the same ID with other words each time: the same
    // message still, and nothing more of it is kept.
    for (const text of ["Pay today.", "Pay now.", "Pay at once."]) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery after another
      await deliver(to, invoiceMail({ to, messageId, text }));
    }
    // Without a Message-ID, the same bytes are the same message.
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-9" }));
    // An empty Message-ID names no message: two messages with it are two.
    await deliver(to, invoiceMail({ to, subject: "INV-10", messageId: "" }));
    await deliver(to, invoiceMail({ to, subject: "INV-11", messageId: "" }));

    await expect(runsOf(builder, app)).resolves.toHaveLength(5);
    // One kept message a run, however often and however it came again.
    const kept = await addedSince(before);
    const stored = await readByRuns(builder, app);
    expect(kept.toSorted()).toStrictEqual(
      stored
        .map(({ stored: name }) => {
          const [day, id] = (name ?? "").split("/");
          return `inbound-email/${day}/${app}/${id}`;
        })
        .toSorted()
    );
    const events = await allEvents();

    expect(
      events
        .filter(
          ({ action, detail }) =>
            action === "workflow.run.started" && detail.app === app
        )
        .map(({ actor, detail }) => [
          actor.type,
          detail.trigger,
          messageKey.test(String(detail.key)),
        ])
    ).toStrictEqual(Array.from({ length: 5 }, () => ["system", "email", true]));
  });

  it("bounce mail to an address nobody receives at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("somebody"));
    const mail = invoiceMail({ to: "somebody@grasp.test" });

    const unknown = await deliver("nobody@grasp.test", mail);

    expect(unknown.rejected).toBe("No such address.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("say in the audit log which addresses a version receives mail at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("audited"));
    const events = await allEvents();

    expect(
      events.filter(
        ({ action, target }) =>
          action === "app.version.current" && target?.id === app
      )
    ).toMatchObject([
      { detail: { schedules: 0, emails: "audited", events: "" } },
    ]);
  });

  it("go to one App: another can't take an address that's taken", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("taken"));
    const { id: other } = await builder.api.apps.create({ name: "Other" });

    await expect(
      outcome(release(builder, other, intake("taken")))
    ).resolves.toBe("workflow.email_taken");
    // The App that has it keeps it in its next version.
    await expect(
      outcome(
        release(builder, app, {
          "workflows/lib/note.ts": "export const note = 1;\n",
        })
      )
    ).resolves.toBe("ok");
    await deliver("taken@grasp.test", invoiceMail());
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("go to one App even when two take an address at once", async () => {
    const builder = await personApi("builder");
    const first = await appWith(builder, intake("inbox"));
    const { id: second } = await builder.api.apps.create({ name: "Second" });
    const { version } = await builder.api.apps.files.commit(
      second,
      intake("raced"),
      "Raced"
    );
    // The first App takes the address just before the second's batch
    // lands: after the second checked it was free. Only that batch: its
    // candidate's own batches come before it (app-candidates.ts).
    const racing = racingAppsDb(
      async () =>
        await env.DB.prepare(
          "UPDATE workflow_triggers SET address = 'raced' WHERE app_id = ?"
        )
          .bind(first)
          .run(),
      /update "apps" set "current_version"/iu
    );

    const refused = await outcome(
      setCurrentVersion(
        { ...env, DB: racing },
        await builder.api.whoami(),
        second,
        version
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT app_id FROM workflow_triggers WHERE address = 'raced'"
    ).all<{ app_id: string }>();

    expect({
      refused,
      receivers: results.map(({ app_id }) => app_id),
    }).toStrictEqual({
      refused: "app.conflict",
      receivers: [first],
    });
  });
});
