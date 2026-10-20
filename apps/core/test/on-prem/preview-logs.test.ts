import { chatIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { chatAgentId, personalWorkspaceId } from "../../src/chats-rpc.ts";
import { workspace } from "../../src/durable-objects.ts";
import {
  codeResults,
  codeStep,
  model,
  pointAtGateway,
  says,
} from "../agent-chat.ts";
import { fakeGateway } from "../ai-gateway.ts";
import { release, requestGranted } from "../apps.ts";
import { mockIdp } from "../idp.ts";
import { signedInApi } from "../sign-in.ts";

// What a spec 8 draft's function writes with `console` in its sealed
// preview on-prem (GRA-689): it runs in a sandbox session, which the
// sandbox host silences, so the host records its lines instead and hands
// them back to core for the agent's next check, as a Loader tail does on
// Cloudflare (server-logs.ts). `SANDBOX_HOST` is bound to the sandbox
// supervisor this project starts.

const idp = mockIdp();

/** A notes App of spec 8's layout whose `create` writes what it creates. */
const drafted: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation } from "#grasp/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    console.warn("creating", { title: args.title });
    return await ctx.db.insert("notes", args);
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoice desk",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

describe(
  "a spec 8 draft's sealed preview on-prem",
  { timeout: 180_000 },
  () => {
    it("hands the agent's check what its function wrote with console", async () => {
      const admin = await signedInApi(idp, "admin");
      const builder = await signedInApi(idp, "builder");
      const { id: app } = await builder.api.apps.create({
        name: "Invoice desk",
      });
      await release(builder, app, { "AGENTS.md": "# Invoice desk\n" });
      const granted = await admin.api.permissions.list();
      if (
        !granted.some(
          ({ subject, binding, status }) =>
            subject.type === "agent" &&
            binding === "APP_LIBRARY" &&
            status === "active"
        )
      ) {
        await requestGranted(idp, admin, {
          subject: { type: "agent", agentId: chatAgentId },
          object: { type: "collection", collectionId: "apps" },
          actions: ["read", "write"],
          binding: "APP_LIBRARY",
        });
      }
      const chat = await builder.api.chats.create("Invoice desk");
      const stub = workspace(env, personalWorkspaceId(builder.userId));
      await pointAtGateway(
        stub,
        fakeGateway(
          codeStep(`export default async (self, env) => {
          const [app] = (await env.apps.list()).filter(({ name }) => name === "Invoice desk");
          await env.build.write(app.id, ${JSON.stringify(drafted)});
          const created = await env.build.call(app.id, "notes.create", { title: "Invoice 7" });
          const { preview } = await env.build.check(app.id);
          return {
            created: created.ok,
            logs: preview.logs.map(({ level, message, method }) => ({ level, message, method })),
          };
        };`),
          says("Checked.")
        )
      );

      await stub.ask(chatIdSchema.parse(chat.id), {
        text: "Try the invoice desk's notes",
        model,
      });

      const [result] = await codeResults(stub, chat.id);
      expect(
        z
          .unknown()
          .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"))
      ).toStrictEqual({
        created: true,
        logs: [
          {
            level: "warn",
            message: 'creating {"title":"Invoice 7"}',
            method: "notes.create",
          },
        ],
      });
    });
  }
);
