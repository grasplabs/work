/**
 * Connect's three networks on plain workerd (on-prem, GRA-1481), through
 * workerd's own network filters: a stand-in connect
 * (apps/connect/test/workerd/networks-worker.ts) served with the networks
 * scripts/workerd-connect-networks.ts writes, an AI endpoint opened on the
 * AI endpoints' network and a company system on the company network, each
 * a server on a loopback address of its own. `localhost` stands in for a
 * name whose DNS leads inside. A test-only network open to them all
 * reaches each, which shows a refusal is the network's, not a server's.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { connectNetworks } from "./workerd-connect-networks.ts";
import { bundle } from "./workerd-stand-in.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";
import type { Served } from "./workerd-test-server.ts";

/** A server on `host` that answers `name`, and its origin. */
const serve = async (
  host: string,
  name: string
): Promise<{ server: Server; origin: string }> => {
  const server = createServer((_request, response) => {
    response.end(name);
  }).listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`no address for ${name}`);
  }
  return { server, origin: `http://${host}:${address.port}` };
};

describe("connect's networks on plain workerd", () => {
  let served: Served;
  const servers: Server[] = [];
  /** Where each server answers. */
  const at = { ai: "", company: "", localhost: "" };

  beforeAll(async () => {
    const ai = await serve("127.0.0.2", "ai");
    const company = await serve("127.0.0.3", "company");
    const loopback = await serve("127.0.0.1", "localhost");
    servers.push(ai.server, company.server, loopback.server);
    at.ai = ai.origin;
    at.company = company.origin;
    at.localhost = loopback.origin.replace("127.0.0.1", "localhost");

    const networks = connectNetworks(["127.0.0.2/32"], ["127.0.0.3/32"]);
    const out = tempDir();
    const modules = bundle(out, "networks-worker.ts", "connect");
    served = await serveOnWorkerd(
      out,
      (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "connect", worker = .connect),
    ${networks.services.join(",\n    ")},
    (name = "control", network = (allow = ["private"])),
  ],
  sockets = [(name = "http", address = "${address}", http = (), service = "connect")],
);

const connect :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  globalOutbound = ${networks.globalOutbound},
  bindings = [
    ${networks.bindings.join(",\n    ")},
    (name = "CONTROL", service = "control"),
  ],
);
`
    );
  }, 120_000);

  afterAll(async () => {
    cleanUp();
    await Promise.all(
      servers.map(async (server) => {
        server.close();
        await once(server, "close");
      })
    );
  });

  /** What `to` answered through `route`: a server's name, or `refused`. */
  const through = async (route: string, to: string): Promise<string> => {
    const response = await fetch(
      new URL(`/${route}?to=${encodeURIComponent(to)}`, served.url)
    );
    return z.object({ answered: z.string() }).parse(await response.json())
      .answered;
  };

  /** What each address answers through `route`. */
  const reached = async (route: string) => ({
    ai: await through(route, at.ai),
    company: await through(route, at.company),
    localhost: await through(route, at.localhost),
  });

  it("reaches each address through a network open to it", async () => {
    await expect(reached("control")).resolves.toStrictEqual({
      ai: "ai",
      company: "company",
      localhost: "localhost",
    });
  });

  it("refuses connect's own fetch every address inside: the AI endpoint, the company system and a name that resolves inside", async () => {
    await expect(reached("ordinary")).resolves.toStrictEqual({
      ai: "refused",
      company: "refused",
      localhost: "refused",
    });
  });

  it("takes an AI request to the AI endpoint, and to nothing else inside", async () => {
    await expect(reached("ai")).resolves.toStrictEqual({
      ai: "ai",
      company: "refused",
      localhost: "refused",
    });
  });

  it("takes a company connection's request to its approved address, and refuses one at the AI endpoint or a name that resolves elsewhere inside", async () => {
    await expect(reached("company")).resolves.toStrictEqual({
      ai: "refused",
      company: "company",
      localhost: "refused",
    });
  });
});
