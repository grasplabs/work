import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import { PlatformAi } from "../../admin/platform-ai.tsx";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { PlatformSpendPanel } from "../../admin/platform-spend.tsx";
import {
  fetchPlatformAi,
  fetchPlatformSpend,
} from "../../platform-ai-functions.ts";

/**
 * Platform → AI: which provider and model each of Grasp's own AI features
 * uses, for every company (src/admin/platform-ai.tsx), and what they cost
 * Grasp in all (src/admin/platform-spend.tsx).
 */
const PlatformAiPage = () => {
  const { view, spend } = Route.useLoaderData();
  return (
    <AdminPage
      description="The AI features Grasp pays for, the same for every company: converting PDFs for the Brain, transcription and speech. Each company's own AI is its own, connected by its admins with their keys."
      parents={[platformCrumb]}
      title="AI"
    >
      <PlatformNav />
      <PlatformAi view={view} />
      <PlatformSpendPanel spend={spend} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/ai")({
  loader: async () => {
    // Not awaited: every core is read live, and a slow one never holds up
    // the settings. A read that fails shows a line, never the error page.
    const spend = (async () => {
      try {
        return await fetchPlatformSpend();
      } catch {
        return null;
      }
    })();
    return { view: await fetchPlatformAi(), spend };
  },
  head: () => ({ meta: [{ title: "AI" }] }),
  component: PlatformAiPage,
});
