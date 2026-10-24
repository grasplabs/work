import type { CompanyToolClass } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connections, connectionTokens } from "../src/db/schema.ts";
import {
  auditEvents,
  connectAccount,
  ownAccount,
  someone,
  startAs,
  stateOf,
} from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { acmeDomain, acmeTenant } from "./provider-config.ts";

// Asking Microsoft only for the rights of the classes a company turned on
// (GRA-717). These start from the ways it can fail: a consent asks a right
// no class that is on needs (sending mail while Reach others is off, a
// shared mailbox nobody pointed Stephen at); a class turned on runs on a
// grant that lacks its rights, instead of asking its person to connect
// again; a connection asked to connect again comes back as another, losing
// its permissions; a right Entra names in another case, or by its full
// URI, counts as missing.

const providers = fakeProviders();
// Registered after the providers, so their requests go on to them.
fakeInternet(() => new Response("Not found", { status: 404 }));
const audit = auditEvents();

const signIn = ["openid", "profile", "email", "offline_access", "User.Read"];

/** The rights a consent asks Microsoft for, the company having `classes` on. */
const askedFor = async (classes?: CompanyToolClass[]) => {
  const url = await startAs(
    someone(),
    classes === undefined ? {} : { classes }
  );
  return url.searchParams.get("scope")?.split(" ").toSorted();
};

/** Rights as `askedFor` gives them: in no order that matters. */
const rights = (...each: string[]): string[] => each.toSorted();

/** The connection's status and whether it has tokens, as stored. */
const stored = async (connectionId: string) => {
  const db = drizzle(env.DB);
  const connection = await db
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const tokens = await db
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, connectionId));
  return { status: connection?.status, tokens: tokens.length };
};

const active = { status: "active", tokens: 1 };
const askedAgain = { status: "needs_reauth", tokens: 0 };

/** What the defaults' consent is granted, as Entra's answer lists it. */
const defaultGrant =
  "openid profile email offline_access User.Read Mail.ReadWrite MailboxSettings.Read Calendars.ReadWrite Files.ReadWrite.All Tasks.ReadWrite Notes.ReadWrite";

describe("a consent", () => {
  it("asks Microsoft only for the rights of the classes the company turned on", async () => {
    const defaults = [
      ...signIn,
      "Mail.ReadWrite",
      "MailboxSettings.Read",
      "Calendars.ReadWrite",
      "Files.ReadWrite.All",
      "Tasks.ReadWrite",
      "Notes.ReadWrite",
    ];
    await expect(askedFor()).resolves.toStrictEqual(rights(...defaults));
    await expect(askedFor(["read-own", "change-own"])).resolves.toStrictEqual(
      rights(...defaults)
    );
    await expect(askedFor(["read-own"])).resolves.toStrictEqual(
      rights(
        ...signIn,
        "Mail.Read",
        "MailboxSettings.Read",
        "Calendars.Read",
        "Files.Read",
        "Notes.Read"
      )
    );
    await expect(
      askedFor(["read-own", "change-own", "reach-others"])
    ).resolves.toStrictEqual(rights(...defaults, "Mail.Send"));
    // Writing every file takes in reading them: asked once, the wider.
    await expect(
      askedFor(["read-own", "read-company", "change-company"])
    ).resolves.toStrictEqual(
      rights(
        ...signIn,
        "Mail.Read",
        "MailboxSettings.Read",
        "Calendars.Read",
        "Notes.Read",
        "Files.ReadWrite.All",
        "Calendars.Read.Shared",
        "Sites.ReadWrite.All",
        // Planner's: changing a plan's tasks takes in reading them.
        "Tasks.ReadWrite"
      )
    );
  });

  it("never asks to send, or for a shared mailbox, while nothing turned that on", async () => {
    const asked = await Promise.all(
      (
        [
          undefined,
          ["read-own", "change-own"],
          ["read-own", "read-company", "change-own", "change-company"],
        ] as const
      ).map(async (classes) => await askedFor(classes && [...classes]))
    );
    expect(
      asked
        .flat()
        .filter((right) =>
          ["Mail.Send", "Mail.Send.Shared", "Mail.ReadWrite.Shared"].includes(
            right ?? ""
          )
        )
    ).toStrictEqual([]);
  });

  it("keeps their own scopes for Google and the admin connections that share Microsoft's sign-in, whatever the classes", async () => {
    const admin = someone("admin");
    const scopesOf = async (
      provider: "google" | "microsoft-documents" | "microsoft-landscape",
      classes?: CompanyToolClass[]
    ) => {
      const url = await startAs(admin, {
        provider,
        scope: provider === "google" ? "personal" : "shared",
        tenant: provider === "google" ? acmeDomain : acmeTenant,
        ...(classes === undefined ? {} : { classes }),
      });
      return url.searchParams.get("scope");
    };
    const others = [
      "google",
      "microsoft-documents",
      "microsoft-landscape",
    ] as const;
    const withClasses = await Promise.all(
      others.map(
        async (provider) =>
          await scopesOf(provider, ["read-own", "change-own", "reach-others"])
      )
    );
    const without = await Promise.all(
      others.map(async (provider) => await scopesOf(provider))
    );
    expect(withClasses).toStrictEqual(without);
    expect(withClasses.join(" ")).not.toContain("Mail.Send");
  });
});

describe("a class turned on", () => {
  it("asks the connections whose grant lacks its rights to connect again, and only those", async () => {
    const anna = someone();
    const ben = someone();
    const annas = await connectAccount(providers, anna, {
      ...ownAccount(anna),
      granted: defaultGrant,
    });
    // Entra may name a Graph right by its full URI, in its own case.
    const bens = await connectAccount(providers, ben, {
      ...ownAccount(ben),
      granted: `${defaultGrant} https://graph.microsoft.com/mail.send`,
    });

    await exports.default.requireClassRights({ classes: ["reach-others"] });

    expect({
      annas: await stored(annas),
      bens: await stored(bens),
    }).toStrictEqual({ annas: askedAgain, bens: active });
    const recorded = await audit.events();
    expect(
      recorded.filter(({ action }) => action === "connection.needs_reauth")
    ).toMatchObject([
      {
        actor: { type: "system" },
        target: { type: "connection", id: annas },
        detail: { provider: "microsoft", reason: "class_turned_on" },
      },
    ]);
  });

  it("is given in place: the same connection comes back with the rights, and isn't asked again", async () => {
    const anna = someone();
    const annas = await connectAccount(providers, anna, {
      ...ownAccount(anna),
      granted: defaultGrant,
    });
    await exports.default.requireClassRights({ classes: ["reach-others"] });

    const url = await startAs(anna, {
      classes: ["read-own", "change-own", "reach-others"],
    });
    expect(url.searchParams.get("scope")?.split(" ")).toContain("Mail.Send");
    const { connectionId } = await exports.default.finishConnection({
      person: anna,
      state: stateOf(url),
      code: providers.authorize(url.href, {
        ...ownAccount(anna),
        granted: `${defaultGrant} Mail.Send`,
      }),
    });
    await exports.default.requireClassRights({ classes: ["reach-others"] });

    expect({ connectionId, ...(await stored(annas)) }).toStrictEqual({
      connectionId: annas,
      ...active,
    });
  });

  it("counts a connection made before grants were kept as holding the wide set it was asked for", async () => {
    const anna = someone();
    // An answer that lists nothing, as kept before: the old wide set.
    const annas = await connectAccount(providers, anna, ownAccount(anna));

    await exports.default.requireClassRights({ classes: ["reach-others"] });
    await expect(stored(annas)).resolves.toStrictEqual(active);

    // Read company now reads Planner too, which the wide set never asked.
    await exports.default.requireClassRights({ classes: ["read-company"] });
    await expect(stored(annas)).resolves.toStrictEqual(askedAgain);
  });

  it("leaves a Google connection and a disconnected one as they are", async () => {
    const anna = someone();
    const ben = someone();
    const annas = await connectAccount(
      providers,
      anna,
      ownAccount(anna, "google")
    );
    const bens = await connectAccount(providers, ben, {
      ...ownAccount(ben),
      granted: defaultGrant,
    });
    await exports.default.disconnect({ person: ben, connectionId: bens });

    await exports.default.requireClassRights({
      classes: ["change-company", "reach-others"],
    });

    const { status } = await stored(bens);
    expect({ annas: await stored(annas), bens: status }).toStrictEqual({
      annas: active,
      bens: "disconnected",
    });
  });
});
