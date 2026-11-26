/**
 * A system inside the client's own network, as connect's tests reach it
 * through the company network (src/company-network.ts): a server in Node
 * on a loopback address, which the tests' `COMPANY_NETWORK` binding, a
 * workerd network that allows only that address, leads to, as an on-prem
 * install's does. It plays an ERP with a REST API (the sample ERP
 * connector's, test/fixtures/sample-erp-connector.ts) and an MCP server
 * that takes a key in a header, at `/mcp`. It records every request it
 * gets, so a test reads back what went through the company network, and
 * nothing else does. Its own paths for the tests are under `/__test/`:
 * `sent` reads the record, `reset` empties it.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

/** The one key the system takes, in `x-api-key`. */
export const companyNetworkKey = "company-network-key";

/** The one user and secret its form login (`/session/login`) takes. */
export const companyLogin = { user: "erp-user", secret: "erp-secret" };

/** The session its form login answers with, in a cookie. */
export const companySession = "company-session-1";

/** One request the system got. */
export interface CompanyRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** The MCP server's one tool. */
const ordersTool = {
  name: "orders_list",
  description: "Lists the orders",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
});

/** An MCP request (MCP 2026-07-28, stateless), answered as JSON. */
const mcp = async (request: Request): Promise<Response> => {
  const { id, method } = rpcSchema.parse(await request.json());
  const answer = (result: Record<string, unknown>): Response =>
    json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
  if (method === "tools/list") {
    return answer({
      tools: [ordersTool],
      ttlMs: 60_000,
      cacheScope: "private",
    });
  }
  if (method === "tools/call") {
    return answer({
      content: [{ type: "text", text: JSON.stringify({ orders: 1 }) }],
    });
  }
  return json(
    {
      jsonrpc: "2.0",
      id,
      error: { code: -32_601, message: "Method not found" },
    },
    404
  );
};

/**
 * How the system answers what is under `/session/`: a form login that
 * sets its session in a cookie, and the orders, for that cookie alone.
 */
const sessionAnswer = async (request: Request, url: URL): Promise<Response> => {
  if (request.method === "POST" && url.pathname === "/session/login") {
    const form = new URLSearchParams(await request.text());
    if (
      form.get("user") !== companyLogin.user ||
      form.get("secret") !== companyLogin.secret
    ) {
      return json({ message: "Unauthorized" }, 401);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `ERPSESSION=${companySession}; Path=/; HttpOnly`,
      },
    });
  }
  if (request.headers.get("cookie") !== `ERPSESSION=${companySession}`) {
    return json({ message: "Unauthorized" }, 401);
  }
  return url.pathname === "/session/orders"
    ? json({ items: [{ id: "order-1", title: "First" }] })
    : json({ message: "Not found" }, 404);
};

/** How the system answers `request`. */
const answer = async (request: Request, url: URL): Promise<Response> => {
  if (url.pathname.startsWith("/session/")) {
    return await sessionAnswer(request, url);
  }
  if (request.headers.get("x-api-key") !== companyNetworkKey) {
    return json({ message: "Unauthorized" }, 401);
  }
  if (request.method === "POST" && url.pathname === "/mcp") {
    return await mcp(request);
  }
  if (request.method !== "GET") {
    return json({ message: "Not found" }, 404);
  }
  switch (url.pathname) {
    case "/api/whoami": {
      return json({ account: { id: "erp-1", name: "Acme ERP" } });
    }
    case "/api/orders": {
      return json({ items: [{ id: "order-1", title: "First" }] });
    }
    // Sends the caller to its own orders, then elsewhere: neither may be
    // followed.
    case "/api/moved": {
      return new Response(null, {
        status: 307,
        headers: { location: "/api/orders" },
      });
    }
    case "/api/download": {
      return new Response(null, {
        status: 302,
        headers: { location: "https://tenant.storage.test/file" },
      });
    }
    default: {
      return json({ message: "Not found" }, 404);
    }
  }
};

const headersOf = (incoming: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const each of Array.isArray(value) ? value : [value ?? ""]) {
      headers.append(name, each);
    }
  }
  return headers;
};

/** A request's body, as text: JSON, where it has one. */
const bodyOf = async (incoming: IncomingMessage): Promise<string> => {
  incoming.setEncoding("utf-8");
  let body = "";
  for await (const chunk of incoming) {
    body += String(chunk);
  }
  return body;
};

/**
 * Starts the system on 127.0.0.1, at a port of its own: its origin. It
 * doesn't keep the process up once the tests are done.
 */
export const startCompanyNetwork = async (): Promise<string> => {
  const sent: CompanyRequest[] = [];
  const server = createServer(
    (incoming: IncomingMessage, outgoing: ServerResponse) => {
      void (async () => {
        const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
        const method = incoming.method ?? "GET";
        const headers = headersOf(incoming);
        const body = await bodyOf(incoming);
        let response: Response;
        if (url.pathname === "/__test/sent") {
          response = json(sent);
        } else if (url.pathname === "/__test/reset") {
          sent.length = 0;
          response = json({ reset: true });
        } else {
          sent.push({
            method,
            path: `${url.pathname}${url.search}`,
            headers: Object.fromEntries(headers),
            body,
          });
          response = await answer(
            new Request(url, {
              method,
              headers,
              ...(body === "" ? {} : { body }),
            }),
            url
          );
        }
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers)
        );
        outgoing.end(await response.text());
      })();
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The company network's system has no port");
  }
  return `http://127.0.0.1:${address.port}`;
};
