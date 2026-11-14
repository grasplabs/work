import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Subject } from "@grasp-os/shared/subject";

/**
 * Durable Objects keep their data in the EU. workerd doesn't implement
 * jurisdictions (tests, local dev) and on-prem has no Cloudflare jurisdiction,
 * so those pass `DURABLE_OBJECT_JURISDICTION=none` with `--var` or as a
 * binding; it is never set in wrangler.jsonc. Unset or any other value means
 * the EU, so a deployment can't leave it by mistake.
 */
/** The namespace to get an object from, in the EU unless turned off. */
export const inJurisdiction = <T extends Rpc.DurableObjectBranded | undefined>(
  env: Pick<Env, "DURABLE_OBJECT_JURISDICTION">,
  namespace: DurableObjectNamespace<T>
): DurableObjectNamespace<T> =>
  env.DURABLE_OBJECT_JURISDICTION === "none"
    ? namespace
    : namespace.jurisdiction("eu");

/** The object that hosts an App's server code (app.ts), named by the App's ID. */
export const appHost = (
  env: Pick<Env, "APPS" | "DURABLE_OBJECT_JURISDICTION">,
  app: AppId
) => inJurisdiction(env, env.APPS).getByName(app);

/**
 * An App's preview of its draft (app-preview.ts), named by the App's ID:
 * one per App, shared by everyone who builds it.
 */
export const appPreview = (
  env: Pick<Env, "APP_PREVIEWS" | "DURABLE_OBJECT_JURISDICTION">,
  app: AppId
) => inJurisdiction(env, env.APP_PREVIEWS).getByName(app);

/**
 * Who follows an App's or workflow's draft (draft-watch.ts), named by its
 * subject: one per draft.
 */
export const draftWatch = (
  env: Pick<Env, "DRAFT_WATCHES" | "DURABLE_OBJECT_JURISDICTION">,
  { kind, id }: Subject
) => inJurisdiction(env, env.DRAFT_WATCHES).getByName(`${kind}:${id}`);

/**
 * A chat's own object (chat-session.ts): its agent's turns, named by its
 * workspace and chat.
 */
export const chatSession = (
  env: Pick<Env, "CHAT_SESSIONS" | "DURABLE_OBJECT_JURISDICTION">,
  id: WorkspaceId,
  chatId: ChatId
) => inJurisdiction(env, env.CHAT_SESSIONS).getByName(`${id}/${chatId}`);

/** A workspace's object (workspace.ts): its chats and their agent. */
export const workspace = (
  env: Pick<Env, "WORKSPACES" | "DURABLE_OBJECT_JURISDICTION">,
  id: WorkspaceId
) => inJurisdiction(env, env.WORKSPACES).getByName(id);

/** How many times a call to an object is made, should a restart break it. */
const callAttempts = 3;

/**
 * Whether `error` is the platform's word that a call to an object broke on
 * its way, so making it again may go through: the object reset under it
 * (`durableObjectReset`, its restart, a deploy, `ctx.abort`), or anything
 * else the platform marks `retryable` (a lost connection), never an
 * `overloaded` object, as Cloudflare advises for Durable Object calls. Never
 * an error the object threw itself.
 */
const brokeOnTheWay = (error: unknown): boolean =>
  error instanceof Error &&
  !isExpectedError(error) &&
  (Reflect.get(error, "durableObjectReset") === true ||
    Reflect.get(error, "retryable") === true) &&
  Reflect.get(error, "overloaded") !== true;

/**
 * Makes `call` to an object, again when it broke on its way
 * (`brokeOnTheWay`), at most `callAttempts` times in all. `call` makes a
 * stub of its own each attempt: one to an object that restarted stays
 * broken. Only for a call that is safe to make twice.
 */
export const callObject = async <T>(call: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- again only once it broke
      return await call();
    } catch (error) {
      if (attempt >= callAttempts || !brokeOnTheWay(error)) {
        throw error;
      }
      log.warn("object.call_retried", { attempt, ...errorFields(error) });
    }
  }
};
