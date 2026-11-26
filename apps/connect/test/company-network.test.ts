import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { outbound } from "../src/company-network.ts";
import { connections } from "../src/db/schema.ts";
import { addConnector } from "../src/mcp-connectors.ts";
import { connectWithKey } from "../src/oauth.ts";
import { companyNetworkKey } from "./company-network-fake.ts";
import type { CompanyRequest } from "./company-network-fake.ts";
import { auditEvents, clientOrigin, outcome, someone } from "./connect.ts";
import { egressProps } from "./connectors-harness.ts";
import { sampleErpHost } from "./fixtures/sample-erp-connector.ts";
import { fakeInternet, json } from "./internet.ts";
import { callTool } from "./tool-calls.ts";

// A shared connection reached through the company network
// (src/company-network.ts, GRA-2327), attacks first. Threat model on
// GRA-2306, section 7, and how each can fail or be made to:
//
// CN-A  Someone but an admin sets it, or sets it on a person's own
//       connection: a member's chat reaching the company's systems.
// CN-B  A request leaves for anywhere but the approved address: another
//       host, another port, the address named by connector code itself, a
//       redirect followed (a download's included), or plain HTTP on any
//       other connection.
// CN-C  The route chosen by what a connector or server names rather than
//       the connection's setting: an ordinary connection whose name
//       resolves to an internal address reaching it through the company
//       network (DNS rebinding). On-prem the networks themselves are kept
//       apart too (scripts/workerd-connect-networks.test.ts).
// CN-D  The address changed apart from the key, or a change unaudited.
// CN-E  A deployment without a route sending such a connection's
//       requests, its key included, to the public internet instead.
// CN-F  A connector made from a URL inside the network: a person's own
//       connection to it, or its sign-in read from the public internet.

/** The system inside the network, as the tests reach it. */
const address = z
  .string()
  .parse(Reflect.get(env, "COMPANY_NETWORK_TEST_ORIGIN"));

const companyNetwork = (): Fetcher => {
  const route = env.COMPANY_NETWORK;
  if (route === undefined) {
    throw new Error("The tests' company network isn't bound");
  }
  return route;
};

const sentSchema = z.array(
  z.object({
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string(), z.string()),
  })
);

/** What reached the system through the company network. */
const companySent = async (): Promise<CompanyRequest[]> => {
  const response = await companyNetwork().fetch(`${address}/__test/sent`);
  return sentSchema.parse(await response.json());
};

/** The paths that reached it, in order. */
const companyPaths = async (): Promise<string[]> => {
  const sent = await companySent();
  return sent.map(({ path }) => path);
};

/** The actions and details of the audit events written, in order. */
const eventsOf = async (events: ReturnType<typeof auditEvents>) => {
  const written = await events.events();
  return written.map(({ action, detail }) => ({ action, detail }));
};

/** What a call answered, as its tool's output. */
const outputOf = (result: { output: string }): unknown =>
  JSON.parse(result.output);

const probeSchema = z.object({ status: z.number() });

// What reaches the public internet: nothing of the company's system.
// An ordinary connection to the same app is answered there, as its own
// account.
const internet = fakeInternet((_request, url) =>
  json(
    url.pathname === "/api/whoami"
      ? { account: { id: "erp-public", name: "Public ERP" } }
      : { items: [] }
  )
);
const audit = auditEvents();

/** The system forgets what it got, before each test of the file. */
const companySystem = (): void => {
  beforeEach(async () => {
    await companyNetwork().fetch(`${address}/__test/reset`, {
      method: "POST",
    });
    // Each test connects the app's one account afresh.
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM connection_tokens WHERE connection_id IN (SELECT id FROM connections WHERE provider = 'sample-erp')"
      ),
      env.DB.prepare("DELETE FROM connections WHERE provider = 'sample-erp'"),
    ]);
  });
};
companySystem();

const admin = (): ConnectionPerson => someone("admin");

/** Connects the sample ERP as `person` would. */
const connectErp = async (
  person: ConnectionPerson,
  fields: { scope?: "personal" | "shared"; companyNetwork?: string } = {}
) =>
  await exports.default.connectWithKey({
    person,
    provider: "sample-erp",
    scope: fields.scope ?? "shared",
    key: companyNetworkKey,
    ...(fields.companyNetwork === undefined
      ? {}
      : { companyNetwork: fields.companyNetwork }),
  });

const connectionRow = async (id: string) =>
  await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get();

/** The address a connection's row shows. */
const shownAddress = async (id: string): Promise<string | null | undefined> => {
  const row = await connectionRow(id);
  return row?.companyNetwork;
};

/** Calls one of the sample ERP's tools on `connectionId`, as `person`. */
const callErp = async (
  connectionId: string,
  person: ConnectionPerson,
  action: string,
  input: Record<string, string> = {}
) => await callTool({ id: connectionId, person }, action, input);

describe("a shared connection reached through the company network", () => {
  it("is connected by an admin, looks its account up and calls its system there alone, and says so once in the audit log", async () => {
    const person = admin();
    const { connectionId } = await connectErp(person, {
      companyNetwork: address,
    });
    const listed = await callErp(connectionId, person, "orders.list");
    const sent = await companySent();
    const events = await eventsOf(audit);

    expect({
      row: await connectionRow(connectionId),
      listed: outputOf(listed),
      company: sent.map(({ method, path, headers }) => ({
        method,
        path,
        key: headers["x-api-key"],
      })),
      internet: internet.sent,
      events: events.filter(({ action }) => action !== "connection.call"),
    }).toMatchObject({
      row: {
        scope: "shared",
        companyNetwork: address,
        accountId: "erp-1",
      },
      listed: { items: [{ id: "order-1", title: "First" }], next: null },
      company: [
        { method: "GET", path: "/api/whoami", key: companyNetworkKey },
        { method: "GET", path: "/api/orders", key: companyNetworkKey },
      ],
      internet: [],
      events: [
        {
          action: "connection.connect",
          detail: {
            provider: "sample-erp",
            scope: "shared",
            companyNetwork: address,
            outcome: "ok",
          },
        },
      ],
    });
  });

  it("CN-A: is refused to a member, to a person's own connection, and to staff, and nothing is sent", async () => {
    const member = someone("user");
    const results = {
      member: await outcome(connectErp(member, { companyNetwork: address })),
      personal: await outcome(
        connectErp(admin(), { scope: "personal", companyNetwork: address })
      ),
      staff: await outcome(
        connectErp({ ...admin(), staff: true }, { companyNetwork: address })
      ),
      notAnAddress: await outcome(
        connectErp(admin(), { companyNetwork: `${address}/api` })
      ),
    };

    const events = await eventsOf(audit);

    expect({
      ...results,
      company: await companySent(),
      internet: internet.sent,
      refused: events
        .filter(({ detail }) => detail?.reason === "connection.invalid")
        .map(({ detail }) => detail?.scope),
    }).toStrictEqual({
      member: "role.forbidden",
      personal: "connection.invalid",
      staff: "connection.staff_not_allowed",
      notAnAddress: "connection.invalid",
      company: [],
      internet: [],
      refused: ["personal", "shared"],
    });
  });

  it("CN-B: sends nothing anywhere but the approved address: another host, another port, the address itself, plain HTTP, or where a redirect leads", async () => {
    const person = admin();
    const { connectionId } = await connectErp(person, {
      companyNetwork: address,
    });
    const { port } = new URL(address);
    const probe = async (url: string) =>
      probeSchema.parse(
        outputOf(await callErp(connectionId, person, "probe.fetch", { url }))
      );
    const moved = await outcome(callErp(connectionId, person, "moved.list"));
    const attempts = {
      anotherHost: await probe("https://other.sample.test/api/orders"),
      anotherPort: await probe(`https://${sampleErpHost}:8443/api/orders`),
      theAddressItself: await probe(`${address}/api/orders`),
      plainHttp: await probe(`http://${sampleErpHost}/api/orders`),
      loopbackByName: await probe(`https://localhost:${port}/api/orders`),
    };

    expect({
      attempts,
      moved: moved === "ok" ? "ok" : "failed",
      company: await companyPaths(),
      internet: internet.sent,
    }).toStrictEqual({
      attempts: {
        anotherHost: { status: 403 },
        anotherPort: { status: 403 },
        theAddressItself: { status: 403 },
        plainHttp: { status: 403 },
        loopbackByName: { status: 403 },
      },
      moved: "failed",
      // The lookup when connecting, then the one request that redirected,
      // never where it led.
      company: ["/api/whoami", "/api/moved"],
      internet: [],
    });
  });

  it("CN-B: follows no download's redirect either, and a connector with a second host is refused there", async () => {
    const download = egressProps({
      connector: "sample-erp",
      hosts: [sampleErpHost],
      routes: [
        {
          method: "GET",
          host: sampleErpHost,
          path: "/api/download",
          redirects: ["*.storage.test"],
        },
      ],
      credential: { header: "x-api-key", value: companyNetworkKey },
      companyNetwork: address,
    });
    const downloaded = await exports
      .ConnectorEgress({ props: download })
      .fetch(`https://${sampleErpHost}/api/download`);
    const twoHosts = await exports
      .ConnectorEgress({
        props: { ...download, hosts: [sampleErpHost, "files.sample.test"] },
      })
      .fetch(`https://${sampleErpHost}/api/download`);

    expect({
      downloaded: downloaded.status,
      twoHosts: twoHosts.status,
      company: await companyPaths(),
      internet: internet.sent,
    }).toStrictEqual({
      downloaded: 502,
      twoHosts: 403,
      company: ["/api/download"],
      internet: [],
    });
  });

  it("CN-C: is chosen by the connection's setting alone: the same connector on an ordinary connection goes to the public internet, HTTPS only", async () => {
    const person = admin();
    const { connectionId } = await connectErp(person);
    await callErp(connectionId, person, "orders.list");

    expect({
      company: await companySent(),
      internet: internet.sent.map(({ host, path }) => ({ host, path })),
      row: await shownAddress(connectionId),
    }).toStrictEqual({
      company: [],
      internet: [
        { host: sampleErpHost, path: "/api/whoami" },
        { host: sampleErpHost, path: "/api/orders" },
      ],
      row: null,
    });
  });

  it("CN-D: routes by the address sealed with the key, and another address takes the key again, in one event with both", async () => {
    const person = admin();
    const { connectionId } = await connectErp(person, {
      companyNetwork: address,
    });
    // `localhost` leads to the same system, so its lookup is answered.
    const moved = address.replace("127.0.0.1", "localhost");
    const { connectionId: again } = await connectErp(person, {
      companyNetwork: moved,
    });
    // Pointed at an address the network doesn't allow, in the database
    // alone: the key still goes only where it was sealed for.
    await drizzle(env.DB)
      .update(connections)
      .set({ companyNetwork: "http://10.0.0.9:8080" })
      .where(eq(connections.id, connectionId));
    const listed = await callErp(connectionId, person, "orders.list");
    const events = await eventsOf(audit);

    expect({
      again,
      listed: outputOf(listed),
      company: await companyPaths(),
      events: events
        .filter(({ action }) => action !== "connection.call")
        .map(({ action, detail }) => ({
          action,
          companyNetwork: detail?.companyNetwork,
          previous: detail?.previousCompanyNetwork,
        })),
    }).toStrictEqual({
      again: connectionId,
      listed: { items: [{ id: "order-1", title: "First" }], next: null },
      company: ["/api/whoami", "/api/whoami", "/api/orders"],
      events: [
        {
          action: "connection.connect",
          companyNetwork: address,
          previous: undefined,
        },
        {
          action: "connection.reconnected",
          companyNetwork: moved,
          previous: address,
        },
      ],
    });
  });

  it("CN-E: is refused where the deployment has no route, and nothing is sent", async () => {
    const hosted = { ...env, COMPANY_NETWORK: undefined };
    const person = admin();
    // A connection made where there was a route, called where there's none
    // now (the binding removed, or a rollback): never sent to the internet.
    const called = await outbound(
      hosted,
      address
    )(
      new Request(`https://${sampleErpHost}/api/orders`, {
        headers: { "x-api-key": companyNetworkKey },
      })
    ).then(
      () => "sent",
      () => "refused"
    );

    expect({
      called,
      app: await outcome(
        connectWithKey(hosted, {
          person,
          provider: "sample-erp",
          scope: "shared",
          key: companyNetworkKey,
          companyNetwork: address,
        })
      ),
      server: await outcome(
        addConnector(hosted, {
          person,
          name: "Orders",
          url: `${address}/mcp`,
          companyNetwork: true,
          origin: clientOrigin,
          auth: { kind: "header", header: "X-Api-Key" },
        })
      ),
      company: await companySent(),
      internet: internet.sent,
    }).toStrictEqual({
      called: "refused",
      app: "connection.company_network_unavailable",
      server: "connection.company_network_unavailable",
      company: [],
      internet: [],
    });
  });
});

describe("a connector made from the URL of a server inside the network", () => {
  const addServer = async (
    fields: { companyNetwork?: boolean; oauth?: boolean; url?: string } = {}
  ) =>
    await exports.default.addConnector({
      person: admin(),
      name: "Orders",
      url: fields.url ?? `${address}/mcp`,
      ...(fields.companyNetwork === false ? {} : { companyNetwork: true }),
      origin: clientOrigin,
      auth:
        fields.oauth === true
          ? { kind: "oauth" }
          : { kind: "header", header: "X-Api-Key" },
    });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM connectors").run();
  });

  it("is added by an admin with its address, connected as a shared connection only, and lists its tools there", async () => {
    const { id: provider } = await addServer();
    const person = admin();
    const { connectionId } = await exports.default.connectWithKey({
      person,
      provider,
      scope: "shared",
      key: companyNetworkKey,
    });
    const classes = await exports.default.connectorToolClasses(connectionId);
    const { entries } = await exports.default.catalog();
    const sent = await companySent();
    const events = await eventsOf(audit);

    expect({
      personal: await outcome(
        exports.default.connectWithKey({
          person: someone(),
          provider,
          scope: "personal",
          key: companyNetworkKey,
        })
      ),
      // The server's own address alone, never one the admin names.
      elsewhere: await outcome(
        exports.default.connectWithKey({
          person,
          provider,
          scope: "shared",
          key: companyNetworkKey,
          companyNetwork: "http://10.0.0.9:8080",
        })
      ),
      tools: Object.keys(classes),
      entry: entries.find(({ id }) => id === provider)?.companyNetwork,
      row: await shownAddress(connectionId),
      company: sent.map(({ method, path }) => `${method} ${path}`),
      // The catalog reads Composio's toolkits there; nothing of the server.
      internet: internet.sent.filter(({ path }) => path === "/mcp"),
      added: events
        .filter(({ action }) => action === "connector.added")
        .map(({ detail }) => detail?.companyNetwork),
    }).toStrictEqual({
      personal: "connection.invalid",
      elsewhere: "connection.invalid",
      tools: ["orders_list"],
      entry: address,
      row: address,
      company: ["POST /mcp", "POST /mcp"],
      internet: [],
      added: [address],
    });
  });

  it("CN-F: takes plain HTTP and an internal address only through the company network, and a key there, never a sign-in read from the internet", async () => {
    expect({
      publicHttp: await outcome(addServer({ companyNetwork: false })),
      oauth: await outcome(addServer({ oauth: true })),
      company: await companySent(),
      internet: internet.sent,
    }).toStrictEqual({
      publicHttp: "connection.invalid",
      oauth: "connection.invalid",
      company: [],
      internet: [],
    });
  });
});
