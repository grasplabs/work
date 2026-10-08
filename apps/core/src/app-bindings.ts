import { appErrors } from "@grasp-os/shared/apps";
import type { ConnectResult } from "@grasp-os/shared/connect";
import type { AppId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { requireStillOpen } from "./app-access.ts";
import type { AppExportBinding } from "./app-calls.ts";
import type { Admission, Admitted, InvocationKind } from "./app.ts";
import {
  collectionGrantOf,
  connectionGrantOf,
  exportGrantOf,
  requireStepKey,
  runStubCall,
  stubsOf,
} from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { appHost } from "./durable-objects.ts";
import type { AppGuestsBinding } from "./guests-binding.ts";
import type { AppCollectionBinding } from "./knowledge/app-binding.ts";
import { activePermissions, authorizeExport } from "./permissions.ts";
import type { AppStatisticsBinding } from "./statistics-binding.ts";

/** What App code passes as the caller: the one its method was called with. */
const callerSchema = z.object({ token: z.string().min(1).max(100) });

/**
 * Refuses a stub call whose call has lost what let it in (`admission`),
 * since: the person's role in App `app`, for a screen's call
 * (`app.not_found`, as for any request of theirs), or, for a call from
 * another App, the calling App's permission on `app`'s export
 * (`permission.denied`) and the calling App's own call (`from`), admitted
 * again as its own stubs would be: so a call down a chain stops with the
 * first one, by its deadline, its code's generation and what let it in,
 * however many Apps deep.
 *
 * A workflow run's call (no admission) is not checked here for the run
 * itself: that the run is still going and its version still approved is
 * checked as the call starts, not again on each stub call. Its deadline
 * bounds that, and the person and the permission each stub uses are still
 * checked on every call.
 */
const requireStillAdmitted = async (
  env: Env,
  app: AppId,
  admission: Admission | undefined
): Promise<void> => {
  if (admission?.type === "role") {
    await requireStillOpen(env, admission.person, app);
  } else if (admission?.type === "export") {
    const { authority, method, access, permissionId, from } = admission;
    await authorizeExport(
      env,
      authority,
      app,
      { method, access },
      permissionId
    );
    if (from !== undefined) {
      // oxlint-disable-next-line no-use-before-define -- each App's admission checks the one above it
      await callerOf(env, from.app, { token: from.token }, "read");
    }
  }
};

/**
 * The token App code passed as its caller: only the token is read, so
 * nothing else App code puts on it counts.
 */
export const tokenOf = (caller: unknown): string => {
  const parsed = callerSchema.safeParse(caller);
  if (!parsed.success) {
    throw appErrors.create("app.caller_invalid");
  }
  return parsed.data.token;
};

/**
 * Admits one stub call for the call `token` names: `first` asks the host
 * (`App.admit`, or `App.claimStatistic`, which also counts the use), what
 * let the call in is checked again (`requireStillAdmitted`), and the host
 * is asked once more, last, for `use`. That is not yet the act: a stub
 * that awaits more before it acts (a permission check, signing, a lookup)
 * admits the call again, in full, just before (`stillAdmitted`): a
 * connection call before it
 * goes to connect, with a capability that expires by the call's deadline;
 * a guest chat or a record just before its write's batch. A statistics
 * point is written straight after, with nothing awaited between.
 */
const admitted = async (
  env: Env,
  app: AppId,
  token: string,
  use: InvocationKind,
  first: (host: ReturnType<typeof appHost>) => Promise<Admitted>
): Promise<Admitted> => {
  const host = appHost(env, app);
  const { admission } = await first(host);
  await requireStillAdmitted(env, app, admission);
  return await host.admit(token, use);
};

/**
 * Who `caller` is, as App `app`'s host knows them while their call runs,
 * that call's step key, for a workflow run's caller, where the call is
 * within calls between Apps, the App method it calls, and what the call
 * may do, admitted by the host for `use` (`App.admit`): a stub call that
 * changes anything (`write`) from a call that may only read is
 * `app.read_only`. App code can't name anyone, or say what its call may
 * do: only the caller's token is read, and a caller that isn't one of a
 * running call of this App (made up, ended, past its deadline, on code
 * since stopped, or another App's) is `app.caller_invalid`. What let the
 * call in is checked again first (`admitted`).
 */
export const callerOf = async (
  env: Env,
  app: AppId,
  caller: unknown,
  use: InvocationKind
): Promise<Admitted> => {
  const token = tokenOf(caller);
  return await admitted(
    env,
    app,
    token,
    use,
    async (host) => await host.admit(token, use)
  );
};

/**
 * Admits the call `token` names for `use` again, in full, as `callerOf`
 * does: a stub's last word before it acts, after whatever it awaited
 * since it was admitted. Not the host's word alone: what let the call in
 * (the person's role in the App, the calling App's permission and its own
 * call, up the chain) can be gone while the stub awaited, with the call's
 * token still good. Its last step is the host's, and the stub awaits
 * nothing after it but the act.
 */
export const stillAdmitted = async (
  env: Env,
  app: AppId,
  token: string,
  use: InvocationKind
): Promise<void> => {
  await callerOf(env, app, { token }, use);
};

/**
 * Who `caller` is, as `callerOf` says, counting one statistics `use` (a
 * point or a read) of their call against its bounds
 * (`App.claimStatistic`): `statistics.rate_limited` past a bound. With
 * the step's key and its attempt, for a workflow run's caller, which its
 * points are kept by until the step completes.
 */
export const statisticCallerOf = async (
  env: Env,
  app: AppId,
  caller: unknown,
  use: StatisticUse
): Promise<{
  authority: Authority;
  idempotencyKey: string | undefined;
  attempt: string | undefined;
}> => {
  const token = tokenOf(caller);
  return await admitted(
    env,
    app,
    token,
    use === "point" ? "write" : "read",
    async (host) => await host.claimStatistic(token, use)
  );
};

/**
 * Who `caller` is, as `callerOf` says, to audit a statistics read of
 * theirs refused past its bounds: undefined once one was audited in the
 * App's minute (`App.limitedReadAudit`).
 */
export const limitedReadCallerOf = async (
  env: Env,
  app: AppId,
  caller: unknown
): Promise<{ authority: Authority } | undefined> => {
  const parsed = callerSchema.safeParse(caller);
  if (!parsed.success) {
    return undefined;
  }
  return await appHost(env, app).limitedReadAudit(parsed.data.token);
};

/**
 * A connection, as an App's server code holds it:
 * `await this.env.OUTLOOK.call(caller, action, input)`. One App serves
 * everyone using it, so the stub acts for no one on its own: each call
 * passes the caller of the App method it runs in, and the App's host says
 * who that is, while that method runs (see app.ts). App code can't name
 * anyone else. For a workflow run's caller, the only key a call takes is
 * the one on the caller (`caller.idempotencyKey`, its step's), as for the
 * run's own connection calls.
 */
export class AppConnectionBinding extends WorkerEntrypoint<
  Env,
  ConnectionGrant & { app: AppId }
> {
  /** Runs one of the connection's actions for `caller`, as `ConnectionBinding` does. */
  async call(
    caller: unknown,
    action: unknown,
    input: unknown,
    options?: unknown
  ): Promise<ConnectResult> {
    const { app, ...grant } = this.ctx.props;
    return await runStubCall(
      this.env,
      async (key) => {
        const token = tokenOf(caller);
        // Admitted as a read: whether the action changes anything is
        // connect's to know, and a call that may only read has it refuse
        // every side effect.
        const { authority, idempotencyKey, kind, path } = await callerOf(
          this.env,
          app,
          { token },
          "read"
        );
        if (authority.mode === "workflow") {
          requireStepKey(key, idempotencyKey);
        }
        return {
          authority,
          readOnly: kind === "read",
          notAfter: path.deadline,
          stillAllowed: async () => {
            await stillAdmitted(this.env, app, token, "read");
          },
        };
      },
      grant,
      [action, input, options]
    );
  }
}

/** A stub an App's server code holds. */
type AppStub =
  | Fetcher<AppConnectionBinding>
  | Fetcher<AppCollectionBinding>
  | Fetcher<AppExportBinding>
  | Fetcher<AppStatisticsBinding>
  | Fetcher<AppGuestsBinding>;

/**
 * The env of an App's server code, built from the App's permission
 * records as they are now: its connections, the collections it may read,
 * the other Apps whose exports it may call, the platform's statistics if
 * it may read them, and guest chats if it may invite guests; and its own statistics (`STATISTICS`), which every
 * App has. Its stubs act for no one person:
 * each call passes its caller.
 */
export const appBindings = async (
  env: Env,
  app: AppId
): Promise<Record<string, AppStub>> => {
  const context = { type: "app", appId: app } as const;
  const connectionOf = connectionGrantOf(context);
  const collectionOf = collectionGrantOf(context);
  const granted = stubsOf<AppStub>(
    await activePermissions(env, { type: "app", appId: app }),
    (permission) => {
      const connection = connectionOf(permission);
      if (connection !== undefined) {
        return exports.AppConnectionBinding({ props: { ...connection, app } });
      }
      const exported = exportGrantOf(permission);
      if (exported !== undefined) {
        return exports.AppExportBinding({
          props: { ...exported, caller: app },
        });
      }
      // A platform permission has one action, which its stub does.
      if (permission.object.type === "platform") {
        return permission.actions.includes("guests")
          ? exports.AppGuestsBinding({
              props: { app, permissionId: permission.id },
            })
          : exports.AppStatisticsBinding({
              props: { app, permissionId: permission.id },
            });
      }
      const collection = collectionOf(permission);
      return collection === undefined
        ? undefined
        : exports.AppCollectionBinding({ props: { ...collection, app } });
    }
  );
  // A platform binding name: no permission's stub has it.
  return {
    ...granted,
    STATISTICS: exports.AppStatisticsBinding({ props: { app } }),
  };
};
