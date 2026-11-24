import type { Acting } from "../../src/auth/identity.ts";
import { buildPackages } from "../../src/packages/build.ts";
import { buildPages } from "../../src/pages.ts";
import { loadSealedIsolate } from "../../src/workflows/sealed-isolate.ts";

// An independent JSON workflow's run, the App compiler and the package
// builder on plain workerd with no sandbox and no
// `SANDBOX_IN_PROCESS=unbounded` (scripts/workerd-unbounded-loaders.test.ts):
// core loads none of them, as no sandbox bounds them here. Each is asked
// for with `SANDBOX_HOST` unbound, as by a deployment that forgot it.

/** An App's builder, as far as a package build reads one first. */
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
          // A JSON run's build, in a sandbox session where one is bound:
          // here, none is.
          loadSealedIsolate(
            { ...env, SANDBOX_HOST: undefined },
            {
              owner: `workflow-resource:${crypto.randomUUID()}`,
              mainModule: "run.js",
              modules: async () => await Promise.resolve({}),
              attemptHostMethods: [],
            }
          )
        )
      );
    }
    if (pathname === "/pages") {
      return new Response(
        await refusal(
          async () =>
            await buildPages(
              { ...env, SANDBOX_HOST: undefined },
              {
                "src/routes/index.tsx":
                  'import { createFileRoute } from "@tanstack/react-router"; export const Route = createFileRoute("/")({ component: () => null });',
              },
              "app-test"
            )
        )
      );
    }
    if (pathname === "/build") {
      return new Response(
        await refusal(
          async () =>
            await buildPackages(
              { ...env, SANDBOX_HOST: undefined },
              { type: "person", userId: builder.userId },
              { type: "app", id: "app-test" },
              "0".repeat(64),
              "worker"
            )
        )
      );
    }
    return new Response("core answers");
  },
  // Typed as core's env, as such a deployment binds it: of it, only its
  // runtime profile is read before both loaders refuse.
} satisfies ExportedHandler<Env>;
