import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { keptAnswersOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// A model an organization saved that pi's catalog no longer has, as a Pi
// upgrade drops some (1.4 to 1.6: OpenAI's gpt-4, o1 and o3-mini,
// Mistral's pixtral and devstral among them): its default, or an agent's
// own model. Settings, chat and its turns go on with the models still
// there. Its own file: the turn it answers spends in the month it is,
// which model-settings.test.ts counts from nothing.

const idp = mockIdp();

const anthropic = "anthropic/claude-sonnet-4-5";
const mistral = "mistral/mistral-large-2512";

describe(
  "a saved model pi's catalog no longer has",
  { timeout: 60_000 },
  () => {
    it("leaves out a saved model pi's catalog no longer has, the default or an agent's own, and answers a chat turn with the first model still allowed", async () => {
      // Saved on an earlier catalog, which had them; pi's has neither now.
      const goneDefault = "openai/gpt-4o-2024-05-13";
      const goneOwn = "openai/o1";
      const gateway = await fakeProviderFor(
        [goneDefault, goneOwn, anthropic, mistral],
        says("Still here.")
      );
      const admin = await signedInApi(idp, "admin");
      const member = await signedInApi(idp, "user");
      const agent = await admin.api.connections.makeAgent({
        name: `Claire ${crypto.randomUUID().slice(0, 8)}`,
        face: "claire",
        job: "Chases unpaid invoices.",
        modelRole: null,
        model: anthropic,
      });
      await env.DB.prepare("UPDATE agents SET model = ? WHERE id = ?")
        .bind(goneOwn, agent.id)
        .run();
      await admin.api.connections.setAgentReach(agent.id, true, {
        who: "everyone",
      });

      const [{ models: offered }, { choice }] = await Promise.all([
        admin.api.models.settings(),
        admin.api.aiProviders.list(),
      ]);
      const settings = {
        admin: offered,
        providers: choice,
        chat: await member.api.chats.models(),
        efforts: Object.keys(await member.api.chats.efforts()),
        names: Object.keys(await member.api.chats.names()),
      };
      // The model the chat offers first, as the composer asks it.
      const [first = ""] = settings.chat;
      const chat = await member.api.chats.create("With Claire", agent.id);
      await member.api.chats.send(chat.id, { text: "Hi.", model: first });
      await vi.waitFor(
        async () => {
          const kept = await keptAnswersOf(member.userId);
          expect(kept.flat()).toContain("Still here.");
        },
        { timeout: 10_000 }
      );
      const asked = gateway.requests.map(({ body }) => JSON.stringify(body));

      expect({
        settings,
        asked:
          asked.length > 0 &&
          asked.every((body) => body.includes("claude-sonnet-4-5")),
      }).toStrictEqual({
        settings: {
          admin: [anthropic, mistral],
          providers: { defaultModel: null, fallbacks: [anthropic, mistral] },
          chat: [anthropic, mistral],
          efforts: [anthropic, mistral],
          names: [anthropic, mistral],
        },
        asked: true,
      });
    });
  }
);
