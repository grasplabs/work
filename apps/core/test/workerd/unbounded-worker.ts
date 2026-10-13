import {
  appIdSchema,
  chatIdSchema,
  workflowIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";

import { loadServer } from "../../src/app.ts";
import type { Acting } from "../../src/auth/identity.ts";
import { buildDependencies } from "../../src/packages/build.ts";
import { resolveDependencies } from "../../src/packages/resolve.ts";
import { loadPreview } from "../../src/preview.ts";
import { buildScreens } from "../../src/screens.ts";
import {
  declaredParams,
  dryRunTests,
  loadRun,
  workflowTestFailures,
} from "../../src/workflows/code.ts";

// A workflow's run and metadata, a draft's preview, an App's server
// object, the screen compiler and the package builder on plain workerd
// with no sandbox and no `SANDBOX_IN_PROCESS=unbounded`
// (scripts/workerd-unbounded-loaders.test.ts): core loads none of them, as
// no sandbox bounds them here.

/** An App's builder, as far as a package resolve or build reads one first. */
const builder: Acting = {
  userId: "builder",
  role: "builder",
  teams: [],
  staff: false,
};

/** Why `load` refused, or that it didn't. */
const refusal = async (load: () => unknown): Promise<string> => {
  try {
    await load();
    return "loaded";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : "?";
  }
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/run") {
      return new Response(
        await refusal(() =>
          loadRun(env, {
            version: 1,
            workflow: workflowIdSchema.parse("intake"),
            files: {},
          })
        )
      );
    }
    if (pathname === "/metadata") {
      return new Response(
        await refusal(
          async () =>
            // Run in a sandbox session where one is bound: here, none is.
            await declaredParams(
              { ...env, SANDBOX_HOST: undefined },
              appIdSchema.parse(crypto.randomUUID()),
              1,
              workflowIdSchema.parse("intake"),
              {}
            )
        )
      );
    }
    if (pathname === "/tests") {
      return new Response(
        await refusal(
          async () =>
            await workflowTestFailures({ ...env, SANDBOX_HOST: undefined }, 1, {
              "workflows/intake.ts": "export default {};",
              "workflows/intake.workflow-tests.ts": "export default {};",
            })
        )
      );
    }
    if (pathname === "/dry-run") {
      return new Response(
        await refusal(
          async () =>
            await dryRunTests(
              { ...env, SANDBOX_HOST: undefined },
              appIdSchema.parse(crypto.randomUUID()),
              1,
              workflowIdSchema.parse("intake"),
              {},
              {}
            )
        )
      );
    }
    if (pathname === "/preview") {
      return new Response(
        await refusal(
          async () =>
            await loadPreview(
              env,
              {
                app: appIdSchema.parse(crypto.randomUUID()),
                preview: {
                  workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
                  chatId: chatIdSchema.parse(crypto.randomUUID()),
                  revision: 1,
                },
              },
              { base: 1, changes: {}, revision: 1 }
            )
        )
      );
    }
    if (pathname === "/app") {
      return new Response(
        await refusal(
          async () =>
            await loadServer(env, appIdSchema.parse(crypto.randomUUID()), 1, 1)
        )
      );
    }
    if (pathname === "/screens") {
      return new Response(
        await refusal(
          async () =>
            await buildScreens(env, {
              "screens/home.tsx": "export default () => null;",
            })
        )
      );
    }
    if (pathname === "/resolve") {
      return new Response(
        await refusal(async () => await resolveDependencies(env, builder, {}))
      );
    }
    if (pathname === "/build") {
      return new Response(
        await refusal(async () => await buildDependencies(env, builder, {}))
      );
    }
    return new Response("core answers");
  },
  // Typed as core's env, as such a deployment binds it: of it, only its
  // runtime profile is read before both loaders refuse.
} satisfies ExportedHandler<Env>;
