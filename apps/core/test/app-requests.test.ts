import type { AppRequest } from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Apps people ask Grasp to add, as the catalog doesn't have them. What
// could go wrong: what someone typed reaching the audit log, a link that
// runs script where the request is shown, the same app piling up as many
// requests, Grasp staff asking in a client's name, and someone outside
// the organization reading the list.

const idp = mockIdp();

describe("app requests", { timeout: 60_000 }, () => {
  it("ask for an app the catalog doesn't have, listed to everyone in the organization, latest first, audited by its ID only", async () => {
    const [asker, builder] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    const name = `Exact Online ${unique()}`;
    const why = "Book the invoices the mailbox gets";
    const asked: AppRequest[] = [];
    const audited = await auditedDuring(async () => {
      asked.push(
        await asker.api.connections.requestApp({
          name: `  ${name} `,
          why,
          url: "https://www.exact.com/nl",
        })
      );
    });
    const [first] = asked;
    if (first === undefined) {
      throw new Error("Expected the request back");
    }
    const later = await builder.api.connections.requestApp({
      name: `Twinfield ${unique()}`,
    });

    expect(first).toMatchObject({
      name,
      why,
      url: "https://www.exact.com/nl",
      requestedBy: { userId: asker.userId },
    });
    const listed = await builder.api.connections.appRequests();
    expect(listed.slice(0, 2).map(({ id }) => id)).toStrictEqual([
      later.id,
      first.id,
    ]);
    expect(audited).toStrictEqual([
      expect.objectContaining({
        actor: { type: "person", userId: asker.userId },
        action: "connection.app_requested",
        target: { type: "app_request", id: first.id },
      }),
    ]);
    expect(JSON.stringify(audited)).not.toMatch(/Exact|invoices|exact\.com/u);
  });

  it("keep one request for an app, however its name is written, as the first to ask wrote it, with everyone who asked after among its askers", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = `AFAS Profit ${unique()}`;
    const asked = await first.api.connections.requestApp({ name });
    expect(asked.askers).toStrictEqual([
      { userId: first.userId, askedAt: asked.requestedAt },
    ]);

    const joined: AppRequest[] = [];
    const audited = await auditedDuring(async () => {
      joined.push(
        await second.api.connections.requestApp({
          name: name.toUpperCase(),
          why: "Payroll",
        })
      );
    });

    // The first request stands as it was written; the second person is
    // on it, and their asking is on record as theirs.
    expect(
      joined.map(({ askers, ...request }) => ({
        ...request,
        askers: askers.map(({ userId }) => userId),
      }))
    ).toStrictEqual([{ ...asked, askers: [first.userId, second.userId] }]);
    expect(audited).toStrictEqual([
      expect.objectContaining({
        actor: { type: "person", userId: second.userId },
        action: "connection.app_requested",
        target: { type: "app_request", id: asked.id },
      }),
    ]);
    const listed = await first.api.connections.appRequests();
    expect(
      listed.filter(
        ({ name: each }) => each.toLowerCase() === name.toLowerCase()
      )
    ).toStrictEqual(joined);
  });

  it("count someone who asks for the same app again once, the first to ask and anyone after, recording nothing more", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    const name = `Moneybird ${unique()}`;
    const asked = await first.api.connections.requestApp({ name });
    const joined = await second.api.connections.requestApp({ name });

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          first.api.connections.requestApp({ name: name.toLowerCase() }),
          second.api.connections.requestApp({ name: name.toUpperCase() }),
        ])
      ).resolves.toStrictEqual([joined, joined]);
    });

    expect(audited).toStrictEqual([]);
    expect(joined.askers.map(({ userId }) => userId)).toStrictEqual([
      asked.requestedBy.userId,
      second.userId,
    ]);
  });

  it("refuse a request it can't keep, Grasp staff, and anyone signed out, keeping and recording nothing", async () => {
    const person = await signedInApi(idp, "user");
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const nobody = await openRpc();

    const audited = await auditedDuring(
      async () => {
        await expect(
          Promise.all(
            [
              { name: "" },
              { name: "   " },
              { name: "x".repeat(129) },
              { name: "Exact", url: ["javascript", "alert(1)"].join(":") },
              { name: "Exact", url: "not a link" },
              { name: "Exact", why: "x".repeat(2001) },
              { name: "Exact", extra: true },
            ].map(
              async (request) =>
                await outcome(person.api.connections.requestApp(request))
            )
          )
        ).resolves.toStrictEqual(
          Array.from({ length: 7 }, () => "connection.invalid")
        );
        await expect(
          outcome(
            staff.core
              .authenticate()
              .connections.requestApp({ name: `Staff ${unique()}` })
          )
        ).resolves.toBe("role.forbidden");
      },
      { staffAccesses: true }
    );

    // Nothing of any request is kept; Grasp staff's attempt is on record
    // as theirs, by where it was made (staff-audit.ts).
    expect(
      audited.map(({ action, detail }) => [action, detail.surface])
    ).toStrictEqual([["staff.accessed", "connections.requestApp"]]);
    await expect(
      outcome(nobody.core.authenticate().connections.appRequests())
    ).resolves.toBe("auth.unauthenticated");
  });
});
