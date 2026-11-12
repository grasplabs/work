import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// `env.build.blueprints` in a chat's code: the blueprints a plan's App may
// start from (`proposePlan`), as its person may start from them. The
// agent creates no App: Build it makes one from the blueprint the plan
// names (make.test.ts). These tests start from the ways it can fail: the
// agent reads a blueprint its person couldn't start from (of an App they
// have no role in).

const idp = mockIdp();

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>): string =>
  `export default async (self, env) => {
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/**
 * A chat of `role`'s person answered by `replies`, whose agent may build
 * Apps; the Ledger, a builder's App marked as a blueprint and shared with
 * the person, which reads a collection; and the Vault, a blueprint of
 * another builder's that the person has no role in: by their blueprints'
 * IDs.
 */
const setUp = async (
  replies: (apps: { ledger: string; vault: string }) => ProviderReply[],
  role: "builder" | "user" = "builder"
) => {
  const admin = await signedInApi(idp, "admin");
  const [owner, stranger] = await Promise.all([
    signedInApi(idp, "builder"),
    signedInApi(idp, "builder"),
  ]);
  const person = await signedInApi(idp, role);
  const { id: ledger } = await owner.api.apps.create({ name: "Ledger" });
  const version = await release(owner, ledger, {
    "src/routes/index.tsx":
      'import { createFileRoute } from "@tanstack/react-router"; export const Route = createFileRoute("/")({ component: () => null });\n',
  });
  const { collectionId } = await collectionWithNote(admin.api, {
    name: "Handbook",
    access: "everyone",
  });
  await requestGranted(
    idp,
    admin,
    readCollection({ type: "app", appId: ledger }, collectionId)
  );
  const { id: ledgerBlueprint } = await owner.api.apps.blueprints.mark(
    ledger,
    version
  );
  await owner.api.apps.members.add(ledger, {
    type: "person",
    id: person.userId,
    role: "user",
  });
  const { id: vault } = await stranger.api.apps.create({ name: "Vault" });
  const { id: vaultBlueprint } = await stranger.api.apps.blueprints.mark(
    vault,
    await release(stranger, vault, { "notes.md": "vault" })
  );
  const chat = await chatOf(
    person.userId,
    ...replies({ ledger: ledgerBlueprint, vault: vaultBlueprint })
  );
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "collection", collectionId: "apps" },
    actions: ["read"],
    binding: "APP_LIBRARY",
  });
  return { chat };
};

describe(
  "the blueprints a chat's plan may start from",
  { timeout: 60_000 },
  () => {
    it("lists only those its person may start from, whether they build or not", async () => {
      const listing = () => [
        codeStep(
          tryEach({
            listed:
              "(await env.build.blueprints()).map(({ name, version }) => ({ name, version }))",
          })
        ),
        says("Listed."),
      ];
      // One chat at a time: the provider answers with the replies of the
      // chat set up last.
      const builds = await setUp(listing);
      await builds.chat.ask("What could I start from?");
      const uses = await setUp(listing, "user");
      await uses.chat.ask("What could I start from?");

      const results = await Promise.all(
        [builds, uses].map(async ({ chat }) => {
          const [result] = await codeResults(chat.stub, chat.chat.id);
          return returned(result?.text);
        })
      );
      // The Vault, of an App the person has no role in, is never listed.
      expect(results).toStrictEqual([
        { listed: [{ name: "Ledger", version: 1 }] },
        { listed: [{ name: "Ledger", version: 1 }] },
      ]);
    });
  }
);
