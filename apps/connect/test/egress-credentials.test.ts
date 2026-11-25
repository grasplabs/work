import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { connectApp, fakeApps } from "./app-provider.ts";
import { auditEvents, outcome, someone } from "./connect.ts";
import { sampleHostHeader } from "./fixtures/sample-host-connector.ts";
import {
  sampleKeyApiHost,
  sampleKeyFilesHost,
  sampleKeyHeader,
} from "./fixtures/sample-key-connector.ts";
import { fakeInternet, json } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool } from "./tool-calls.ts";

// Where a connection's credential goes, and what of a vendor's answer
// reaches connector code (GRA-2349); and hosts set per connection
// (GRA-2350). Connector code is a client's agent's, or generated from a
// spec, so it is the attacker here, with what fills a host template.
// Each case is a way it could fail, or be made to:
//
// CH1  A connector lists a host of its choosing beside the vendor's, and
//      calls it: the credential must not go with the request.
// CH2  A vendor's `Set-Cookie` (a session worth as much as the key), or
//      its echo of the key in a header, reaches connector code, which
//      sends it on to a host that doesn't take the key.
// CH3  A member points a shared connection's `{host}`, or their own
//      connection's, at a host of theirs, which receives the key at the
//      account lookup or on the next call.
// CH4  A host that isn't one: an address, a port, userinfo, a path, a
//      host for a template the connector doesn't have.
// CH5  A connection pointed at another host without signing in again,
//      keeping the key it had; the same account at two hosts mistaken
//      for one connection.
// CH6  Connector code naming a filled host itself, or another, past the
//      template egress fills.

fakeProviders();
const apps = fakeApps();
const items = [{ id: "item-1", title: "First" }];

/** The hosts an app of each client runs on, each with the key it takes. */
const erpKey = "erp-key-1";
const erpHosts = new Set(["erp.acme.test", "erp-2.acme.test"]);

const internet = fakeInternet((request, url) => {
  if (url.hostname === sampleKeyApiHost) {
    const key = request.headers.get(sampleKeyHeader) ?? "";
    if (!apps.holds(key)) {
      return json({ message: "Unauthorized" }, 401);
    }
    const headers = new Headers({ "x-request-id": "r-1" });
    headers.append("set-cookie", "session=s3cret; Secure; HttpOnly");
    headers.append("set-cookie", "other=more");
    headers.append("set-cookie2", "legacy=1");
    headers.append("x-echo", `${sampleKeyHeader}: ${key}`);
    headers.append("x-key", key);
    return Response.json({ items }, { headers });
  }
  if (erpHosts.has(url.hostname)) {
    if (request.headers.get(sampleHostHeader) !== erpKey) {
      return json({ message: "Unauthorized" }, 401);
    }
    return url.pathname === "/v1/whoami"
      ? json({ account: { id: "api", name: "API user" } })
      : json({ items });
  }
  // The connector's file storage, and every other host: takes anything.
  return json({ items });
});
const audit = auditEvents();

const listOn = async (
  connection: { id: string; person: ConnectionPerson },
  action: string
) =>
  await callTool(
    connection,
    action,
    { board: "board-1" },
    { resource: "board-1" }
  );

/** A shared connection to the ERP at `host`, as `person` gives it. */
const connectErp = async (
  person: ConnectionPerson,
  hosts: Record<string, string>,
  scope: "personal" | "shared" = "shared"
) =>
  await exports.default.connectWithKey({
    person,
    provider: "sample-host",
    scope,
    key: erpKey,
    hosts,
  });

describe("a connector's credential", () => {
  it("goes only to the hosts its sign-in names: another of its hosts gets the request without it (CH1)", async () => {
    const person = someone();
    const account = apps.account("sample-key", person.email);
    const key = apps.keyFor(account);
    const id = await connectApp(apps, person, account);
    const result = await listOn({ id, person }, "files.list");
    expect(JSON.parse(result.output)).toStrictEqual({ items });
    expect(internet.sent).toHaveLength(1);
    expect(internet.sent[0]).toMatchObject({
      host: sampleKeyFilesHost,
      path: "/v1/boards/board-1/files",
    });
    expect(JSON.stringify(internet.sent)).not.toContain(key);
    expect(internet.sent[0]?.headers).not.toHaveProperty(sampleKeyHeader);
  });

  it("reaches connector code with no cookie of the vendor's, and every copy of it in an answer's headers replaced (CH2)", async () => {
    const person = someone();
    const account = apps.account("sample-key", person.email);
    const key = apps.keyFor(account);
    const id = await connectApp(apps, person, account);
    const result = await listOn({ id, person }, "items.answer");
    const { headers } = z
      .object({ headers: z.string() })
      .parse(JSON.parse(result.output));
    const answered = Object.fromEntries(
      z.array(z.tuple([z.string(), z.string()])).parse(JSON.parse(headers))
    );
    expect(answered).toStrictEqual({
      "content-type": "application/json",
      "x-echo": `${sampleKeyHeader}: [credential]`,
      "x-key": "[credential]",
      "x-request-id": "r-1",
    });
    expect(headers).not.toContain(key);
  });
});

describe("a host set per connection", () => {
  it("is the host the admin gives, sealed with the key: the lookup and every call go there alone (CH6)", async () => {
    const admin = someone("admin");
    const { connectionId } = await connectErp(admin, {
      "{host}": "erp.acme.test",
    });
    const result = await listOn(
      { id: connectionId, person: admin },
      "items.list"
    );
    expect(JSON.parse(result.output)).toStrictEqual({ items });
    expect(
      internet.sent.map(({ host, path, headers }) => ({
        host,
        path,
        key: headers[sampleHostHeader],
      }))
    ).toStrictEqual([
      { host: "erp.acme.test", path: "/v1/whoami", key: erpKey },
      { host: "erp.acme.test", path: "/v1/boards/board-1/items", key: erpKey },
    ]);
    const events = await audit.events();
    const connected = events.find(
      ({ action }) => action === "connection.connect"
    );
    expect(connected?.detail).toMatchObject({
      provider: "sample-host",
      scope: "shared",
      hosts: "erp.acme.test",
    });
    expect(connected?.actor).toMatchObject({ userId: admin.userId });
  });

  it("is never a member's to set: not on a shared connection, nor on their own (CH3)", async () => {
    const member = someone();
    await expect(
      outcome(connectErp(member, { "{host}": "attacker.test" }))
    ).resolves.toBe("role.forbidden");
    await expect(
      outcome(connectErp(member, { "{host}": "attacker.test" }, "personal"))
    ).resolves.toBe("connection.invalid");
    expect(internet.sent).toStrictEqual([]);
  });

  it("is refused when it isn't a DNS name for the connector's template, before anything is sent (CH4)", async () => {
    const admin = someone("admin");
    const given: Record<string, string>[] = [
      {},
      { "{host}": "10.0.0.1" },
      { "{host}": "erp.acme.test:8443" },
      { "{host}": "user@erp.acme.test" },
      { "{host}": "erp.acme.test/v1" },
      { "{host}": "ERP.acme.test" },
      { "{host}": "localhost" },
      { "{host}": "erp.acme.test", "{other}": "erp.acme.test" },
      { "{other}": "erp.acme.test" },
    ];
    for (const hosts of given) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      await expect(outcome(connectErp(admin, hosts))).resolves.toBe(
        "connection.invalid"
      );
    }
    expect(internet.sent).toStrictEqual([]);
  });

  it("takes signing in again to change: the same account at another host is another connection, each with its own host (CH5)", async () => {
    const admin = someone("admin");
    const first = await connectErp(admin, { "{host}": "erp.acme.test" });
    const second = await connectErp(admin, { "{host}": "erp-2.acme.test" });
    expect(second.connectionId).not.toBe(first.connectionId);
    internet.sent.length = 0;
    await listOn({ id: first.connectionId, person: admin }, "items.list");
    await listOn({ id: second.connectionId, person: admin }, "items.list");
    expect(internet.sent.map(({ host }) => host)).toStrictEqual([
      "erp.acme.test",
      "erp-2.acme.test",
    ]);
  });
});
