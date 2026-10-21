import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { composioConsentText } from "@grasp-os/shared/connect";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { onboardingSummaryPurpose } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { consentCode, tokensFor } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  coreOrigin,
  openRpc,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
  withSignIn,
} from "./sign-in.ts";

// Grasp's admin's read of a client (src/admin-snapshot.ts): only Grasp's
// staff, through the console, read it, and what they read has no word
// anyone said in it. The ways it can fail, tried first:
//
// - Anyone but the console reading it: unsigned, signed with a made-up
//   signature, with the console's key for another client or for another
//   purpose, sent long ago, too large, malformed, or not through the
//   router.
// - Someone who holds a credential of this client but not the console's
//   key: a member's session, the company's admin's, a Grasp staff
//   session, or an interview link.
// - A read the company can't see in its audit log, or one served when the
//   log can't take it.
// - What someone said in their interview reaching the console.
// - Grasp reading on after the company's admin ended its staff access.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Periwinkle abacus under the harbour bridge";

/** The Grasp staff member the console says is asking. */
const staffEmail = "ada.lovelace@grasp.test";

/** `body`'s signature as the console makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminSnapshotPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

const bodyAt = (sentAt = new Date().toISOString(), email = staffEmail) =>
  JSON.stringify({ sentAt, staff: { email } });

/** Asks core for the snapshot through the router, with `headers` as given. */
const ask = async (
  body: string,
  {
    signature = null,
    cookie = null,
    method = "POST",
    coreEnv = env,
  }: {
    signature?: string | null;
    cookie?: string | null;
    method?: string;
    coreEnv?: Env;
  } = {}
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  return await routed(
    adminSnapshotPath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Asks as the console does: signed, now, for `staffEmail`. */
const askAsConsole = async (coreEnv: Env = env): Promise<Response> => {
  const body = bodyAt();
  return await ask(body, { signature: await signatureOf(body), coreEnv });
};

/** What the lead said: their words, and facts Stephen wrote from them. */
const progress = (): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What does your team do all week?" },
    { from: "person", text: sentinel, typed: true },
  ],
  facts: [
    { id: "f1", tag: "step", text: sentinel, record: sentinel },
    { id: "f2", tag: "wait", text: `${sentinel}, twice`, record: "x" },
    {
      id: "f3",
      tag: "system",
      text: "Their own sheet",
      record: "y",
      out: true,
    },
  ],
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 1,
  adding: false,
  addedAt: 0,
  rating: 4,
});

/**
 * An onboarding running since yesterday: Sales, led by Lea, whose link is
 * out and who is talking now; Sam, whose link waits for her. Some AI used.
 */
const running = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = { lea: `lea-${id}`, sam: `sam-${id}` };
  const roster: Roster = {
    teams: [
      { id: "sales", name: "Sales", lead: ids.lea, does: "", off: false },
    ],
    people: [
      {
        id: ids.lea,
        name: "Lea Lund",
        email: "lea@acme.test",
        team: "sales",
        title: "Head of Sales",
        away: false,
      },
      {
        id: ids.sam,
        name: "Sam Berg",
        email: "",
        team: "sales",
        title: "",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await store.savePlan(
    { start: yesterday.toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = (await store.linkOf(ids.lea)) ?? "";
  const secret = link.split("#")[1] ?? "";
  const mark = await sha256Hex(secret);
  const key = await sha256Hex("lea's device");
  await store.openLink(mark, null, key);
  await store.saveInterview(mark, key, 0, progress());
  await store.meter({
    purpose: "interviews",
    model: `claude-opus-${id}`,
    tokensIn: 1200,
    tokensCached: 300,
    tokensOut: 400,
  });
  // A model of its own, as the store's usage adds up over this file's tests.
  return { ids, secret, model: `claude-opus-${id}` };
};

/** An audit log that takes nothing: every call to it fails. */
const failingAuditLog = (): Env["AUDIT_LOG"] =>
  new Proxy(env.AUDIT_LOG, {
    get: (namespace, name): unknown => {
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return () =>
        new Proxy(
          {},
          {
            get: () => async () =>
              await Promise.reject(new Error("Unavailable")),
          }
        );
    },
  });

/** The snapshot reads `events` recorded. */
const snapshotReads = <T extends { action: string }>(events: T[]): T[] =>
  events.filter(({ action }) => action === "admin.snapshot.read");

describe("who reads the admin snapshot", () => {
  it("refuses anyone but the console: unsigned, signed otherwise, sent long ago, too large, malformed, or no request at all", async () => {
    await running();
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const large = JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
      pad: "x".repeat(2048),
    });
    const noStaff = JSON.stringify({ sentAt: new Date().toISOString() });
    const notEmail = bodyAt(undefined, "not an email");
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all([
        ask(fresh),
        ask(fresh, { signature: "0".repeat(64) }),
        ask(fresh, { signature: "not hex" }),
        // The console's key for another client: another auth secret.
        ask(fresh, {
          signature: await signatureOf(fresh, "another-client-auth-secret"),
        }),
        // The console's key for the onboarding summary signs nothing here.
        ask(fresh, {
          signature: await signatureOf(
            fresh,
            env.BETTER_AUTH_SECRET,
            onboardingSummaryPurpose
          ),
        }),
        ask(old, { signature: await signatureOf(old) }),
        ask(large, { signature: await signatureOf(large) }),
        ask(noStaff, { signature: await signatureOf(noStaff) }),
        ask(notEmail, { signature: await signatureOf(notEmail) }),
        ask(fresh, { signature: await signatureOf(fresh), method: "GET" }),
      ]);
      statuses.push(...responses.map(({ status }) => status));
      await Promise.all(responses.map(async (each) => await each.text()));
    });
    expect({ statuses, reads: snapshotReads(events) }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 403, 403, 403, 403, 404],
      reads: [],
    });
  });

  it("refuses the console's own signed request when it didn't come through the router", async () => {
    const body = bodyAt();
    const response = await worker.fetch(
      new Request(`${coreOrigin}${adminSnapshotPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [platformUpdateSignatureHeader]: await signatureOf(body),
        },
        body,
      }),
      env,
      createExecutionContext()
    );
    const text = await response.text();
    expect({
      status: response.status,
      named: text.includes("Lea"),
    }).toStrictEqual({
      status: 403,
      named: false,
    });
  });

  it("gives a member, the company's admin, a Grasp staff session and an interview link nothing", async () => {
    const { secret } = await running();
    const member = await signedInWithRole(idp, "user");
    const admin = await signedInWithRole(idp, "admin");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const fresh = bodyAt();
    const withLink = JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
      secret,
    });
    const responses: Response[] = [];
    const events = await auditedDuring(async () => {
      responses.push(
        ...(await Promise.all([
          ask(fresh, { cookie: member.session }),
          ask(fresh, { cookie: admin.session }),
          ask(fresh, { cookie: staff }),
          // The link's secret, as the body and as a signature would carry it.
          ask(withLink),
          ask(withLink, { signature: await sha256Hex(secret) }),
          ask(JSON.stringify({ action: "session", secret })),
        ]))
      );
    });
    const texts = await Promise.all(
      responses.map(async (each) => await each.text())
    );
    expect({
      statuses: responses.map(({ status }) => status),
      named: texts.some((text) => text.includes("Lea Lund")),
      reads: snapshotReads(events),
    }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 401],
      named: false,
      reads: [],
    });
  });
});

describe("the admin snapshot once the company ended Grasp's staff access", () => {
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();
  });

  it("is refused, and read again only through a staff window the console opens afterwards", async () => {
    await running();
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboardingGate.endStaffAccess();

    const responses: Response[] = [];
    const events = await auditedDuring(async () => {
      responses.push(await askAsConsole());
    });
    const [refused] = responses;
    const text = (await refused?.text()) ?? "";
    // A window the console opens a moment after the company said stop:
    // after the end, and not in the future.
    await scheduler.wait(5);
    const later = withSignIn({
      staff: { ...signInConfig.staff, opened: new Date().toISOString() },
    });
    const reopened = await askAsConsole(later);
    await reopened.text();

    expect({
      status: refused?.status,
      named: text.includes("Lea"),
      reads: snapshotReads(events),
      reopened: reopened.status,
    }).toStrictEqual({ status: 403, named: false, reads: [], reopened: 200 });
  });

  it("stays refused with no staff window at all, or one opened the moment it ended", async () => {
    await running();
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboardingGate.endStaffAccess();
    const ended = await env.DB.prepare(
      "SELECT staff_ended_at AS ended FROM onboarding_gate"
    ).first<{ ended: number }>();
    const noWindow = withSignIn({ staff: undefined });
    const atTheEnd = withSignIn({
      staff: {
        ...signInConfig.staff,
        opened: new Date(ended?.ended ?? 0).toISOString(),
      },
    });

    const responses = await Promise.all([
      askAsConsole(noWindow),
      askAsConsole(atTheEnd),
    ]);
    await Promise.all(responses.map(async (each) => await each.text()));

    expect({
      ended: typeof ended?.ended,
      statuses: responses.map(({ status }) => status),
    }).toStrictEqual({ ended: "number", statuses: [403, 403] });
  });
});

describe("the admin snapshot", () => {
  it("gives the console the company, its people, where each link stands and every interview in numbers, with nothing anyone said", async () => {
    const { ids, model } = await running();
    const { userId } = await signedInWithRole(idp, "admin");

    const response = await askAsConsole();
    const text = await response.text();
    const snapshot = adminSnapshotSchema.parse(JSON.parse(text));

    const today = new Date().toISOString().slice(0, 10);
    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      people: snapshot.roster?.people.map(({ id, name }) => [id, name]),
      links: snapshot.links.map(({ person, state }) => [person, state]),
      interviews: snapshot.interviews
        .filter(({ person }) => person === ids.lea)
        .map(({ startedAt, updatedAt, ...rest }) => ({
          ...rest,
          started: startedAt !== null,
          updated: updatedAt.slice(0, 10),
        })),
      agreed: snapshot.agreed,
      member: snapshot.members.some((one) => one.userId === userId),
      usage: snapshot.usage.find(({ day }) => day === today)?.use.interviews?.[
        model
      ],
      unknown: [snapshot.contacts, snapshot.works, snapshot.contract],
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      people: [
        [ids.lea, "Lea Lund"],
        [ids.sam, "Sam Berg"],
      ],
      // Sam's link waits for Lea, who is talking now.
      links: [
        [ids.lea, "progress"],
        [ids.sam, "waiting"],
      ],
      interviews: [
        {
          person: ids.lea,
          kind: "lead",
          completedAt: null,
          agreed: false,
          phase: "steps",
          stoppedAt: "steps",
          minutes: 0,
          facts: 2,
          out: 1,
          confirmed: 1,
          rating: 4,
          typed: true,
          interviewer: null,
          started: true,
          updated: today,
        },
      ],
      agreed: true,
      member: true,
      usage: {
        calls: 1,
        tokensIn: 1200,
        kept: 300,
        tokensOut: 400,
        seconds: 0,
      },
      unknown: [null, null, null],
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("Their own sheet");
    expect(text).not.toContain("What does your team do all week?");
  });

  it("counts every interview of a large roster, page after page", async () => {
    const store = onboardingStore(env);
    const id = unique();
    // More leads than one page of interviews holds, each talking now.
    const leads = Array.from({ length: 110 }, (_, at) => `lead-${at}-${id}`);
    const roster: Roster = {
      teams: leads.map((lead, at) => ({
        id: `team-${at}`,
        name: `Team ${at}`,
        lead,
        does: "",
        off: false,
      })),
      people: leads.map((lead, at) => ({
        id: lead,
        name: `Lead ${at}`,
        email: "",
        team: `team-${at}`,
        title: "",
        away: false,
      })),
    };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(roster, by);
    await store.savePlan(
      { start: new Date().toISOString().slice(0, 10), days: 14 },
      by
    );
    await store.releaseDue();
    await Promise.all(
      leads.map(async (lead) => {
        const secret = ((await store.linkOf(lead)) ?? "").split("#")[1] ?? "";
        const mark = await sha256Hex(secret);
        const key = await sha256Hex(`${lead}'s device`);
        await store.openLink(mark, null, key);
        await store.saveInterview(mark, key, 0, progress());
      })
    );

    const response = await askAsConsole();
    const snapshot = adminSnapshotSchema.parse(await response.json());

    const counted = snapshot.interviews.filter(({ person }) =>
      leads.includes(person)
    );
    expect({
      interviews: counted.length,
      facts: [...new Set(counted.map(({ facts }) => facts))],
    }).toStrictEqual({ interviews: 110, facts: [2] });
  });

  it("puts every read in the company's audit log, by the staff member the console names", async () => {
    await running();

    const events = await auditedDuring(async () => {
      const response = await askAsConsole();
      await response.text();
    });

    expect(
      snapshotReads(events).map(({ actor, target }) => ({ actor, target }))
    ).toStrictEqual([
      {
        actor: { type: "staff", userId: staffEmail, via: "console" },
        target: { type: "organization", id: "organization" },
      },
    ]);
  });

  it("answers nothing when the audit log can't take the read", async () => {
    await running();

    // The failed request is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const response = await askAsConsole({
      ...env,
      AUDIT_LOG: failingAuditLog(),
    });
    const text = await response.text();
    const errors = JSON.stringify(logged.mock.calls, (_key, value: unknown) =>
      value instanceof Error ? value.message : value
    );
    logged.mockRestore();

    expect({
      status: response.status,
      named: text.includes("Lea"),
      // It failed for the audit log, and nothing else.
      audit: errors.includes("Unavailable"),
    }).toStrictEqual({
      status: 500,
      named: false,
      audit: true,
    });
  });

  it("says when the kickoff came in and how much of it is known, and nothing it said", async () => {
    await running();
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    const saved = await store.saveKickoff(
      {
        transcript: `${sentinel}. We sell boats.`,
        fileName: `${sentinel}.vtt`,
        reading: {
          fields: {
            business: { text: sentinel, quote: sentinel },
            goals: { text: "Fewer handovers", quote: sentinel },
          },
          ask: { pain: `${sentinel}?` },
          teams: [{ name: sentinel, does: sentinel }],
        },
      },
      by
    );
    await store.answerKickoff("pain", sentinel, by);

    const response = await askAsConsole();
    const text = await response.text();
    const snapshot = adminSnapshotSchema.parse(JSON.parse(text));

    expect({
      status: response.status,
      kickoff: snapshot.kickoff,
    }).toStrictEqual({
      status: 200,
      // Business and goals from the reading, pain from the answer: 3 of 10.
      kickoff: { at: saved.transcript?.at, known: 0.3 },
    });
    expect(text).not.toContain(sentinel);
  });
});

/** An admin, signed in, with their `connections` API and who they are to core. */
const admin = async () => {
  const { session, userId, person } = await signedInWithRole(idp, "admin");
  const { core } = await openRpc(session);
  const identity: Identity = {
    userId,
    email: String(person.email),
    name: String(person.name),
    role: "admin",
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return {
    session,
    identity,
    connections: core.authenticate().connections,
  };
};

type Admin = Awaited<ReturnType<typeof admin>>;

/** The provider, or Composio, sending `session`'s browser back to core. */
const backFromProvider = async (
  session: string,
  query: Record<string, string>
): Promise<void> => {
  await routed(
    `/api/connections/callback?${new URLSearchParams(query).toString()}`,
    { headers: { cookie: session } }
  );
};

/** HubSpot, connected through Composio by `by`: the new connection's ID. */
const connectHubspot = async (by: Admin): Promise<string> => {
  const { url } = await by.connections.connectToolkit({
    toolkit: "hubspot",
    tools: ["HUBSPOT_LIST_CONTACTS"],
    consent: composioConsentText,
    returnTo: "/connections",
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  await backFromProvider(by.session, { state, status: "success" });
  const listed = await by.connections.list();
  const hubspot = listed.find(({ provider }) => provider === "hubspot");
  if (hubspot === undefined) {
    throw new Error("HubSpot wasn't connected");
  }
  return hubspot.id;
};

/** The snapshot as the console reads it, and its text as it came. */
const snapshotNow = async () => {
  const response = await askAsConsole();
  const text = await response.text();
  return { text, snapshot: adminSnapshotSchema.parse(JSON.parse(text)) };
};

/** A workflow's input or output schema: an object of `properties`. */
const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The descriptor of an object with no fields, and of null. */
const emptyObject = {
  descriptorVersion: 1,
  kind: "object",
  presence: "required",
  nullable: false,
  fields: {},
};
const nullValue = {
  descriptorVersion: 1,
  kind: "null",
  presence: "required",
  nullable: false,
};

/**
 * A workflow whose current version binds `crm` to HubSpot, as an admin
 * approved through the workflow's own permission on `connectionId`, and
 * declares `mail`, which no connection was approved for yet.
 */
const crmWorkflow = async (by: Admin, connectionId: string) => {
  const key = `crm-${unique()}`;
  const operation = {
    input: JSON.stringify(emptyObject),
    output: JSON.stringify(nullValue),
  };
  await publishCatalogContract(env, by.identity, {
    key,
    kind: "connector",
    operations: { HUBSPOT_LIST_CONTACTS: operation },
  });
  const workflow = await createWorkflowResource(
    env,
    by.identity,
    `crm-${unique()}`
  );
  const binding = (alias: string) => ({
    [alias]: { kind: "connector", contract: key },
  });
  await publishWorkflowVersion(env, by.identity, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { ...binding("crm"), ...binding("mail") },
          },
        },
      },
      input: { schema: objectSchema({}) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        ...["crm", "mail"].map((alias) => ({
          [alias]: {
            call: "grasp.connector",
            with: {
              binding: alias,
              operation: "HUBSPOT_LIST_CONTACTS",
              arguments: {},
            },
          },
        })),
        { finish: { set: { status: "done" } } },
      ],
    }),
    basedOn: null,
  });
  const asked = await requestPermission(
    env,
    by.identity,
    {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "connection", connectionId },
      actions: ["HUBSPOT_LIST_CONTACTS"],
      binding: `CRM_${unique().toUpperCase()}`,
    },
    {
      app: async () => await Promise.reject(new Error("No App here")),
      resource: async (ref, needed) => {
        await requireResourceRole(env, by.identity, ref, needed);
      },
    }
  );
  await grantPermission(env, by.identity, asked.id, { version: null });
  // What connect serves the connection as: HubSpot's tool, as Composio's
  // server would list it.
  const served: ConnectorContract = {
    contract: "composio.hubspot@1",
    actions: {
      HUBSPOT_LIST_CONTACTS: {
        tool: "HUBSPOT_LIST_CONTACTS",
        readOnly: false,
        input: JSON.stringify(
          jsonSchemaOf(schemaFromDescriptor(operation.input).descriptor, {
            exact: true,
          })
        ),
        output: JSON.stringify(
          jsonSchemaOf(schemaFromDescriptor(operation.output).descriptor, {
            exact: true,
          })
        ),
      },
    },
  };
  const connecting: Env = {
    ...env,
    CONNECT: new Proxy(env.CONNECT, {
      get: (target, name): unknown =>
        name === "connectorContract"
          ? async () => await Promise.resolve(served)
          : Reflect.get(target, name),
    }),
  };
  await approveWorkflowBinding(connecting, by.identity, workflow.id, {
    alias: "crm",
    target: {
      kind: "connector",
      permissionId: asked.id,
      contract: "composio.hubspot@1",
    },
    reviewed: { version: 1 },
  });
  return workflow;
};

describe("what the snapshot says the company connected and still needs", () => {
  it("names a workflow bound to an app that isn't connected any more, and one binding no connection serves yet", async () => {
    const by = await admin();
    const hubspot = await connectHubspot(by);
    const workflow = await crmWorkflow(by, hubspot);

    const connected = await snapshotNow();
    await by.connections.disconnect(hubspot);
    const disconnected = await snapshotNow();

    const needsOf = ({ snapshot }: typeof connected) =>
      snapshot.integrations?.needed.filter(
        (need) => need.workflow.id === workflow.id
      );
    expect({
      connected: needsOf(connected),
      disconnected: needsOf(disconnected),
    }).toStrictEqual({
      // Connected, HubSpot serves `crm`; nothing is approved for `mail`.
      connected: [
        {
          workflow: { id: workflow.id, name: workflow.name },
          alias: "mail",
          app: null,
          state: "unbound",
        },
      ],
      disconnected: [
        {
          workflow: { id: workflow.id, name: workflow.name },
          alias: "crm",
          app: { source: "composio", provider: "hubspot" },
          state: "missing",
        },
        {
          workflow: { id: workflow.id, name: workflow.name },
          alias: "mail",
          app: null,
          state: "unbound",
        },
      ],
    });
  });

  it("says what the company connected, its people's own counted by app, and carries no token, server URL or account of theirs", async () => {
    const by = await admin();
    const hubspot = await connectHubspot(by);
    // Anna connects her own mailbox.
    const anna = await signedInWithRole(idp, "user");
    const { core } = await openRpc(anna.session);
    const annas = core.authenticate().connections;
    const account = String(anna.person.oid);
    const { url } = await annas.start({
      provider: "microsoft",
      scope: "personal",
      returnTo: "/connections",
    });
    const authorization = new URL(url);
    await backFromProvider(anna.session, {
      code: consentCode(authorization, acmeTenant, account),
      state: authorization.searchParams.get("state") ?? "",
    });
    // What connect holds of HubSpot: its account at Composio.
    const [held] = await env.CONNECT.connectionOwners([hubspot]);

    const { text, snapshot } = await snapshotNow();

    const { connectedAt, ...hubspotRow } =
      snapshot.integrations?.connected.find(
        ({ provider }) => provider === "hubspot"
      ) ?? {};
    expect({
      hubspot: hubspotRow,
      connectedToday: connectedAt?.slice(0, 10),
      microsoft: snapshot.integrations?.personal.some(
        ({ provider, people }) => provider === "microsoft" && people > 0
      ),
    }).toStrictEqual({
      hubspot: {
        source: "composio",
        provider: "hubspot",
        state: "works",
        hidden: false,
        connectedBy: by.identity.name,
        account: null,
        tools: ["HUBSPOT_LIST_CONTACTS"],
      },
      connectedToday: new Date().toISOString().slice(0, 10),
      microsoft: true,
    });
    const secrets = [
      // Anna's tokens, her account and her address.
      ...tokensFor(account),
      account,
      `${account}@acme.test`,
      // What Composio knows HubSpot's connection by, and where its server is.
      held?.accountId ?? "no account",
      "composio.dev",
      "https://",
    ];
    expect(secrets.filter((secret) => text.includes(secret))).toStrictEqual([]);
  });
});
