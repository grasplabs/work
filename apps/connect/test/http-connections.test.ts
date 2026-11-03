import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import type { HttpConnectionInput } from "@grasp-os/shared/http-connections";
import { env, exports } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { appFor, auditEvents, callAs, outcome, someone } from "./connect.ts";
import type { Call } from "./connect.ts";

// HTTP connections (src/http-connections.ts), from their threat model: an
// origin inside a network, or one whose name leads inside; a request off
// the paths or methods an admin approved; a redirect off the origin; the
// credential leaking back; a call nobody can trace. Only the outside is
// fake: the API, and the DNS resolver connect asks.

const secret = "the-billing-api-test-credential";

/** What each name resolves to, by record type, as the fake DNS answers. */
const dns = new Map<string, { A: string[]; AAAA: string[] }>();

/** One request that reached the fake API. */
interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sent: Sent[] = [];

/** The fake API's answer to `request` on `url`. */
const answer = (request: Request, url: URL): Response => {
  switch (url.pathname) {
    case "/v1/invoices": {
      return Response.json(
        { method: request.method, invoices: [{ id: "inv-1" }] },
        {
          status: request.method === "POST" ? 201 : 200,
          headers: { "set-cookie": "session=abc", "x-request-id": "req-1" },
        }
      );
    }
    case "/v1/moved": {
      return new Response(null, {
        status: 302,
        headers: { location: "https://collector.example/steal" },
      });
    }
    case "/v1/hop": {
      return new Response(null, {
        status: 302,
        headers: { location: "/v1/invoices?from=hop" },
      });
    }
    case "/v1/huge": {
      return new Response("x".repeat(600 * 1024));
    }
    default: {
      return new Response("not found", { status: 404 });
    }
  }
};

/** The DNS resolver's JSON answer for `url`'s name and type. */
const resolve = (url: URL): Response => {
  const name = url.searchParams.get("name") ?? "";
  const type = url.searchParams.get("type") === "AAAA" ? "AAAA" : "A";
  const records = dns.get(name);
  if (records === undefined) {
    return Response.json({ Status: 3 });
  }
  return Response.json({
    Status: 0,
    Answer: records[type].map((data) => ({
      name,
      type: type === "A" ? 1 : 28,
      TTL: 60,
      data,
    })),
  });
};

const admin = (): ConnectionPerson => someone("admin");

/** An API an admin approves, unless `changes` say otherwise. */
const billing = (
  changes: Partial<HttpConnectionInput> = {}
): HttpConnectionInput => ({
  name: "Billing API",
  origin: "https://api.billing.example",
  pathPrefixes: ["/v1"],
  methods: ["GET", "POST"],
  credential: { kind: "header", header: "X-Api-Key", secret },
  ...changes,
});

const create = async (
  connection: HttpConnectionInput = billing(),
  person: ConnectionPerson = admin()
): Promise<string> => {
  const { connectionId } = await exports.default.createHttpConnection({
    person,
    connection,
  });
  return connectionId;
};

const app = appFor("user-anna", "app-invoices");

/** Every audit event as text, to look for the secret in. */
const allText = (events: readonly AuditEvent[]): string =>
  JSON.stringify(events);

const { events } = auditEvents();

describe("HTTP connections", () => {
  beforeEach(() => {
    sent.length = 0;
    dns.clear();
    dns.set("api.billing.example", { A: ["93.184.216.34"], AAAA: [] });
    dns.set("inside.billing.example", { A: ["10.0.0.7"], AAAA: [] });
    dns.set("v6inside.billing.example", {
      A: ["93.184.216.35"],
      AAAA: ["fd00::1"],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com") {
        return resolve(url);
      }
      sent.push({
        method: request.method,
        url: url.href,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return answer(request, url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are approved by an admin only, on a public https origin, and audited without the credential", async () => {
    const refused = [
      await outcome(create(billing(), someone("user"))),
      await outcome(create(billing(), { ...admin(), staff: true })),
      await outcome(create(billing({ origin: "http://api.billing.example" }))),
      await outcome(create(billing({ origin: "https://10.0.0.7" }))),
      await outcome(create(billing({ origin: "https://billing.internal" }))),
      await outcome(
        create(billing({ origin: "https://api.billing.example/v1" }))
      ),
      await outcome(
        create(billing({ origin: "https://inside.billing.example" }))
      ),
      await outcome(
        create(billing({ origin: "https://v6inside.billing.example" }))
      ),
      await outcome(create(billing({ origin: "https://nowhere.example" }))),
      await outcome(create(billing({ pathPrefixes: ["/v1/../admin"] }))),
    ];
    const person = admin();
    const connectionId = await create(billing(), person);
    const connections = await exports.default.listConnections(person);
    const listed = connections.find(({ id }) => id === connectionId);
    const recorded = await events();

    expect(refused).toStrictEqual([
      "role.forbidden",
      "connection.staff_not_allowed",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.http_origin_refused",
      "connection.http_origin_refused",
      "connection.http_origin_refused",
      "connection.invalid",
    ]);
    expect(listed).toMatchObject({
      source: "http",
      provider: "http",
      scope: "shared",
      status: "active",
      accountName: "Billing API",
      http: {
        name: "Billing API",
        origin: "https://api.billing.example",
        pathPrefixes: ["/v1"],
        methods: ["GET", "POST"],
        credentialHeader: "x-api-key",
      },
    });
    expect({
      outcomes: recorded
        .filter(({ action }) => action === "connection.connect")
        .map(({ detail }) => detail.outcome),
      secretShown: JSON.stringify([recorded, listed]).includes(secret),
      sent,
    }).toStrictEqual({
      outcomes: ["refused", "refused", "refused", "refused", "refused", "ok"],
      secretShown: false,
      sent: [],
    });
  });

  it("send an allowed read to the origin with the credential, and hand back neither it nor cookies, audited by method, path and status", async () => {
    const connectionId = await create();
    const call: Call = {
      connectionId,
      action: "get",
      input: {
        path: "/v1/invoices?status=open",
        headers: { accept: "application/json" },
      },
    };
    const result = await callAs(app, call);
    const answered: unknown = JSON.parse(result.output);
    const recorded = await events();
    const audited = recorded.find(({ action }) => action === "connection.call");

    expect(
      sent.map(({ method, url, headers }) => ({
        method,
        url,
        accept: headers.accept,
        key: headers["x-api-key"],
      }))
    ).toStrictEqual([
      {
        method: "GET",
        url: "https://api.billing.example/v1/invoices?status=open",
        accept: "application/json",
        key: secret,
      },
    ]);
    // Neither the credential nor a cookie comes back.
    expect(answered).toStrictEqual({
      status: 200,
      body: JSON.stringify({ method: "GET", invoices: [{ id: "inv-1" }] }),
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });
    expect(audited?.detail).toMatchObject({
      outcome: "ok",
      action: "get",
      sideEffect: false,
      subjectId: "app-invoices",
      onBehalfOf: "user-anna",
      httpMethod: "GET",
      httpPath: "/v1/invoices",
      httpStatus: 200,
      httpBytes: JSON.stringify({ method: "GET", invoices: [{ id: "inv-1" }] })
        .length,
    });
    // Neither the credential nor the query is audited.
    expect(
      [secret, "status=open"].filter((text) => allText(recorded).includes(text))
    ).toStrictEqual([]);
  });

  it("refuse a request off the approved paths, methods or headers, with nothing sent, audited", async () => {
    const connectionId = await create();
    const asks: Omit<Call, "connectionId">[] = [
      { action: "get", input: { path: "/admin/users" } },
      { action: "get", input: { path: "/v1/../admin" } },
      { action: "get", input: { path: "/v1/%2e%2e/admin" } },
      { action: "get", input: { path: "/v1%2F..%2Fadmin" } },
      { action: "get", input: { path: "/v10/invoices" } },
      { action: "get", input: { path: "//collector.example/v1" } },
      { action: "get", input: { path: "https://collector.example/v1" } },
      {
        action: "get",
        input: { path: "/v1/invoices", headers: { "X-Api-Key": "mine" } },
      },
      {
        action: "get",
        input: { path: "/v1/invoices", headers: { authorization: "x" } },
      },
      {
        action: "get",
        input: {
          path: "/v1/invoices",
          headers: { "x-http-method-override": "DELETE" },
        },
      },
      {
        action: "send",
        input: { method: "DELETE", path: "/v1/invoices" },
        idempotencyKey: "run-1:delete",
      },
    ];
    const refused = await Promise.all(
      asks.map(
        async (ask) => await outcome(callAs(app, { connectionId, ...ask }))
      )
    );
    const recorded = await events();

    expect({
      refused,
      sent,
      audited: recorded
        .filter(({ action }) => action === "connection.call")
        .map(({ detail }) => detail.outcome),
    }).toStrictEqual({
      refused: asks.map(() => "connect.http_refused"),
      sent: [],
      audited: asks.map(() => "refused"),
    });
  });

  it("refuse a redirect off the origin, and follow one on its own paths", async () => {
    const connectionId = await create();
    const moved = await outcome(
      callAs(app, { connectionId, action: "get", input: { path: "/v1/moved" } })
    );
    const hopped = await callAs(app, {
      connectionId,
      action: "get",
      input: { path: "/v1/hop" },
    });

    expect(moved).toBe("connect.http_refused");
    expect(JSON.parse(hopped.output)).toMatchObject({ status: 200 });
    expect(sent.map(({ url }) => url)).toStrictEqual([
      "https://api.billing.example/v1/moved",
      "https://api.billing.example/v1/hop",
      "https://api.billing.example/v1/invoices?from=hop",
    ]);
  });

  it("refuse a call once the origin's name leads inside a network, with nothing sent", async () => {
    const connectionId = await create();
    dns.set("api.billing.example", { A: ["127.0.0.1"], AAAA: [] });
    const toLoopback = await outcome(
      callAs(app, {
        connectionId,
        action: "get",
        input: { path: "/v1/invoices" },
      })
    );
    dns.set("api.billing.example", { A: ["169.254.169.254"], AAAA: [] });
    const toMetadata = await outcome(
      callAs(app, {
        connectionId,
        action: "get",
        input: { path: "/v1/invoices" },
      })
    );

    expect([toLoopback, toMetadata]).toStrictEqual([
      "connect.http_refused",
      "connect.http_refused",
    ]);
    expect(sent).toStrictEqual([]);
  });

  it("send a change from a workflow run once, under its key, with its body", async () => {
    const connectionId = await create();
    const send: Call = {
      connectionId,
      action: "send",
      input: {
        method: "POST",
        path: "/v1/invoices",
        headers: { "content-type": "application/json" },
        body: '{"amount":10}',
      },
      idempotencyKey: "run-1:invoice",
    };
    const unkeyed = await outcome(
      callAs(app, { ...send, idempotencyKey: undefined })
    );
    const first = await callAs(app, send);
    const repeat = await callAs(app, send);

    expect(unkeyed).toBe("connect.idempotency_key_required");
    expect(JSON.parse(first.output)).toMatchObject({ status: 201 });
    expect(repeat.output).toBe(first.output);
    expect(sent).toStrictEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://api.billing.example/v1/invoices",
        body: '{"amount":10}',
      }),
    ]);
  });

  it("hold a change a person is there for, and every call of a context that read restricted data", async () => {
    const connectionId = await create();
    const person = appFor("user-anna", "app-invoices");
    const interactive = { ...person, mode: "interactive" as const };
    const held = await callAs(interactive, {
      connectionId,
      action: "send",
      input: { method: "POST", path: "/v1/invoices", body: "{}" },
    });
    const restrictedRead = await callAs(
      interactive,
      { connectionId, action: "get", input: { path: "/v1/invoices" } },
      { restricted: true }
    );

    expect(held.pending).toBeDefined();
    expect(restrictedRead.pending).toBeDefined();
    expect(sent).toStrictEqual([]);
  });

  it("fail a read whose answer is over the limit, and serve only the actions its methods allow", async () => {
    const readOnly = await create(billing({ methods: ["GET"] }));
    const huge = await outcome(
      callAs(app, {
        connectionId: readOnly,
        action: "get",
        input: { path: "/v1/huge" },
      })
    );
    const contract = await exports.default.connectorContract({
      contract: "http.request@1",
      connectionId: readOnly,
    });
    const noSend = await outcome(
      callAs(app, {
        connectionId: readOnly,
        action: "send",
        input: { method: "POST", path: "/v1/invoices" },
        idempotencyKey: "run-2:invoice",
      })
    );

    expect(huge).toBe("connect.server_unavailable");
    expect(Object.keys(contract.actions)).toStrictEqual(["get"]);
    expect(noSend).toBe("connect.action_not_found");
  });

  it("stop taking calls and drop the credential once disconnected", async () => {
    const person = admin();
    const connectionId = await create(billing(), person);
    await exports.default.disconnect({ person, connectionId });
    const after = await outcome(
      callAs(app, {
        connectionId,
        action: "get",
        input: { path: "/v1/invoices" },
      })
    );
    const row = await env.DB.prepare(
      "SELECT sealed FROM http_connections WHERE connection_id = ?"
    )
      .bind(connectionId)
      .first<{ sealed: string | null }>();

    expect(after).toBe("connect.connection_inactive");
    expect(row).toStrictEqual({ sealed: null });
    expect(sent).toStrictEqual([]);
  });
});
