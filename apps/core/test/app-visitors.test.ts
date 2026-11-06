import {
  appVisitorApiPath,
  appVisitorCodesPerAddressPerHour,
  appVisitorCodesPerAppPerHour,
} from "@grasp-os/shared/app-visitors";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appVisitorResponse, sweepAppVisitors } from "../src/app-visitors.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import type { CapturedMail } from "./mail-capture.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Visitors (app-visitors.ts), from its threat model: someone not listed
// asking for a code, and learning nothing from the answer; a look-alike
// domain or an address dressed up as a listed one; guessing a code, or
// using one twice, late or past its tries; mail sent too often to one
// address or for one App; a session used on another App, or to call the
// App's functions; access kept after the App is unpublished, the address
// is taken off the list, or the visitor signs out; the list set by
// someone who doesn't build the App; and any of it unaudited.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A link no other test has. */
const newLink = (): string => `portal-${unique()}`;

/** A domain no other test has. */
const newDomain = (): string => `partner-${unique()}.test`;

/** A builder's App at its own link, published, listing `entries`. */
const visitedApp = async (
  entries: { kind: "address" | "domain"; value: string }[]
) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Client portal" });
  const link = newLink();
  await builder.api.apps.setLink(id, link);
  await builder.api.apps.setVisitors(id, entries);
  await published(id);
  return { builder, app: id, link };
};

/** A Notes App's files: one function, one screen. */
const notesFiles: Record<string, string> = {
  "server/schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }).access({ read: "appMembers", write: "appMembers" }),
});
`,
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`,
  "grasp.config.ts": `import { defineApp } from "@grasp-os/sdk";

export default defineApp({
  name: "Notes",
});
`,
  "screens/notes.tsx": `export default function Notes() {
  return <p>Notes</p>;
}
`,
};

/**
 * The Notes App routed: `detail` at `/items/:id`, which sorts first and
 * needs an ID, and `home` at `/`, which needs nothing.
 */
const routedNotesFiles: Record<string, string> = {
  ...notesFiles,
  "screens.ts": `import { v } from "@grasp-os/sdk";

export default {
  screens: [
    {
      name: "detail",
      path: "/items/:id",
      source: "screens/detail.tsx",
      input: v.object({ id: v.string() }),
    },
    { name: "home", path: "/", source: "screens/home.tsx" },
  ],
};
`,
  "screens/detail.tsx": `export default function Detail() {
  return <p>Detail</p>;
}
`,
  "screens/home.tsx": `export default function Home() {
  return <p>Home</p>;
}
`,
};

/** Makes `files` the App's current version. */
const releasedNotes = async (
  builder: Person,
  app: string,
  files: Record<string, string> = notesFiles
): Promise<void> => {
  const { version } = await builder.api.apps.files.commit(app, files, "First");
  await builder.api.apps.versions.setCurrent(app, version);
};

/** Posts a visitor's request, as their page does. */
const post = async (body: unknown): Promise<Response> =>
  await routed(appVisitorApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The status and code of an answer: `ok` for a 2xx. */
const answerOf = async (response: Response) => {
  if (response.ok) {
    return { status: response.status, code: "ok" };
  }
  return {
    status: response.status,
    code: errorPayloadSchema.parse(await response.json()).code,
  };
};

/** What asking for a code answers. */
const ask = async (link: string, address: string) =>
  await answerOf(await post({ action: "ask", link, address }));

const sessionSchema = z.object({ token: z.string(), expiresAt: z.string() });

/** Signs in: the session's token, or the refusal's code. */
const signIn = async (
  link: string,
  address: string,
  code: string
): Promise<string> => {
  const response = await post({ action: "sign_in", link, address, code });
  if (!response.ok) {
    return errorPayloadSchema.parse(await response.json()).code;
  }
  return sessionSchema.parse(await response.json()).token;
};

const visitSchema = z.object({
  app: z.string(),
  name: z.string(),
  screen: z
    .object({ app: z.string(), lease: z.string(), screen: z.string() })
    .loose()
    .nullable(),
});

/** Opens with `token`: what it opens, or the refusal's code. */
const open = async (
  token: string
): Promise<z.infer<typeof visitSchema> | string> => {
  const response = await post({ action: "open", token });
  if (!response.ok) {
    return errorPayloadSchema.parse(await response.json()).code;
  }
  return visitSchema.parse(await response.json());
};

/** A mail's one recipient, as an address. */
const toOf = (message: EmailMessageBuilder): string => {
  const [to] = [message.to].flat();
  return typeof to === "string" ? to : (to?.email ?? "");
};

/** Who each mail went to, in order. */
const recipients = (mail: CapturedMail): string[] => mail.sent.map(toOf);

/** The code in the last mail to `address` sent so far. */
const codeIn = (mail: CapturedMail, address: string): string => {
  const message = mail.sent.findLast(
    (each) => toOf(each) === address.toLowerCase()
  );
  const text = message?.text ?? "";
  const found = /(?<code>\d{4} \d{4})/u.exec(text)?.groups?.code;
  if (found === undefined) {
    throw new Error(`No code went to ${address}`);
  }
  return found.replace(" ", "");
};

/**
 * The code in the last mail to `address`, once it went out: core sends it
 * after answering (`waitUntil`).
 */
const lastCode = async (mail: CapturedMail, address: string): Promise<string> =>
  await vi.waitFor(() => codeIn(mail, address));

/** A code that isn't `code`, of the same length. */
const otherCode = (code: string): string =>
  String((Number(code) + 1) % 100_000_000).padStart(8, "0");

const reasonSchema = z.object({ reason: z.string() }).loose();

/** Captures what core mails from now on. */
const mailbox = async (): Promise<CapturedMail> =>
  await captureMail(onboardingStore(env));

/** The App's visitor events of `events`: action and detail. */
const visitorEvents = (
  events: Awaited<ReturnType<typeof auditedDuring>>,
  app: string
) =>
  events
    .filter(
      (event) =>
        event.action.startsWith("app.visitor") && event.target?.id === app
    )
    .map((event) => ({
      action: event.action,
      actor: event.actor.type,
      detail: event.detail,
    }));

/**
 * Addresses as long as people's get: 25 of them make far more than one
 * audit value holds.
 */
const longAddresses = (prefix: string): string[] =>
  Array.from(
    { length: 25 },
    (_, index) =>
      `${prefix}.firstname.lastname-${index}@department-${unique()}.example.test`
  );

/** `list` as entries by address. */
const addressEntries = (list: string[]) =>
  list.map((value) => ({ kind: "address" as const, value }));

/** `list`'s entries as an audit event's detail, each as JSON, sorted. */
const addressDetails = (list: string[]): string[] =>
  list.map((value) => JSON.stringify({ kind: "address", value })).toSorted();

/** Asks, and whether the work it left was still going when it answered. */
const askDeferred = async (link: string, address: string) => {
  const deferred: Promise<unknown>[] = [];
  const response = await appVisitorResponse(
    new Request(`https://core.test${appVisitorApiPath}`, {
      method: "POST",
      body: JSON.stringify({ action: "ask", link, address }),
    }),
    env,
    crypto.randomUUID(),
    {
      waitUntil: (work) => {
        deferred.push(work);
      },
    }
  );
  const pending = await Promise.all(
    deferred.map(
      async (work) =>
        await Promise.race([work.then(() => false), Promise.resolve(true)])
    )
  );
  await Promise.all(deferred);
  return { status: response.status, pending };
};

describe("an App's visitors", { timeout: 120_000 }, () => {
  it("are mailed a code only when listed, by address or domain, for a published App, and asking answers the same whatever happened", async () => {
    const domain = newDomain();
    const listed = `ana@${unique()}.test`;
    const { builder, app, link } = await visitedApp([
      { kind: "address", value: listed },
      { kind: "domain", value: domain },
    ]);
    const mail = await mailbox();
    const atDomain = `ben@${domain}`;
    const stranger = `eve@${unique()}.test`;

    let answers: Awaited<ReturnType<typeof ask>>[] = [];
    const events = await auditedDuring(async () => {
      answers = await Promise.all([
        ask(link, listed),
        ask(link, atDomain),
        ask(link, stranger),
        ask(newLink(), listed),
      ]);
    });
    await vi.waitFor(() => {
      expect(recipients(mail)).toHaveLength(2);
    });
    await builder.api.apps.unpublish(app);
    const asDraft = await ask(link, listed);
    const sentWhileDraft = recipients(mail).length;

    expect({
      answers,
      asDraft,
      sent: recipients(mail).toSorted(),
      sentWhileDraft,
      events: visitorEvents(events, app)
        .map((event) => JSON.stringify(event))
        .toSorted(),
    }).toStrictEqual({
      // The same answer, whether a code went out, the address was listed,
      // or the link names an App at all.
      answers: Array.from({ length: 4 }, () => ({ status: 202, code: "ok" })),
      asDraft: { status: 202, code: "ok" },
      sent: [atDomain, listed].toSorted(),
      // A draft sends nothing.
      sentWhileDraft: 2,
      events: [
        {
          action: "app.visitor_code_sent",
          actor: "visitor",
          detail: { address: listed },
        },
        {
          action: "app.visitor_code_sent",
          actor: "visitor",
          detail: { address: atDomain },
        },
        {
          action: "app.visitor_refused",
          actor: "visitor",
          // An address nobody listed is kept by its domain alone.
          detail: { domain: stranger.split("@")[1], reason: "not_listed" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .toSorted(),
    });
  });

  it("refuses look-alike domains and addresses made to read as a listed one", async () => {
    const domain = newDomain();
    const boss = `boss@${unique()}.test`;
    const { link } = await visitedApp([
      { kind: "domain", value: domain },
      { kind: "address", value: boss },
    ]);
    const mail = await mailbox();
    const [local, bossDomain = ""] = boss.split("@");

    const notListed = await Promise.all(
      [
        // A subdomain, or the domain as a subdomain of another.
        `x@sub.${domain}`,
        `x@${domain}.evil.test`,
        // A domain that only ends the same.
        `x@evil${domain}`,
        // The listed address with a tag, or its `@` written as `%`.
        `${local}+x@${bossDomain}`,
        `${local}%${bossDomain}@evil.test`,
      ].map(async (address) => await ask(link, address))
    );
    const malformed = await Promise.all(
      [
        // A Cyrillic `а` in place of the Latin one.
        `x@${domain.replace("a", "а")}`,
        // A quoted local part holding the listed address.
        `"${boss}"@evil.test`,
        // Two `@`, a trailing dot, a comment.
        `${boss}@evil.test`,
        `x@${domain}.`,
        `x@evil.test(${boss})`,
        "",
      ].map(async (address) => await ask(link, address))
    );
    const caseOnly = await ask(link, boss.toUpperCase());
    await vi.waitFor(() => {
      expect(recipients(mail)).toHaveLength(1);
    });

    expect({
      notListed,
      malformed,
      caseOnly,
      sent: recipients(mail),
    }).toStrictEqual({
      notListed: Array.from({ length: 5 }, () => ({ status: 202, code: "ok" })),
      malformed: Array.from({ length: 6 }, () => ({
        status: 400,
        code: "visitor.invalid",
      })),
      // Case is all an address is compared without.
      caseOnly: { status: 202, code: "ok" },
      sent: [boss],
    });
  });

  it("takes a code once, within its 5 tries and 10 minutes, so guessing it is refused", async () => {
    const domain = newDomain();
    const { link, app } = await visitedApp([{ kind: "domain", value: domain }]);
    const mail = await mailbox();
    const lucky = `a@${domain}`;
    const unlucky = `b@${domain}`;
    const late = `c@${domain}`;

    // Four wrong tries, then the right one: in.
    await ask(link, lucky);
    const luckyCode = await lastCode(mail, lucky);
    const wrong = await Promise.all(
      Array.from(
        { length: 4 },
        async () => await signIn(link, lucky, otherCode(luckyCode))
      )
    );
    const right = await signIn(link, lucky, luckyCode);
    // Used once: the same code again opens nothing.
    const again = await signIn(link, lucky, luckyCode);

    // Five wrong tries: the right code then opens nothing.
    await ask(link, unlucky);
    const unluckyCode = await lastCode(mail, unlucky);
    // At once: tries at the same time take no more than 5 between them.
    await Promise.all(
      Array.from(
        { length: 5 },
        async () => await signIn(link, unlucky, otherCode(unluckyCode))
      )
    );
    const afterFive = await signIn(link, unlucky, unluckyCode);

    // Past its 10 minutes.
    await ask(link, late);
    const lateCode = await lastCode(mail, late);
    await env.DB.prepare(
      "UPDATE app_visitor_codes SET expires_at = ? WHERE app_id = ? AND address = ?"
    )
      .bind(Date.now() - 1000, app, late)
      .run();
    const expired = await signIn(link, late, lateCode);
    // Another address's code, or a code for nobody asked.
    const someoneElses = await signIn(link, late, luckyCode);

    expect({
      wrong,
      right: right.length,
      again,
      afterFive,
      expired,
      someoneElses,
    }).toStrictEqual({
      wrong: Array.from({ length: 4 }, () => "visitor.code_invalid"),
      right: 43,
      again: "visitor.code_invalid",
      afterFive: "visitor.code_invalid",
      expired: "visitor.code_invalid",
      someoneElses: "visitor.code_invalid",
    });
  });

  it("sends at most 5 codes an hour to one address and 100 for one App, audited", async () => {
    const domain = newDomain();
    const { link, app } = await visitedApp([{ kind: "domain", value: domain }]);
    const mail = await mailbox();
    const flooded = `flood@${domain}`;

    // At once: asks at the same time send no more than the hour's 5.
    const events = await auditedDuring(async () => {
      await Promise.all(
        Array.from(
          { length: appVisitorCodesPerAddressPerHour + 1 },
          async () => await ask(link, flooded)
        )
      );
    });
    await vi.waitFor(() => {
      expect(recipients(mail)).toHaveLength(appVisitorCodesPerAddressPerHour);
    });
    const toFlooded = recipients(mail).length;

    // The App's hour: 100 codes already went out, to others.
    const now = Date.now();
    const filled = Array.from(
      { length: appVisitorCodesPerAppPerHour },
      (_, index) =>
        env.DB.prepare(
          "INSERT INTO app_visitor_codes VALUES (?, ?, ?, 'x', 0, NULL, ?, ?)"
        ).bind(crypto.randomUUID(), app, `n${index}@${domain}`, now, now + 1000)
    );
    await env.DB.batch(filled);
    const fresh = `fresh@${domain}`;
    await ask(link, fresh);

    expect({
      toFlooded,
      toFresh: recipients(mail).filter((to) => to === fresh),
      refused: visitorEvents(events, app).filter(
        ({ action }) => action === "app.visitor_refused"
      ),
    }).toStrictEqual({
      toFlooded: appVisitorCodesPerAddressPerHour,
      toFresh: [],
      refused: [
        {
          action: "app.visitor_refused",
          actor: "visitor",
          detail: { reason: "too_many_codes", address: flooded },
        },
      ],
    });
  });

  it("opens only its own App's first screen, never another App, and calls none of the App's functions", async () => {
    const domain = newDomain();
    const first = await visitedApp([{ kind: "domain", value: domain }]);
    const second = await visitedApp([{ kind: "domain", value: domain }]);
    await releasedNotes(first.builder, first.app);
    const mail = await mailbox();
    const visitor = `vi@${domain}`;

    await ask(first.link, visitor);
    const code = await lastCode(mail, visitor);
    // The first App's code, for the second App: refused.
    const elsewhere = await signIn(second.link, visitor, code);
    const token = await signIn(first.link, visitor, code);
    const opened = await open(token);
    // A token nobody was given.
    const forged = await open("A".repeat(43));

    // Its lease is for the visitor, whom no member's session is: a call
    // with it, signed out or as a member, is refused before it runs.
    const member = await signedInApi(idp, "admin");
    const lease =
      typeof opened === "string" ? "" : (opened.screen?.lease ?? "");
    const call = async (as?: Person) =>
      await answerOf(
        await routed(`${appFunctionPath}/${first.app}`, {
          method: "POST",
          headers: {
            origin: clientOrigin,
            "content-type": "application/json",
            [screenLeaseHeader]: lease,
            ...(as === undefined
              ? {}
              : { cookie: as.session, [screenPersonHeader]: as.userId }),
          },
          body: "{}",
        })
      );
    const calls = [await call(), await call(member)];

    expect({
      elsewhere,
      opened:
        typeof opened === "string"
          ? opened
          : {
              app: opened.app,
              name: opened.name,
              screen: opened.screen?.screen,
              leased: lease.length > 0,
            },
      forged,
      calls,
    }).toStrictEqual({
      elsewhere: "visitor.code_invalid",
      opened: {
        app: first.app,
        name: "Client portal",
        screen: "notes",
        leased: true,
      },
      forged: "visitor.signed_out",
      calls: [
        // No member's session: refused before anything is read.
        { status: 401, code: "auth.unauthenticated" },
        // A member, with the visitor's lease: it isn't theirs, so the
        // screen is code core didn't serve them, and refused.
        { status: 403, code: "screen.unreviewed" },
      ],
    });
  });

  it("ends at once when the App is unpublished, the address leaves the list, or the visitor signs out, all audited", async () => {
    const domain = newDomain();
    const { builder, app, link } = await visitedApp([
      { kind: "domain", value: domain },
    ]);
    const mail = await mailbox();
    const visitor = `vo@${domain}`;
    const signedInAs = async (): Promise<string> => {
      const sentBefore = mail.sent.length;
      await ask(link, visitor);
      // This ask's own code, not the one before it.
      await vi.waitFor(() => {
        expect(mail.sent.length).toBeGreaterThan(sentBefore);
      });
      return await signIn(link, visitor, await lastCode(mail, visitor));
    };

    let unpublished: unknown;
    let delisted: unknown;
    let signedOut: unknown;
    const events = await auditedDuring(async () => {
      const token = await signedInAs();
      await builder.api.apps.unpublish(app);
      unpublished = await open(token);
      await published(app);
      // Unpublishing ended the session: signed in again, then delisted.
      const again = await signedInAs();
      await builder.api.apps.setVisitors(app, []);
      delisted = await open(again);
      await builder.api.apps.setVisitors(app, [
        { kind: "domain", value: domain },
      ]);
      const next = await signedInAs();
      await post({ action: "sign_out", token: next });
      signedOut = await open(next);
    });

    expect({
      unpublished,
      delisted,
      signedOut,
      actions: visitorEvents(events, app).map(({ action, detail }) =>
        action === "app.visitor_refused"
          ? `${action}:${reasonSchema.parse(detail).reason}`
          : action
      ),
    }).toStrictEqual({
      unpublished: "visitor.signed_out",
      delisted: "visitor.signed_out",
      signedOut: "visitor.signed_out",
      actions: [
        "app.visitor_code_sent",
        "app.visitor_signed_in",
        // Unpublishing deleted the session: nothing is left to open.
        "app.visitor_code_sent",
        "app.visitor_signed_in",
        // The builder takes the domain off the list, then puts it back.
        "app.visitor_unlisted",
        "app.visitor_refused:not_listed",
        "app.visitor_listed",
        "app.visitor_code_sent",
        "app.visitor_signed_in",
        "app.visitor_signed_out",
      ],
    });
  });

  it("are listed only by the App's builders, never staff, in the form entries take, audited", async () => {
    const { builder, app } = await visitedApp([]);
    const user = await signedInApi(idp, "user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = { api: core.authenticate() };
    const domain = newDomain();

    let set: unknown;
    const events = await auditedDuring(async () => {
      set = await builder.api.apps.setVisitors(app, [
        { kind: "domain", value: domain.toUpperCase() },
        { kind: "domain", value: domain },
      ]);
    });
    const refused = await Promise.all([
      outcome(user.api.apps.setVisitors(app, [])),
      outcome(staff.api.apps.setVisitors(app, [])),
      outcome(user.api.apps.visitors(app)),
      outcome(
        builder.api.apps.setVisitors(app, [
          { kind: "domain", value: "exаmple.test" },
        ])
      ),
      outcome(
        builder.api.apps.setVisitors(app, [
          { kind: "address", value: "not an address" },
        ])
      ),
      outcome(
        builder.api.apps.setVisitors(
          app,
          Array.from({ length: 51 }, (_, index) => ({
            kind: "domain" as const,
            value: `d${index}.test`,
          }))
        )
      ),
    ]);

    expect({
      set,
      read: await builder.api.apps.visitors(app),
      refused,
      events: events
        .filter((event) => event.action.startsWith("app.visitor_"))
        .map((event) => ({
          action: event.action,
          actor: event.actor.type,
          detail: event.detail,
        })),
    }).toStrictEqual({
      // Lower case, once.
      set: [{ kind: "domain", value: domain }],
      read: [{ kind: "domain", value: domain }],
      refused: [
        "role.forbidden",
        expect.any(String),
        "role.forbidden",
        "visitor.invalid",
        "visitor.invalid",
        "visitor.invalid",
      ],
      events: [
        {
          action: "app.visitor_listed",
          actor: "person",
          detail: { kind: "domain", value: domain },
        },
      ],
    });
  });

  it("saves a long list of long addresses, and audits every entry added and removed in full", async () => {
    const { builder, app } = await visitedApp([]);
    const first = longAddresses("a");
    const second = longAddresses("b");
    let saved: unknown;
    let replaced: unknown;
    const events = await auditedDuring(async () => {
      saved = await builder.api.apps.setVisitors(app, addressEntries(first));
      replaced = await builder.api.apps.setVisitors(
        app,
        addressEntries(second)
      );
    });
    const changes = (action: string) =>
      events
        .filter((event) => event.action === action && event.target?.id === app)
        .map((event) => JSON.stringify(event.detail))
        .toSorted();
    expect({
      saved,
      replaced,
      listed: changes("app.visitor_listed"),
      unlisted: changes("app.visitor_unlisted"),
    }).toStrictEqual({
      saved: addressEntries(first.toSorted()),
      replaced: addressEntries(second.toSorted()),
      listed: addressDetails([...first, ...second]),
      unlisted: addressDetails(first),
    });
  });

  it("keeps only the domain of an address nobody listed that tries a code", async () => {
    const { app, link } = await visitedApp([
      { kind: "domain", value: newDomain() },
    ]);
    const stranger = `eve@${unique()}.test`;

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await signIn(link, stranger, "12345678");
    });

    expect({
      refused,
      events: visitorEvents(events, app),
      kept: JSON.stringify(events).includes(stranger),
    }).toStrictEqual({
      refused: "visitor.code_invalid",
      events: [
        {
          action: "app.visitor_refused",
          actor: "visitor",
          detail: { reason: "not_listed", domain: stranger.split("@")[1] },
        },
      ],
      kept: false,
    });
  });

  it("answers asking for a code before looking anything up, so its timing tells nothing", async () => {
    const domain = newDomain();
    const { link } = await visitedApp([{ kind: "domain", value: domain }]);
    const mail = await mailbox();
    const listed = `al@${domain}`;
    const stranger = `st@${unique()}.test`;

    const answers = [
      await askDeferred(link, listed),
      await askDeferred(link, stranger),
      await askDeferred(newLink(), listed),
    ];

    expect({ answers, sent: recipients(mail) }).toStrictEqual({
      // Whether listed, not listed, or no App at the link: answered while
      // the lookup was still to be done.
      answers: Array.from({ length: 3 }, () => ({
        status: 202,
        pending: [true],
      })),
      sent: [listed],
    });
  });

  it("refuse a save that raced another, so the audit names exactly what the winner replaced", async () => {
    const [kept, joined, instead] = [newDomain(), newDomain(), newDomain()];
    const { builder, app } = await visitedApp([
      { kind: "domain", value: kept },
    ]);
    const lists = {
      // Adds `joined`, keeping `kept`.
      grow: [kept, joined],
      // Takes `kept` off, adding `instead`.
      swap: [instead],
    };
    const save = async (domains: string[]) =>
      await outcome(
        builder.api.apps.setVisitors(
          app,
          domains.map((value) => ({ kind: "domain" as const, value }))
        )
      );

    let outcomes: unknown[] = [];
    const events = await auditedDuring(async () => {
      // At once: both read the list as it was before either saves.
      outcomes = await Promise.all([save(lists.grow), save(lists.swap)]);
    });
    const refused = outcomes.filter((each) => each === "visitor.list_changed");
    const winner = outcomes[0] === "visitor.list_changed" ? "swap" : "grow";
    const expected = {
      grow: { listed: [joined], unlisted: [] },
      swap: { listed: [instead], unlisted: [kept] },
    }[winner];
    const list = await builder.api.apps.visitors(app);
    const named = (action: string) =>
      visitorEvents(events, app)
        .filter((event) => event.action === action)
        .map(
          ({ detail }) => z.object({ value: z.string() }).parse(detail).value
        )
        .toSorted();

    expect({
      refused,
      list: list.map(({ value }) => value),
      listed: named("app.visitor_listed"),
      unlisted: named("app.visitor_unlisted"),
    }).toStrictEqual({
      refused: ["visitor.list_changed"],
      list: lists[winner].toSorted(),
      listed: expected.listed,
      unlisted: expected.unlisted,
    });
  });

  it("opens a visitor at the route that needs no input, whichever screen sorts first", async () => {
    const domain = newDomain();
    const { builder, app, link } = await visitedApp([
      { kind: "domain", value: domain },
    ]);
    await releasedNotes(builder, app, routedNotesFiles);
    const mail = await mailbox();
    const visitor = `ro@${domain}`;
    await ask(link, visitor);
    const token = await signIn(link, visitor, await lastCode(mail, visitor));
    const opened = await open(token);

    expect(
      typeof opened === "string"
        ? opened
        : { screen: opened.screen?.screen, route: opened.screen?.route }
    ).toStrictEqual({ screen: "home", route: "home" });
  });

  it("never keep a session past an unpublish: ending them fails the unpublish, and a sign-in that lands after one opens nothing", async () => {
    const domain = newDomain();
    const { builder, app, link } = await visitedApp([
      { kind: "domain", value: domain },
    ]);
    const mail = await mailbox();
    const visitor = `un@${domain}`;
    await ask(link, visitor);
    await signIn(link, visitor, await lastCode(mail, visitor));
    const statusOf = async () => {
      const row = await env.DB.prepare("SELECT status FROM apps WHERE id = ?")
        .bind(app)
        .first<{ status: string }>();
      return row?.status;
    };

    // Ending this App's sessions fails, as a database can: the unpublish
    // goes with it, rather than leaving sessions a republish revives.
    const blocked = `test_block_${app.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${blocked} BEFORE DELETE ON app_visitor_sessions WHEN OLD.app_id = '${app}' BEGIN SELECT RAISE(ABORT, 'unavailable'); END`
    ).run();
    const unpublish = await outcome(builder.api.apps.unpublish(app));
    await env.DB.prepare(`DROP TRIGGER ${blocked}`).run();
    const afterFailed = await statusOf();
    // Published either way for what follows.
    await published(app);

    // The App is unpublished as the code is taken, before the session
    // goes in: the sign-in opens nothing.
    const late = `late@${domain}`;
    await ask(link, late);
    const code = await lastCode(mail, late);
    const raced = `test_race_${app.replaceAll("-", "_")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${raced} AFTER UPDATE OF used_at ON app_visitor_codes WHEN NEW.app_id = '${app}' BEGIN UPDATE apps SET status = 'draft' WHERE id = '${app}'; END`
    ).run();
    const lateSignIn = await signIn(link, late, code);
    await env.DB.prepare(`DROP TRIGGER ${raced}`).run();
    await published(app);
    const lateSessions = await env.DB.prepare(
      "SELECT count(*) AS n FROM app_visitor_sessions WHERE app_id = ? AND address = ?"
    )
      .bind(app, late)
      .first<{ n: number }>();

    expect({
      unpublishRefused: unpublish !== "ok",
      afterFailed,
      lateSignIn,
      lateSessions: lateSessions?.n,
    }).toStrictEqual({
      unpublishRefused: true,
      afterFailed: "published",
      lateSignIn: "visitor.code_invalid",
      lateSessions: 0,
    });
  });

  it("forgets codes an hour on and sessions once expired", async () => {
    const domain = newDomain();
    const { app, link } = await visitedApp([{ kind: "domain", value: domain }]);
    const mail = await mailbox();
    const visitor = `sw@${domain}`;
    await ask(link, visitor);
    const token = await signIn(link, visitor, await lastCode(mail, visitor));
    const count = async () =>
      await env.DB.prepare(
        "SELECT (SELECT count(*) FROM app_visitor_codes WHERE app_id = ?1) AS codes, (SELECT count(*) FROM app_visitor_sessions WHERE app_id = ?1) AS sessions"
      )
        .bind(app)
        .first();

    await sweepAppVisitors(env, new Date());
    const now = await count();
    await sweepAppVisitors(env, new Date(Date.now() + 9 * 60 * 60 * 1000));
    const later = await count();

    expect({ token: token.length, now, later }).toStrictEqual({
      token: 43,
      now: { codes: 1, sessions: 1 },
      later: { codes: 0, sessions: 0 },
    });
  });
});
