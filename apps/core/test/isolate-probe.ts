/**
 * What code in an isolate can reach, as it reports it: its env's bindings,
 * what `cloudflare:workers` hands it, and whether a fetch or a socket gets
 * anywhere.
 */
export const probeModule = `import { WorkerEntrypoint, env as imported } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

const tried = async (attempt) => {
  try {
    await attempt();
    return "reached";
  } catch {
    return "refused";
  }
};

export default class Probe extends WorkerEntrypoint {
  async report() {
    return {
      env: Object.keys(this.env ?? {}),
      imported: Object.keys(imported ?? {}),
      fetch: await tried(async () => {
        const response = await fetch("https://providers.test/probe");
        await response.arrayBuffer();
      }),
      connect: await tried(async () => {
        const socket = connect("providers.test:443");
        await socket.opened;
      }),
    };
  }
}
`;
