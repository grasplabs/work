/**
 * The AI providers behind connect, as tests of Grasp's own AI features
 * reach them (core's src/platform-ai.ts): plan how a provider answers
 * Grasp's key, read what reached it, and the realtime sockets OpenAI's
 * fake took (test/ai-providers-fake.ts). Connect, core's gateway, the
 * ledger and the audit log are real.
 */
import { aiCredentialPlaceholder } from "@grasp-os/shared/ai-providers";

import {
  aiProvidersControlUrl,
  realtimeControlUrl,
  releaseUrl,
} from "./ai-providers-fake.ts";
import type {
  PlannedReply,
  ProviderRequest,
  RealtimeSocket,
} from "./ai-providers-fake.ts";
import { testBinding } from "./test-env.ts";

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The Worker standing in for the internet behind connect. */
const internet = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

/** Plans how the providers answer the requests that carry `key`, in order. */
export const plan = async (
  key: string,
  replies: PlannedReply[]
): Promise<void> => {
  await internet().fetch(aiProvidersControlUrl, {
    method: "POST",
    body: JSON.stringify({ key, replies }),
  });
};

/** Every request a provider got whose headers or body carry `text`. */
export const carrying = async (text: string): Promise<ProviderRequest[]> => {
  const response = await internet().fetch(
    `${aiProvidersControlUrl}?anywhere=${encodeURIComponent(text)}`
  );
  return await response.json();
};

/** How many requests a provider got whose headers or body carry `text`. */
export const sentCount = async (text: string): Promise<number> => {
  const carried = await carrying(text);
  return carried.length;
};

/**
 * Where the requests carrying `marker` took `key`: the hosts and the
 * headers it was in, whether a body held it, and whether connect let
 * core's placeholder through to the provider.
 */
export const keyPlaces = async (marker: string, key: string) => {
  const carried = await carrying(marker);
  const placeholder = await carrying(aiCredentialPlaceholder);
  return {
    hosts: [...new Set(carried.map(({ host }) => host))],
    headers: [
      ...new Set(
        carried.flatMap(({ headers }) =>
          Object.entries(headers)
            .filter(([, value]) => value.includes(key))
            .map(([name]) => name)
        )
      ),
    ],
    inBody: carried.some(({ body }) => body.includes(key)),
    placeholder: placeholder.length > 0,
  };
};

/** The realtime sockets OpenAI's fake took, oldest first. */
export const realtimeSockets = async (): Promise<RealtimeSocket[]> => {
  const response = await internet().fetch(realtimeControlUrl);
  return await response.json();
};

/** The newest realtime socket OpenAI's fake took, if any. */
export const newestSocket = async (): Promise<RealtimeSocket | undefined> => {
  const sockets = await realtimeSockets();
  return sockets.at(-1);
};

/** Has OpenAI's fake act on its open sockets: close them, send an error, or settle at a pause. */
export const actOnRealtime = async (
  act: { close: number } | { error: string } | { pause: true }
): Promise<void> => {
  await internet().fetch(realtimeControlUrl, {
    method: "POST",
    body: JSON.stringify(act),
  });
};

/** Releases the reply held as `name` (a planned `{ release }`). */
export const release = async (name: string): Promise<void> => {
  await internet().fetch(releaseUrl, {
    method: "POST",
    body: JSON.stringify({ release: name }),
  });
};

/**
 * `real`, connect's binding, answering that it holds no key of Grasp's,
 * as on premises or a stack without them: Grasp's own features are then
 * unavailable, and documents are read in the Worker. Connect is a Worker
 * of its own, the boundary to the providers; everything else of it as is.
 */
export const connectWithoutGraspKeys = (real: Env["CONNECT"]): Env["CONNECT"] =>
  new Proxy(real, {
    get: (target, name) => {
      if (name === "aiProviderRoutes") {
        return async () => ({
          ...(await real.aiProviderRoutes()),
          platform: [],
        });
      }
      // Any other method as connect has it: an RPC stub binds nothing.
      const method: unknown = Reflect.get(target, name);
      return typeof method === "function"
        ? async (...args: unknown[]): Promise<unknown> =>
            await Reflect.apply(method, target, args)
        : method;
    },
  });
