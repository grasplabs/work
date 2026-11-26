import { aiRoute } from "../../src/ai-providers.ts";
import { outbound } from "../../src/company-network.ts";

// A stand-in connect on plain workerd, on connect's three networks
// (scripts/workerd-connect-networks.test.ts, GRA-1481). `/<route>?to=<url>`
// fetches `url` one way connect does, and answers what came back, or
// `refused` with workerd's error:
//
// - `ordinary`: connect's own fetch, as every connector, URL MCP server and
//   OAuth call makes it, through its `globalOutbound`.
// - `ai`: an AI request (`aiRoute`).
// - `company`: a request of a connection reached through the company
//   network at the address `url` (`outbound`).
// - `control`: the test's own network, open to every address the others
//   are tried at, which shows each is served at all.

type NetworksEnv = Env & {
  readonly CONTROL: Fetcher;
};

const fetchOf = (
  route: string,
  to: string,
  env: NetworksEnv
): Promise<Response> | undefined => {
  switch (route) {
    case "/ordinary": {
      return fetch(to);
    }
    case "/ai": {
      return aiRoute(env).fetch(to);
    }
    case "/company": {
      // The path a connector names; the host is the address's alone.
      return outbound(env, to)(new Request("https://system.example/who"));
    }
    case "/control": {
      return env.CONTROL.fetch(to);
    }
    default: {
      return undefined;
    }
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sent = fetchOf(url.pathname, url.searchParams.get("to") ?? "", env);
    if (sent === undefined) {
      // workerd's readiness probe.
      return Response.json(null);
    }
    try {
      const response = await sent;
      return Response.json({ answered: await response.text() });
    } catch (error) {
      return Response.json({
        answered: "refused",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
} satisfies ExportedHandler<NetworksEnv>;
