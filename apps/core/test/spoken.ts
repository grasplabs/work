import { speechPath } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";

import { platformAi } from "../src/platform-ai.ts";
import { keptLine } from "../src/speech-cache.ts";
import { speechModelOf } from "../src/speech.ts";
import { routed } from "./sign-in.ts";

// The interviewer's voice as the pages ask for it (GRA-1897): through the
// speech endpoint, one piece of text at a time (the interview page says a
// line a sentence at a time, the read-back as the sentences of its
// story), in Stephen's voice in English; and whether the voice's cache
// still keeps a piece, under the key the endpoint kept it by.

/** Asks for `text` to be said on someone's link, as the interview page does. */
export const sayOnLink = async (
  { secret, cookie }: { secret: string; cookie: string },
  text: string
): Promise<number> => {
  const response = await routed(speechPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie,
    },
    body: JSON.stringify({ text, language: "en", link: { secret } }),
  });
  await response.body?.cancel();
  return response.status;
};

/** Asks for `text` to be said for an admin signed in as `session`, as their onboarding does. */
export const sayForAdmin = async (
  session: string,
  text: string
): Promise<number> => {
  const response = await routed(speechPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ text, language: "en" }),
  });
  await response.body?.cancel();
  return response.status;
};

/** Whether the voice's cache keeps `text` as the endpoint said it. */
export const stillKept = async (text: string): Promise<boolean> =>
  (await keptLine(env, {
    text,
    // Asked without a tone: said bare (`spokenOf`).
    spoken: text,
    voice: platformAi.speech.voices.stephen,
    model: speechModelOf(),
    language: "en",
  })) !== undefined;
