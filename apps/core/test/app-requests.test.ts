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

  it("keep one request for an app, however its name is written, the first, recording nothing more", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = `AFAS Profit ${unique()}`;
    const asked = await first.api.connections.requestApp({ name });

    const audited = await auditedDuring(async () => {
      await expect(
        second.api.connections.requestApp({
          name: name.toUpperCase(),
          why: "Payroll",
        })
      ).resolves.toStrictEqual(asked);
    });

    expect(audited).toStrictEqual([]);
    const listed = await second.api.connections.appRequests();
    expect(
      listed.filter(
        ({ name: each }) => each.toLowerCase() === name.toLowerCase()
      )
    ).toHaveLength(1);
  });

  it("refuse a request it can't keep, Grasp staff, and anyone signed out, keeping and recording nothing", async () => {
    const person = await signedInApi(idp, "user");
    const staff = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const nobody = await openRpc();

    const audited = await auditedDuring(async () => {
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
    });

    expect(audited).toStrictEqual([]);
    await expect(
      outcome(nobody.core.authenticate().connections.appRequests())
    ).resolves.toBe("auth.unauthenticated");
  });
});
