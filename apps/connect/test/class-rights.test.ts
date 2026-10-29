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
  runMaintenance,
  someone,
  startAs,
  stateOf,
} from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { acmeDomain, acmeTenant } from "./provider-config.ts";

// Asking Microsoft and Google only for the rights of the classes a company
// turned on (GRA-717, GRA-756). These start from the ways it can fail: a
// consent asks a right no class that is on needs (sending mail while Reach
// others is off, a shared mailbox nobody pointed Stephen at); a class
// turned on runs on a grant that lacks its rights, instead of asking its
// person to connect again; a connection asked to connect again comes back
// as another, losing its permissions; a right Entra names in another case,
// or by its full URI, counts as missing; Gmail's modifying, which sends
// too, is taken for less than it is.

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

  it("keeps their own scopes for the admin connections that share a suite's sign-in, whatever the classes", async () => {
    const admin = someone("admin");
    const scopesOf = async (
      provider:
        | "google-documents"
        | "microsoft-documents"
        | "microsoft-landscape",
      classes?: CompanyToolClass[]
    ) => {
      const url = await startAs(admin, {
        provider,
        scope: "shared",
        tenant: provider === "google-documents" ? acmeDomain : acmeTenant,
        ...(classes === undefined ? {} : { classes }),
      });
      return url.searchParams.get("scope");
    };
    const others = [
      "google-documents",
      "microsoft-documents",
      "microsoft-landscape",
    ] as const;
    const withClasses = await Promise.all(
      others.map(
        async (provider) =>
          await scopesOf(provider, [
            "read-own",
            "change-own",
            "change-company",
            "reach-others",
          ])
      )
    );
    const without = await Promise.all(
      others.map(async (provider) => await scopesOf(provider))
    );
    expect(withClasses).toStrictEqual(without);
    expect(withClasses.join(" ")).not.toMatch(/Mail\.Send|gmail/u);
  });
});

/** The rights a consent asks for, `classes` on and a shared mailbox pointed at. */
const askedWithSharedMailbox = async (classes: CompanyToolClass[]) => {
  const url = await startAs(someone(), { classes, sharedMailbox: true });
  return url.searchParams.get("scope")?.split(" ") ?? [];
};

describe("a shared mailbox pointed at", () => {
  it("adds shared mailboxes' rights to a consent, and sending from them only with Reach others", async () => {
    const reading = await askedWithSharedMailbox(["read-own", "change-own"]);
    const sending = await askedWithSharedMailbox([
      "read-own",
      "change-own",
      "reach-others",
    ]);
    expect({
      reading: reading.filter((right) => right.endsWith(".Shared")),
      sending: sending.filter((right) => right.endsWith(".Shared")),
    }).toStrictEqual({
      reading: ["Mail.ReadWrite.Shared"],
      sending: ["Mail.ReadWrite.Shared", "Mail.Send.Shared"],
    });
  });

  it("asks the connections without shared mailboxes' rights to connect again", async () => {
    const anna = someone();
    const ben = someone();
    const annas = await connectAccount(providers, anna, {
      ...ownAccount(anna),
      granted: defaultGrant,
    });
    const bens = await connectAccount(providers, ben, {
      ...ownAccount(ben),
      granted: `${defaultGrant} Mail.ReadWrite.Shared`,
    });
    // Made before grants were kept: the old wide set holds them.
    const carl = someone();
    const carls = await connectAccount(providers, carl, ownAccount(carl));

    await exports.default.requireClassRights({
      classes: [],
      sharedMailbox: true,
    });

    expect({
      annas: await stored(annas),
      bens: await stored(bens),
      carls: await stored(carls),
    }).toStrictEqual({ annas: askedAgain, bens: active, carls: active });
  });
});

describe("Read others' words", () => {
  const teamsRights = [
    "Chat.Read",
    "OnlineMeetings.Read",
    "OnlineMeetingTranscript.Read.All",
  ];

  it("is asked of Microsoft only once the company turns it on", async () => {
    const off = await Promise.all(
      (
        [
          undefined,
          ["read-own", "change-own"],
          [
            "read-own",
            "read-company",
            "change-own",
            "change-company",
            "reach-others",
          ],
        ] as const
      ).map(async (classes) => await askedFor(classes && [...classes]))
    );
    expect(
      off.flat().filter((right) => teamsRights.includes(right ?? ""))
    ).toStrictEqual([]);
    // On its own it reads the calendar too, to find the meetings.
    await expect(askedFor(["read-others"])).resolves.toStrictEqual(
      rights(...signIn, "Calendars.Read", ...teamsRights)
    );
  });

  it("asks the connections granted without it to connect again once turned on", async () => {
    const anna = someone();
    const annas = await connectAccount(providers, anna, {
      ...ownAccount(anna),
      granted: defaultGrant,
    });
    // Made before grants were kept: the old wide set never read chats.
    const ben = someone();
    const bens = await connectAccount(providers, ben, ownAccount(ben));

    await exports.default.requireClassRights({ classes: ["read-others"] });

    expect({
      annas: await stored(annas),
      bens: await stored(bens),
    }).toStrictEqual({ annas: askedAgain, bens: askedAgain });
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
    // Connections of the other tests here may be asked too: only these two
    // are looked at.
    expect(
      recorded.filter(
        ({ action, target }) =>
          action === "connection.needs_reauth" &&
          (target?.id === annas || target?.id === bens)
      )
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

  it("leaves a disconnected connection as it is", async () => {
    const ben = someone();
    const bens = await connectAccount(providers, ben, {
      ...ownAccount(ben),
      granted: defaultGrant,
    });
    await exports.default.disconnect({ person: ben, connectionId: bens });

    await exports.default.requireClassRights({
      classes: ["change-company", "reach-others"],
    });

    const { status } = await stored(bens);
    expect(status).toBe("disconnected");
  });
});

/** A Google OAuth scope, by its name under Google's prefix. */
const googleScope = (name: string): string =>
  `https://www.googleapis.com/auth/${name}`;

const googleSignIn = ["openid", "email", "profile"];

/** The rights a consent asks Google for, the company having `classes` on. */
const googleAskedFor = async (classes?: CompanyToolClass[]) => {
  const url = await startAs(someone(), {
    provider: "google",
    ...(classes === undefined ? {} : { classes }),
  });
  return url.searchParams.get("scope")?.split(" ").toSorted();
};

/** The defaults' rights at Google: Read own and Change own. */
const googleDefaults = [
  ...googleSignIn,
  googleScope("gmail.modify"),
  googleScope("calendar.events"),
  googleScope("calendar.calendarlist.readonly"),
  googleScope("drive.file"),
];

/**
 * What the defaults' consent is granted, as Google's answer lists it: the
 * sign-in's by their full URIs.
 */
const googleDefaultGrant = [
  "openid",
  googleScope("userinfo.email"),
  googleScope("userinfo.profile"),
  ...googleDefaults.slice(googleSignIn.length),
].join(" ");

/** Connects `person`'s own Google account, granted `granted`. */
const connectGoogle = async (granted?: string) => {
  const person = someone();
  const connectionId = await connectAccount(providers, person, {
    ...ownAccount(person, "google"),
    ...(granted === undefined ? {} : { granted }),
  });
  return { person, connectionId };
};

describe("Google Workspace", () => {
  it("asks Google only for the rights of the classes the company turned on", async () => {
    await expect(googleAskedFor()).resolves.toStrictEqual(
      rights(...googleDefaults)
    );
    await expect(googleAskedFor(["read-own"])).resolves.toStrictEqual(
      rights(...googleSignIn, googleScope("gmail.readonly"))
    );
    await expect(
      googleAskedFor(["read-own", "read-company"])
    ).resolves.toStrictEqual(
      rights(
        ...googleSignIn,
        googleScope("gmail.readonly"),
        googleScope("calendar.events.readonly"),
        googleScope("drive.readonly")
      )
    );
    // Writing events takes in reading them: asked once, the wider.
    await expect(
      googleAskedFor(["read-own", "change-own", "read-company"])
    ).resolves.toStrictEqual(
      rights(...googleDefaults, googleScope("drive.readonly"))
    );
    // Google has no tool that changes the company's: it asks nothing more.
    await expect(
      googleAskedFor(["read-own", "change-own", "change-company"])
    ).resolves.toStrictEqual(rights(...googleDefaults));
  });

  it("asks to send only with Reach others, which under gmail.modify only its class holds back", async () => {
    // Read own alone can't send; Reach others adds sending, and nothing else.
    await expect(googleAskedFor(["read-own"])).resolves.not.toContain(
      googleScope("gmail.send")
    );
    await expect(
      googleAskedFor(["read-own", "reach-others"])
    ).resolves.toStrictEqual(
      rights(
        ...googleSignIn,
        googleScope("gmail.readonly"),
        googleScope("gmail.send")
      )
    );
    // Change own's labelling and drafting need gmail.modify, which sends
    // too: Gmail has no right that modifies but can't send. So the consent
    // is the same with Reach others as without, and the grant could send
    // either way; core refuses mail.send while the class is off.
    await expect(
      googleAskedFor(["read-own", "change-own", "reach-others"])
    ).resolves.toStrictEqual(await googleAskedFor(["read-own", "change-own"]));

    // So turning Reach others on asks again only a grant that can't send.
    const modifying = await connectGoogle(googleDefaultGrant);
    const reading = await connectGoogle(
      `openid ${googleScope("userinfo.email")} ${googleScope("gmail.readonly")}`
    );
    await exports.default.requireClassRights({ classes: ["reach-others"] });
    expect({
      modifying: await stored(modifying.connectionId),
      reading: await stored(reading.connectionId),
    }).toStrictEqual({ modifying: active, reading: askedAgain });
  });

  it("asks the connections whose grant lacks a class's rights to connect again, in place, and only those", async () => {
    const anna = await connectGoogle(googleDefaultGrant);
    const ben = await connectGoogle(
      `${googleDefaultGrant} ${googleScope("drive.readonly")}`
    );

    await exports.default.requireClassRights({ classes: ["read-company"] });

    expect({
      annas: await stored(anna.connectionId),
      bens: await stored(ben.connectionId),
    }).toStrictEqual({ annas: askedAgain, bens: active });
    const recorded = await audit.events();
    expect(
      recorded.filter(
        ({ action, target }) =>
          action === "connection.needs_reauth" &&
          (target?.id === anna.connectionId || target?.id === ben.connectionId)
      )
    ).toMatchObject([
      {
        target: { type: "connection", id: anna.connectionId },
        detail: { provider: "google", reason: "class_turned_on" },
      },
    ]);

    const url = await startAs(anna.person, {
      provider: "google",
      classes: ["read-own", "change-own", "read-company"],
    });
    expect(url.searchParams.get("scope")?.split(" ")).toContain(
      googleScope("drive.readonly")
    );
    const { connectionId } = await exports.default.finishConnection({
      person: anna.person,
      state: stateOf(url),
      code: providers.authorize(url.href, {
        ...ownAccount(anna.person, "google"),
        granted: `${googleDefaultGrant} ${googleScope("drive.readonly")}`,
      }),
    });
    await exports.default.requireClassRights({ classes: ["read-company"] });
    expect({
      connectionId,
      ...(await stored(anna.connectionId)),
    }).toStrictEqual({ connectionId: anna.connectionId, ...active });
  });

  it("counts a connection made before grants were kept as holding what Google was asked for then", async () => {
    // An answer that lists nothing: gmail.modify, reading events and Drive.
    const { connectionId } = await connectGoogle();

    await exports.default.requireClassRights({
      classes: ["read-company", "change-company", "reach-others"],
    });
    await expect(stored(connectionId)).resolves.toStrictEqual(active);

    // Putting events in the person's own calendar wasn't asked then.
    await exports.default.requireClassRights({ classes: ["change-own"] });
    await expect(stored(connectionId)).resolves.toStrictEqual(askedAgain);
  });
});

/** The revokes owed for connection `connectionId`, by why. */
const owedFor = async (connectionId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT reason FROM token_revocations WHERE connection_id = ?"
  )
    .bind(connectionId)
    .all<{ reason: string }>();
  return results.map(({ reason }) => reason);
};

/** Time passes: every owed revoke of `connectionId` is due. */
const owedDue = async (connectionId: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE token_revocations SET retry_at = 0 WHERE connection_id = ?"
  )
    .bind(connectionId)
    .run();
};

// A connection asked to connect again gives its tokens up while its grant
// is still valid (GRA-1196). From the ways it can fail: the grant stays
// live with nothing left to revoke it, should the person never connect
// again; the copy kept to revoke it is used for anything else; revoking it
// ends the grant the person just gave by connecting again in place.
describe("a grant asked to connect again", () => {
  it("is revoked as owed at Google, should the person not connect again", async () => {
    const anna = await connectGoogle(googleDefaultGrant);
    const account = ownAccount(anna.person, "google");

    await exports.default.requireClassRights({ classes: ["read-company"] });
    const owed = await owedFor(anna.connectionId);
    const live = providers.grantHolds(account);
    await owedDue(anna.connectionId);
    await runMaintenance();

    const recorded = await audit.events();
    expect({
      stored: await stored(anna.connectionId),
      owed,
      live,
      revoked: !providers.grantHolds(account),
      left: await owedFor(anna.connectionId),
      ended: recorded
        .filter(
          ({ action, target }) =>
            action === "connection.revoked" && target?.id === anna.connectionId
        )
        .map(({ detail }) => detail),
    }).toMatchObject({
      stored: askedAgain,
      owed: ["needs_reauth"],
      live: true,
      revoked: true,
      left: [],
      ended: [{ owedFor: "needs_reauth", outcome: "revoked" }],
    });
  });

  it("is left to the grant the person gave by connecting again in place first", async () => {
    const anna = await connectGoogle(googleDefaultGrant);
    const account = ownAccount(anna.person, "google");
    await exports.default.requireClassRights({ classes: ["read-company"] });
    const url = await startAs(anna.person, {
      provider: "google",
      classes: ["read-own", "change-own", "read-company"],
    });
    await exports.default.finishConnection({
      person: anna.person,
      state: stateOf(url),
      code: providers.authorize(url.href, {
        ...account,
        granted: `${googleDefaultGrant} ${googleScope("drive.readonly")}`,
      }),
    });
    const asked = providers.revocations().length;

    await owedDue(anna.connectionId);
    await runMaintenance();

    const recorded = await audit.events();
    expect({
      stored: await stored(anna.connectionId),
      grant: providers.grantHolds(account),
      revokes: providers.revocations().length - asked,
      left: await owedFor(anna.connectionId),
      superseded: recorded.some(
        ({ action, target }) =>
          action === "connection.revoke_superseded" &&
          target?.id === anna.connectionId
      ),
    }).toStrictEqual({
      stored: active,
      grant: true,
      revokes: 0,
      left: [],
      superseded: true,
    });
  });

  it("waits while the person is signing in to connect it again, so the consent on its way keeps its grant", async () => {
    const anna = await connectGoogle(googleDefaultGrant);
    const account = ownAccount(anna.person, "google");
    await exports.default.requireClassRights({ classes: ["read-company"] });
    // On Google's consent screen now: the flow is open.
    await startAs(anna.person, { provider: "google" });
    const asked = providers.revocations().length;

    await owedDue(anna.connectionId);
    await runMaintenance();

    const owed = await env.DB.prepare(
      "SELECT attempts, retry_at AS retryAt FROM token_revocations WHERE connection_id = ?"
    )
      .bind(anna.connectionId)
      .first<{ attempts: number; retryAt: number }>();
    expect({
      revokes: providers.revocations().length - asked,
      grant: providers.grantHolds(account),
      attempts: owed?.attempts,
      later: (owed?.retryAt ?? 0) > Date.now(),
    }).toStrictEqual({ revokes: 0, grant: true, attempts: 0, later: true });
  });

  it("owes nothing at Microsoft, which can't revoke a grant", async () => {
    const anna = someone();
    const annas = await connectAccount(providers, anna, {
      ...ownAccount(anna),
      granted: defaultGrant,
    });

    await exports.default.requireClassRights({
      classes: [],
      sharedMailbox: true,
    });

    expect({
      stored: await stored(annas),
      owed: await owedFor(annas),
    }).toStrictEqual({ stored: askedAgain, owed: [] });
  });
});
