import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import { PlatformNav, platformCrumb } from "../../admin/platform-nav.tsx";
import { PlatformSpendPanel } from "../../admin/platform-spend.tsx";
import { fetchPlatformSpend } from "../../platform-ai-functions.ts";

/**
 * Platform → AI: what Grasp's own AI features cost Grasp in all
 * (src/admin/platform-spend.tsx). Which provider and model each uses is
 * fixed in core's code (its src/platform-ai.ts), at their EU hosts.
 */
const PlatformAiPage = () => {
  const { spend } = Route.useLoaderData();
  return (
    <AdminPage
      description="The AI features Grasp pays for, the same for every company: converting PDFs for the Brain, transcription and speech, at OpenAI and ElevenLabs in the EU. Each company's own AI is its own, connected by its admins with their keys."
      parents={[platformCrumb]}
      title="AI"
    >
      <PlatformNav />
      <PlatformSpendPanel spend={spend} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/ai")({
  loader: () => {
    // Not awaited: every core is read live. A read that fails shows a
    // line, never the error page.
    const spend = (async () => {
      try {
        return await fetchPlatformSpend();
      } catch {
        return null;
      }
    })();
    return { spend };
  },
  head: () => ({ meta: [{ title: "AI" }] }),
  component: PlatformAiPage,
});
