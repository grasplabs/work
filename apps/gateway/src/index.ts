import {
  forwardsMethod,
  gatewayScriptOf,
} from "@grasp-os/shared/connect-gateway";
import { WorkerEntrypoint } from "cloudflare:workers";

// The connect gateway (@grasp-os/shared/connect-gateway, GRA-1217): every
// method a placed core calls on its `CONNECT` binding, `fetch` included,
// is its own connect's, called on the one script the binding's props name
// (the admin sets them as it uploads core), whatever the caller passes.
// The gateway has no method of its own and takes no script from anyone.

/** The constant answer to a binding the gateway won't serve: it names nothing. */
const unavailable = (): Error => new Error("connect unavailable");

/** How a dispatch namespace's stub answers for a script it hasn't got. */
const workerNotFound = "Worker not found";

interface GatewayEnv {
  CLIENTS: DispatchNamespace;
}

/**
 * The client's connect, as the binding's props name it, or a constant
 * refusal: no props, a script that isn't a client connect's, or one the
 * namespace hasn't got. Cloudflare's own "Worker not found" names the
 * script, so it never reaches the caller.
 */
const connectOf = (env: GatewayEnv, props: unknown): Fetcher => {
  const script = gatewayScriptOf(props);
  if (script === undefined) {
    throw unavailable();
  }
  try {
    return env.CLIENTS.get(script);
  } catch {
    throw unavailable();
  }
};

/**
 * What the gateway answers for the method `key`: a call of that method on
 * the client's connect, or nothing for a name it never forwards.
 */
export const forwarded = (
  env: GatewayEnv,
  props: unknown,
  key: string | symbol
): ((...args: unknown[]) => Promise<unknown>) | undefined => {
  if (!forwardsMethod(key)) {
    return undefined;
  }
  return async (...args) => {
    const connect: unknown = connectOf(env, props);
    const method: unknown =
      typeof connect === "object" && connect !== null
        ? Reflect.get(connect, key)
        : undefined;
    if (typeof method !== "function") {
      throw unavailable();
    }
    try {
      const answer: unknown = await Reflect.apply(method, connect, args);
      return answer;
    } catch (error) {
      // The namespace's own refusal names the script: never passed on.
      // Anything connect throws crosses as it would on a direct binding.
      if (error instanceof Error && error.message.startsWith(workerNotFound)) {
        throw unavailable();
      }
      throw error;
    }
  };
};

export default class Gateway extends WorkerEntrypoint<GatewayEnv> {
  constructor(ctx: ExecutionContext, env: GatewayEnv) {
    super(ctx, env);
    const props: unknown = Reflect.get(ctx, "props");
    // Every method read is answered by `forwarded`: the instance's own
    // members stay its own only as the runtime needs them.
    // The runtime calls each method on the instance it constructs, so the
    // proxy is that instance: no method is ever read from the class.
    // oxlint-disable-next-line no-constructor-return -- see above
    return new Proxy(this, {
      get: (target, key, receiver) =>
        forwardsMethod(key)
          ? forwarded(env, props, key)
          : Reflect.get(target, key, receiver),
    });
  }

  // Declared for the upload, which wants a handler; the proxy answers it
  // with connect's own `fetch`.
  // oxlint-disable-next-line class-methods-use-this -- never called: see above
  override fetch(): Response {
    return new Response(null, { status: 500 });
  }
}
