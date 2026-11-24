import { log } from "@grasp-os/shared/log";
import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { isolateBase } from "@grasp-os/shared/runtime";

// Connect's half of the admin's provisioning probe (core's
// src/provision-probe.ts, which asks it over the service binding): whether
// each of connect's private bindings answers a no-op, so the admin routes
// a client only once connect runs on its own resources too. Its clock
// answers through `ensureClock`. Only core can ask: connect has no public
// route to it. The answer is binding names, each with a yes or no.

/** A fresh isolate's one module: it answers a constant, and reaches nothing. */
const probeModule = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Probe extends WorkerEntrypoint {
  answer() {
    return "probe";
  }
}
`;

/** Whether `call` settled; why it didn't is logged, by its error's kind only. */
const answers = async (
  binding: string,
  call: () => Promise<unknown>
): Promise<boolean> => {
  try {
    await call();
    return true;
  } catch (error) {
    log.warn("probe.binding_failed", {
      binding,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
};

/** The Loader's no-op: an isolate with no env and no network answers its constant. */
const loader = (env: Env) => async () => {
  const entrypoint: unknown = quietLoader(env.LOADER)
    .load({
      ...isolateBase,
      mainModule: "probe.js",
      modules: { "probe.js": probeModule },
      env: {},
      globalOutbound: null,
    })
    .getEntrypoint("Probe");
  if (
    (typeof entrypoint !== "object" && typeof entrypoint !== "function") ||
    entrypoint === null
  ) {
    throw new TypeError("The Loader gave no entrypoint");
  }
  const call: unknown = Reflect.get(entrypoint, "answer");
  if (typeof call !== "function") {
    throw new TypeError("The entrypoint has no answer method");
  }
  const answer: unknown = await Reflect.apply(call, entrypoint, []);
  if (answer !== "probe") {
    throw new Error("The isolate answered something else");
  }
};

/** Each of connect's private bindings, by name: whether it answered its no-op. */
export const probeBindings = async (
  env: Env
): Promise<Record<string, boolean>> => {
  const [db, load] = await Promise.all([
    answers("DB", async () => await env.DB.prepare("SELECT 1").first()),
    answers("LOADER", loader(env)),
  ]);
  return { DB: db, LOADER: load };
};
