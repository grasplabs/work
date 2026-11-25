import { createFileRoute } from "@tanstack/react-router";

import { AdminPage } from "../admin/page.tsx";
import { VoiceLab } from "../admin/voice-lab.tsx";

/** Voice Lab: the interview as one live voice session at Mistral, tried out by Grasp's staff (src/admin/voice-lab.tsx). */
const VoiceLabPage = () => (
  <AdminPage
    description="Hear how an interview feels as one live voice session, beside the interview as it runs today."
    title="Voice Lab"
  >
    <VoiceLab />
  </AdminPage>
);

export const Route = createFileRoute("/voice-lab")({
  component: VoiceLabPage,
});
