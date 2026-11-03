import type { AuditEvent } from "@grasp-os/shared/audit";
import { signCapability } from "@grasp-os/shared/capability";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { httpLimits } from "@grasp-os/shared/http-connections";
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
import { z } from "zod";

import {
  appFor,
  auditEvents,
  callAs,
  connectWith,
  originOf,
  outcome,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";

// HTTP connections (src/http-connections.ts), from their threat model: an
// origin inside a network, or one whose name leads inside; a request off
// the paths or methods an admin approved; a redirect off the origin; the
// credential leaking back; a call nobody can trace. Only the outside is
// fake: the API, and the DNS resolver connect asks.

const secret = "the-billing-api-test-credential";

/**
 * What the fake DNS answers for one record type: its addresses, a 503 of
 * the resolver itself, or SERVFAIL (DNS status 2).
 */
type Records = string[] | "unavailable" | "servfail";

/** What each name resolves to, by record type, as the fake DNS answers. */
const dns = new Map<string, { A: Records; AAAA: Records }>();

/** One request that reached the fake API. */
interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sent: Sent[] = [];

/**
 * A body that sends one chunk and then nothing, never ending, until the
 * request's signal aborts: then it errors, as a real fetch's body does.
 */
const drippingBody = (signal: AbortSignal | null | undefined) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('{"invoices":['));
      signal?.addEventListener("abort", () => {
        controller.error(signal.reason);
      });
    },
  });

/** The fake API's answer to `request` on `url`. */
const answer = (
  request: Request,
  url: URL,
  signal: AbortSignal | null | undefined
): Response => {
  switch (url.pathname) {
    case "/v1/echo": {
      // A debugging endpoint: the request's headers, back in the body and
      // in a header of its own.
      const headers = Object.fromEntries(request.headers);
      return Response.json(
        { headers },
        {
          headers: {
            "x-echo": `${request.headers.get("authorization") ?? ""} ${request.headers.get("x-api-key") ?? ""}`,
          },
        }
      );
    }
    case "/v1/echo-escaped": {
      // The same, as an encoder that escapes `/` too writes it.
      const headers = Object.fromEntries(request.headers);
      return new Response(JSON.stringify({ headers }).replaceAll("/", "\\/"), {
        headers: { "content-type": "application/json" },
      });
    }
    case "/v1/bytes": {
      // Not UTF-8: three bytes, which decode to more as text.
      return new Response(new Uint8Array([0xff, 0xfe, 0x41]));
    }
    case "/v1/drip": {
      return new Response(drippingBody(signal));
    }
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
    case "/v1/semicolon": {
      // On the origin, but to a `..;` segment that leads off the paths.
      return new Response(null, {
        status: 302,
        headers: { location: "/v1/..;/admin" },
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
  const all = dns.get(name);
  if (all === undefined) {
    return Response.json({ Status: 3 });
  }
  const records = all[type];
  if (records === "unavailable") {
    return new Response("unavailable", { status: 503 });
  }
  if (records === "servfail") {
    return Response.json({ Status: 2 });
  }
  return Response.json({
    Status: 0,
    Answer: records.map((data) => ({
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
      return answer(request, url, init?.signal);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // A credential a header can't carry as it is: past ASCII, or a
      // control that could end the header.
      await outcome(
        create(
          billing({
            credential: {
              kind: "header",
              header: "X-Api-Key",
              secret: "clé-of-a-test-credential",
            },
          })
        )
      ),
      await outcome(
        create(
          billing({
            credential: {
              kind: "bearer",
              token: "a\u0085b-of-a-test-credential",
            },
          })
        )
      ),
      // One so short it could match ordinary text in an answer.
      await outcome(
        create(
          billing({ credential: { kind: "bearer", token: "short-token" } })
        )
      ),
      // One with a space or tab at either end, which `fetch` trims, so it
      // would go out as another text than the one its scrub looks for.
      ...(await Promise.all(
        [` ${secret}`, `${secret}\t`].map(
          async (token) =>
            await outcome(
              create(billing({ credential: { kind: "bearer", token } }))
            )
        )
      )),
      // A prefix with a query, empty or not.
      await outcome(create(billing({ pathPrefixes: ["/v1?"] }))),
      await outcome(create(billing({ pathPrefixes: ["/v1?a=b"] }))),
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
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
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

  it("ask an admin to try again when DNS can't answer, and take a failed IPv6 lookup beside a good IPv4 one as no IPv6", async () => {
    dns.set("down.billing.example", { A: "unavailable", AAAA: [] });
    dns.set("servfail.billing.example", { A: "servfail", AAAA: "servfail" });
    dns.set("v6down.billing.example", {
      A: ["93.184.216.36"],
      AAAA: "unavailable",
    });
    dns.set("v6servfail.billing.example", {
      A: ["93.184.216.37"],
      AAAA: "servfail",
    });
    const answered = await Promise.all(
      ["down", "servfail", "v6down", "v6servfail"].map(
        async (name) =>
          await outcome(
            create(billing({ origin: `https://${name}.billing.example` }))
          )
      )
    );
    const recorded = await events();

    expect({
      answered,
      // Nothing to refuse: only the approval is audited.
      audited: recorded
        .filter(({ action }) => action === "connection.connect")
        .map(({ detail }) => detail.outcome),
    }).toStrictEqual({
      answered: [
        "connect.server_unavailable",
        "connect.server_unavailable",
        "ok",
        "ok",
      ],
      audited: ["ok", "ok"],
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
    await callAs(app, {
      connectionId,
      action: "get",
      input: { path: "/v1/bytes" },
    });
    const recorded = await events();
    const calls = recorded.filter(({ action }) => action === "connection.call");
    const audited = calls.find(
      ({ detail }) => detail.httpPath === "/v1/invoices"
    );
    const notText = calls.find(({ detail }) => detail.httpPath === "/v1/bytes");

    expect(
      sent.slice(0, 1).map(({ method, url, headers }) => ({
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
    // The bytes as they came, not as many as their text takes.
    expect(notText?.detail.httpBytes).toBe(3);
    // Neither the credential nor the query is audited.
    expect(
      [secret, "status=open"].filter((text) => allText(recorded).includes(text))
    ).toStrictEqual([]);
  });

  it("send a query as it is, encoded separators and URLs in it too: only the path is matched", async () => {
    const connectionId = await create();
    const paths = [
      "/v1/invoices?callback=https%3A%2F%2Fexample.com%2Fdone",
      "/v1/invoices?next=../admin&dir=a%2e%2eb%5cc",
      "/v1/invoices?to=/admin/users",
    ];
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      await callAs(app, { connectionId, action: "get", input: { path } });
    }

    expect(sent.map(({ url }) => url)).toStrictEqual(
      paths.map((path) => `https://api.billing.example${path}`)
    );
  });

  it("list every HTTP connection, past the most one statement binds", async () => {
    const person = admin();
    const created = new Set<string>();
    // One more than D1 binds to a statement.
    for (let index = 0; index < 101; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      created.add(await create(billing({ name: `API ${index}` }), person));
    }
    const listed = await exports.default.listConnections(person);
    const ours = listed.filter(({ id }) => created.has(id));

    expect({
      listed: ours.length,
      described: ours.filter(({ http }) => http !== undefined).length,
    }).toStrictEqual({ listed: 101, described: 101 });
  });

  it("refuse a request off the approved paths, methods or headers, with nothing sent, audited", async () => {
    const connectionId = await create();
    const asks: Omit<Call, "connectionId">[] = [
      { action: "get", input: { path: "/admin/users" } },
      { action: "get", input: { path: "/v1/../admin" } },
      { action: "get", input: { path: "/v1/%2e%2e/admin" } },
      { action: "get", input: { path: "/v1%2F..%2Fadmin" } },
      // A segment's `;params`, which servers drop before resolving `..`.
      { action: "get", input: { path: "/v1/..;/admin" } },
      { action: "get", input: { path: "/v1/invoices;jsessionid=x" } },
      // Encoded twice, for a server that decodes twice.
      { action: "get", input: { path: "/v1/%252e%252e/admin" } },
      { action: "get", input: { path: "/v1%252f..%252fadmin" } },
      // A query beside them changes nothing.
      { action: "get", input: { path: "/v1/%2e%2e/admin?next=%2Fv1" } },
      { action: "get", input: { path: "/v1/../admin?next=1" } },
      { action: "get", input: { path: "/v1\\..\\admin?next=1" } },
      { action: "get", input: { path: "/admin?to=/v1/invoices" } },
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
      // Overrides some servers and proxies read as the method or the URL.
      ...[
        "x-http-method-override",
        "x-original-method",
        "x-original-url",
        "x-rewrite-url",
        "x-override-url",
        "x-host",
      ].map((name) => ({
        action: "get",
        input: { path: "/v1/invoices", headers: { [name]: "/admin" } },
      })),
      // Values a header can't carry as they are.
      ...["café", "a\u0085b", "a\rb"].map((value) => ({
        action: "get",
        input: { path: "/v1/invoices", headers: { "x-note": value } },
      })),
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
    const semicolon = await outcome(
      callAs(app, {
        connectionId,
        action: "get",
        input: { path: "/v1/semicolon" },
      })
    );
    // A read of a context that read restricted data is held for its
    // person and carried out under a key, as a change is: refused once
    // confirmed, it did nothing, so it is refused, not of unknown outcome.
    const anna = someone();
    const run = appFor(anna.userId, "app-invoices");
    const signed = { restricted: true };
    const keyedMove: Call = {
      connectionId,
      action: "get",
      input: { path: "/v1/moved" },
      idempotencyKey: "run-5:moved",
    };
    const held = await outcome(callAs(run, keyedMove, signed));
    const [waiting] = await exports.default.listPendingActions(anna);
    const confirmed = await outcome(
      exports.default.confirmAction({
        person: anna,
        id: waiting?.id ?? "",
        inputHash: waiting?.inputHash ?? "",
        capability: await signCapability(env.CAPABILITY_SIGNING_KEY, run, {
          connectionId,
          action: "get",
          idempotencyKey: waiting?.idempotencyKey,
          origin: originOf(run),
          ...signed,
          decision: { kind: "confirm", pendingActionId: waiting?.id ?? "" },
        }),
      })
    );
    const hopped = await callAs(app, {
      connectionId,
      action: "get",
      input: { path: "/v1/hop" },
    });

    expect({ moved, semicolon, held, confirmed }).toStrictEqual({
      moved: "connect.http_refused",
      semicolon: "connect.http_refused",
      held: "connect.held",
      confirmed: "connect.http_refused",
    });
    expect(JSON.parse(hopped.output)).toMatchObject({ status: 200 });
    expect(sent.map(({ url }) => url)).toStrictEqual([
      "https://api.billing.example/v1/moved",
      "https://api.billing.example/v1/semicolon",
      "https://api.billing.example/v1/moved",
      "https://api.billing.example/v1/hop",
      "https://api.billing.example/v1/invoices?from=hop",
    ]);
  });

  it("never hand back the credential an API echoes, in its body or headers", async () => {
    const byHeader = await create();
    const byBearer = await create(
      billing({ credential: { kind: "bearer", token: secret } })
    );
    const echoOf = async (connectionId: string): Promise<string> => {
      const result = await callAs(app, {
        connectionId,
        action: "get",
        input: { path: "/v1/echo" },
      });
      return result.output;
    };
    const echoed = [await echoOf(byHeader), await echoOf(byBearer)];

    // It went out with each, and came back with neither.
    expect(
      sent.map(({ headers }) => headers["x-api-key"] ?? headers.authorization)
    ).toStrictEqual([secret, `Bearer ${secret}`]);
    expect(echoed.map((output) => output.includes(secret))).toStrictEqual([
      false,
      false,
    ]);
    const answers = echoed.map((output): unknown => JSON.parse(output));
    expect(answers).toMatchObject([
      { headers: { "x-echo": "[credential]" } },
      { headers: { "x-echo": "[credential]" } },
    ]);
  });

  it("never hand back a credential an API echoes escaped as JSON", async () => {
    // A credential JSON escapes: a quote, a backslash and slashes.
    const escapable = 'the/billing"api\\test/credential';
    const connectionId = await create(
      billing({ credential: { kind: "bearer", token: escapable } })
    );
    const bodies = [];
    for (const path of ["/v1/echo", "/v1/echo-escaped"]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const result = await callAs(app, {
        connectionId,
        action: "get",
        input: { path },
      });
      const { body } = z
        .object({ body: z.string() })
        .parse(JSON.parse(result.output));
      bodies.push(body);
    }
    const escaped = JSON.stringify(escapable).slice(1, -1);
    const forms = [escapable, escaped, escaped.replaceAll("/", "\\/")];

    expect(sent.map(({ headers }) => headers.authorization)).toStrictEqual([
      `Bearer ${escapable}`,
      `Bearer ${escapable}`,
    ]);
    expect(
      bodies.map((body) => ({
        shown: forms.filter((form) => body.includes(form)),
        replaced: body.includes('"authorization":"[credential]"'),
      }))
    ).toStrictEqual([
      { shown: [], replaced: true },
      { shown: [], replaced: true },
    ]);
  });

  it("cut off an answer whose body drips in past the time limit", async () => {
    const connectionId = await create();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const call = outcome(
      callAs(
        app,
        { connectionId, action: "get", input: { path: "/v1/drip" } },
        {},
        // In this test's own context, where its fake timers run.
        connectWith({})
      )
    ).finally(() => {
      settled = true;
    });
    // Until the API has the request (`scheduler.wait` runs on real time).
    while (sent.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- waiting on the request
      await scheduler.wait(5);
    }
    // The call has its body's first chunk and waits on the rest: only the
    // time limit ends it.
    vi.advanceTimersByTime(httpLimits.timeoutMs - 1);
    await scheduler.wait(50);
    const beforeLimit = settled;
    vi.advanceTimersByTime(1);

    await expect(call).resolves.toBe("connect.server_unavailable");
    expect(beforeLimit).toBeFalsy();
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
    // A header it can't send is refused before its key is claimed: the
    // same key then sends the right call.
    const badHeader = await outcome(
      callAs(app, {
        ...send,
        input: {
          method: "POST",
          path: "/v1/invoices",
          headers: { "x-note": "café" },
          body: '{"amount":10}',
        },
      })
    );
    const first = await callAs(app, send);
    const repeat = await callAs(app, send);

    expect(unkeyed).toBe("connect.idempotency_key_required");
    expect(badHeader).toBe("connect.http_refused");
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

    // A send whose answer is over the limit went out and most likely
    // acted: of unknown outcome, its key spent, never sent again.
    const full = await create();
    const hugeSend: Call = {
      connectionId: full,
      action: "send",
      input: { method: "POST", path: "/v1/huge", body: "{}" },
      idempotencyKey: "run-2:huge",
    };
    const hugeSends = [
      await outcome(callAs(app, hugeSend)),
      await outcome(callAs(app, hugeSend)),
    ];

    expect(huge).toBe("connect.server_unavailable");
    expect(Object.keys(contract.actions)).toStrictEqual(["get"]);
    expect(noSend).toBe("connect.action_not_found");
    expect(hugeSends).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect(
      sent.filter(({ method }) => method === "POST").map(({ url }) => url)
    ).toStrictEqual(["https://api.billing.example/v1/huge"]);
  });

  it("stop taking calls and drop the credential once disconnected", async () => {
    const person = admin();
    const connectionId = await create(billing(), person);
    // Staff can't approve one, so they can't take one away either.
    const byStaff = await outcome(
      exports.default.disconnect({
        person: { ...admin(), staff: true },
        connectionId,
      })
    );
    const stillActive = await env.DB.prepare(
      "SELECT status FROM connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ status: string }>();
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

    expect({ byStaff, stillActive }).toStrictEqual({
      byStaff: "connection.staff_not_allowed",
      stillActive: { status: "active" },
    });
    expect(after).toBe("connect.connection_inactive");
    expect(row).toStrictEqual({ sealed: null });
    expect(sent).toStrictEqual([]);
  });
});
