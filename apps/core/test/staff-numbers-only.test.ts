import { auditExportPath } from "@grasp-os/shared/audit-log";
import { screenPersonHeader } from "@grasp-os/shared/screen-limits";
import { uploadOriginalPath } from "@grasp-os/shared/uploads";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Grasp staff see numbers only (GRA-1087, its threat model): a staff
// session, which holds the admin role, gets none of a client's free text,
// over `/rpc` or a route, while an admin who isn't staff still does. The
// ways it can fail, tried here:
// 1. A namespace or method serving text lets staff through, because it
//    checks the admin role and not staff.
// 2. A route serving text skips the RPC's check.
// 3. A refusal tells staff what exists: it comes after a lookup, so an ID
//    that doesn't exist answers otherwise than one that does.
// 4. An admin who isn't staff loses what is theirs.

const idp = mockIdp();

/** A staff session and its API, on a connection of its own. */
const staffOn = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return { session, api: core.authenticate() };
};

/** An ID nothing has. */
const missing = () => crypto.randomUUID();

/**
 * What each surface serving a client's text answers `api`: "ok", or the
 * code of its refusal.
 */
const textSurfaces = async (
  api: Awaited<ReturnType<typeof staffOn>>["api"]
): Promise<Record<string, string>> => ({
  collections: await outcome(api.knowledge.listCollections()),
  search: await outcome(api.knowledge.search("policy")),
  recall: await outcome(api.knowledge.recall({ query: "policy" })),
  document: await outcome(api.knowledge.getDocument(missing())),
  memory: await outcome(api.memory.collections()),
  upload: await outcome(api.uploads.get(missing())),
  signals: await outcome(api.knowledgeSignals.list()),
  notes: await outcome(api.brain.notes()),
  changes: await outcome(
    api.brain.changes({ since: new Date(Date.now() - 60_000).toISOString() })
  ),
  chats: await outcome(api.chats.list()),
  stores: await outcome(api.stores.backfill(missing())),
  submissions: await outcome(api.screenSubmissions.list()),
  decisions: await outcome(api.decisions.waiting()),
  decision: await outcome(api.decisions.get(missing())),
  runStatus: await outcome(api.workflows.status(missing())),
  runHistory: await outcome(api.workflows.history(missing())),
  auditSearch: await outcome(api.audit.search()),
});

/** A response's error code, or its status when it has none. */
const codeOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null && "code" in body
      ? body.code
      : undefined;
  return typeof code === "string" ? code : String(response.status);
};

/**
 * What the routes serving a client's text answer `session`, signed in as
 * `userId`: each one's status and error code.
 */
const textRoutes = async (
  session: string,
  userId: string
): Promise<Record<string, string>> => {
  const exported = await routed(`${auditExportPath}?format=csv`, {
    headers: { cookie: session },
  });
  const original = await routed(uploadOriginalPath(missing()), {
    headers: { cookie: session },
  });
  const called = await routed(`/api/app-functions/${missing()}`, {
    method: "POST",
    headers: {
      cookie: session,
      origin: clientOrigin,
      "content-type": "application/json",
      [screenPersonHeader]: userId,
    },
    body: JSON.stringify({}),
  });
  return {
    auditExport: `${exported.status}`,
    uploadOriginal: `${original.status} ${await codeOf(original)}`,
    appFunction: `${called.status} ${await codeOf(called)}`,
  };
};

describe("Grasp staff, numbers only", () => {
  it("get no client text on any surface that serves it, refused before anything is looked up", async () => {
    const { api } = await staffOn();
    const refused = await textSurfaces(api);

    expect(refused).toStrictEqual(
      Object.fromEntries(
        Object.keys(refused).map((surface) => [surface, "role.forbidden"])
      )
    );
  });

  it("are refused by every route that serves client text", async () => {
    const { session, api } = await staffOn();
    const { userId } = await api.whoami();
    const routes = await textRoutes(session, userId);

    expect(routes).toStrictEqual({
      auditExport: "403",
      uploadOriginal: "403 role.forbidden",
      appFunction: "403 role.forbidden",
    });
  });

  it("keep what is numbers only: who they are, and the audit log's verification", async () => {
    const { api } = await staffOn();
    const who = await api.whoami();

    expect({
      who: who.staff,
      verify: await outcome(api.audit.verify()),
    }).toStrictEqual({ who: true, verify: "ok" });
  });

  it("leave an admin who isn't staff everything they had", async () => {
    const admin = await signedInApi(idp, "admin");
    const answers = await textSurfaces(admin.api);
    const routes = await textRoutes(admin.session, admin.userId);

    // Never refused for who they are: what doesn't exist is not found.
    expect(
      Object.entries(answers).filter(([, code]) => code === "role.forbidden")
    ).toStrictEqual([]);
    expect({
      collections: answers.collections,
      search: answers.search,
      notes: answers.notes,
      chats: answers.chats,
      auditSearch: answers.auditSearch,
      auditExport: routes.auditExport,
      uploadOriginal: routes.uploadOriginal,
    }).toStrictEqual({
      collections: "ok",
      search: "ok",
      notes: "ok",
      chats: "ok",
      auditSearch: "ok",
      auditExport: "200",
      uploadOriginal: "404 request.not_found",
    });
    expect(routes.appFunction).not.toMatch(/role\.forbidden/u);
  });
});
