import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import type { Readable } from "./authorize.ts";

// What Knowledge asks of its host, in one place: the rest of Knowledge
// reaches Grasp's people, roles, teams and Apps only through these ports,
// so it can move into a package of its own that takes them as arguments.

/** Knowledge's ports, as core provides them. */
export interface KnowledgePorts {
  /** What `reader` may read now (authorize.ts). */
  authorize: (reader: Reader) => Promise<Readable>;
}

/** Core's ports for Knowledge, over `env`. */
export const portsOf = (env: Env): KnowledgePorts => ({
  authorize: async (reader) => await authorize(env, reader),
});
