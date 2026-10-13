import {
  appIdSchema,
  chatIdSchema,
  workflowIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";

import { loadServer } from "../../src/app.ts";
import { loadPreview } from "../../src/preview.ts";
import { declaredParams, loadRun } from "../../src/workflows/code.ts";

// A workflow's run and metadata, a draft's preview and an App's server
// object on plain workerd with no
// sandbox and no `SANDBOX_IN_PROCESS=unbounded`
// (scripts/workerd-unbounded-loaders.test.ts): core loads neither, as no
// sandbox bounds them here.

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
            await declaredParams(
              env,
              appIdSchema.parse(crypto.randomUUID()),
              1,
              workflowIdSchema.parse("intake"),
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
    return new Response("core answers");
  },
  // Typed as core's env, as such a deployment binds it: of it, only its
  // runtime profile is read before both loaders refuse.
} satisfies ExportedHandler<Env>;
