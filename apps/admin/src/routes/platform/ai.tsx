import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import { PlatformAi } from "../../admin/platform-ai.tsx";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { fetchPlatformAi } from "../../platform-ai-functions.ts";

/**
 * Platform → AI: which provider and model each of Grasp's own AI features
 * uses, for every company (src/admin/platform-ai.tsx).
 */
const PlatformAiPage = () => {
  const view = Route.useLoaderData();
  return (
    <AdminPage
      description="The AI features Grasp pays for, the same for every company: converting PDFs for the Brain, transcription and speech. Each company's own AI is its own, connected by its admins with their keys."
      parents={[platformCrumb]}
      title="AI"
    >
      <PlatformNav />
      <PlatformAi view={view} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/ai")({
  loader: async () => await fetchPlatformAi(),
  head: () => ({ meta: [{ title: "AI" }] }),
  component: PlatformAiPage,
});
