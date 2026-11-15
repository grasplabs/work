import { removedLine } from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { keepLine, storedKeyOf } from "../src/speech-cache.ts";
import { speechModelOf } from "../src/speech.ts";
import { adminCommands } from "./admin-command.ts";
import { platformElevenLabsKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { onLink, openedFor } from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import { carrying, plan, release } from "./platform-providers.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import { sayForAdmin, sayOnLink, stillKept } from "./spoken.ts";

// A line the voice is still saying as what it was said for is erased
// (GRA-1897): the page asks for lines ahead, so pressing Delete while
// Stephen speaks lands while the voice works on the next. The store
// noted the line's key as it was asked; the erasure takes the note, and
// the line, kept once the voice answers, is taken out again then. The
// voice (ElevenLabs, behind connect) is the outside system: its answer is
// held until each erasure has landed.

const idp = mockIdp();

/** A line no other test says, so the cache and the voice have never seen it. */
const lineOf = (): string =>
  `So ${unique().replaceAll(/\d/gu, "x")} comes first.`;

/**
 * Asks for `text` to be said (`ask`) with the voice's answer held until
 * `erase` has run, then lets it answer: the request's status, and whether
 * it reached the voice before the erasure.
 */
const sayingWhile = async (
  text: string,
  ask: () => Promise<number>,
  erase: () => Promise<unknown>
): Promise<{ status: number; reached: number }> => {
  const held = `voice-${unique()}`;
  await plan(platformElevenLabsKey, [{ release: held }]);
  const saying = ask();
  await expect
    .poll(async () => await carrying(text), { timeout: 10_000 })
    .toHaveLength(1);
  const asked = await carrying(text);
  const reached = asked.length;
  await erase();
  await release(held);
  return { status: await saying, reached };
};

/** Whatever could still find `text`: its audio, a note of it, a key waiting to go. */
const leftOf = async (text: string) => {
  const key = await storedKeyOf(text);
  const rows = await runInDurableObject(
    onboardingStore(env),
    (_instance, state) => ({
      noted: state.storage.sql
        .exec("SELECT who FROM spoken_keys WHERE key = ?", key)
        .toArray().length,
      waiting: state.storage.sql
        .exec("SELECT key FROM forget_lines WHERE key = ?", key)
        .toArray().length,
    })
  );
  return { cached: await stillKept(text), ...rows };
};

const savedSchema = z.object({ version: z.number() });

/** An interview whose first line Stephen says as `text`. */
const interviewSaying = async (text: string) => {
  const { link, person } = await openedFor();
  const progress: InterviewProgress = {
    person: "progress",
    told: true,
    mode: "type",
    lines: [
      { from: "stephen", text },
      { from: "person", text: "It starts with a ticket.", typed: true },
    ],
    facts: [],
    phase: "steps",
    wants: "answer",
    startedAt: Date.now(),
    confirmed: 0,
    adding: false,
    addedAt: 0,
  };
  const saved = await onLink({ action: "save", ...link, version: 0, progress });
  const { version } = savedSchema.parse(await saved.json());
  return { link, person, progress, version };
};

/** The ways an interview's speech is erased while the voice says a line of it. */
const erasures: {
  way: string;
  erase: (
    taken: Awaited<ReturnType<typeof interviewSaying>>
  ) => Promise<unknown>;
}[] = [
  {
    way: "a delete from their link",
    erase: async ({ link }) => await onLink({ action: "delete", ...link }),
  },
  {
    way: "a withdrawal",
    erase: async ({ link }) => await onLink({ action: "withdraw", ...link }),
  },
  {
    way: "a new start Grasp's staff give",
    erase: async ({ person }) => await adminCommands().newStart(person),
  },
  {
    way: "removing the line",
    erase: async ({ link, progress, version }) =>
      await onLink({
        action: "save",
        ...link,
        version,
        progress: {
          ...progress,
          lines: progress.lines.map((line, at) =>
            at === 0 ? removedLine(line) : line
          ),
        },
      }),
  },
];

describe(
  "a line said while what it was said for is erased",
  { timeout: 60_000 },
  () => {
    it.each(erasures)(
      "is not kept after $way, and nothing is left to find it by",
      async ({ erase }) => {
        const text = lineOf();
        const taken = await interviewSaying(text);
        const link: Device = taken.link;

        const said = await sayingWhile(
          text,
          async () => await sayOnLink(link, text),
          async () => await erase(taken)
        );

        expect({ ...said, ...(await leftOf(text)) }).toStrictEqual({
          status: 200,
          reached: 1,
          cached: false,
          noted: 0,
          waiting: 0,
        });
      }
    );

    it("is not kept after the kickoff's deletion, for an admin, and nothing is left to find it by", async () => {
      const store = onboardingStore(env);
      await store.saveKickoff(
        {
          transcript: "We sell boats to the islands, and the ferries run late.",
          fileName: null,
          reading: {
            fields: { business: { text: "Boats", quote: "We sell boats" } },
            ask: {},
            teams: [],
          },
        },
        { type: "system" },
        await store.purgeMark()
      );
      const admin = await signedInWithRole(idp, "admin");
      const text = lineOf();

      const said = await sayingWhile(
        text,
        async () => await sayForAdmin(admin.session, text),
        async () => await store.deleteKickoff({ type: "system" })
      );

      expect({ ...said, ...(await leftOf(text)) }).toStrictEqual({
        status: 200,
        reached: 1,
        cached: false,
        noted: 0,
        waiting: 0,
      });
    });
  }
);

/** The store's alarm as set now; null for none. */
const alarmSet = async (): Promise<number | null> =>
  await runInDurableObject(
    onboardingStore(env),
    async (_instance, state) => await state.storage.getAlarm()
  );

/** Clears the store's alarm: every one set before has run. */
const noAlarm = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
};

/** The cache, refusing its next delete: it can't be reached a moment. */
const cacheDownOnce = () =>
  vi
    .spyOn(env.FILES, "delete")
    .mockRejectedValueOnce(new Error("The cache can't be reached."));

/**
 * Erases what `text` was said for with the cache down once and no alarm
 * set before: what is left then, whether an alarm was set, and what is
 * left once it ran.
 */
const erasedWithCacheDown = async (
  text: string,
  erase: () => Promise<unknown>
) => {
  await expect(stillKept(text)).resolves.toBeTruthy();
  await noAlarm();
  const down = cacheDownOnce();
  try {
    await erase();
  } finally {
    down.mockRestore();
  }
  const stuck = await leftOf(text);
  const armed = (await alarmSet()) !== null;
  const ran = await runDurableObjectAlarm(onboardingStore(env));
  return { stuck, armed, ran, after: await leftOf(text) };
};

/** Nothing left of a line, once the alarm took it out: what each case ends on. */
const takenOutByTheAlarm = {
  stuck: { cached: true, noted: 0, waiting: 1 },
  armed: true,
  ran: true,
  after: { cached: false, noted: 0, waiting: 0 },
};

describe("a line whose take-out fails", { timeout: 60_000 }, () => {
  it("is taken out by the alarm after a line removal", async () => {
    const text = lineOf();
    const taken = await interviewSaying(text);
    await expect(sayOnLink(taken.link, text)).resolves.toBe(200);

    const result = await erasedWithCacheDown(text, async () => {
      await onLink({
        action: "save",
        ...taken.link,
        version: taken.version,
        progress: {
          ...taken.progress,
          lines: taken.progress.lines.map((line, at) =>
            at === 0 ? removedLine(line) : line
          ),
        },
      });
    });

    expect(result).toStrictEqual(takenOutByTheAlarm);
  });

  it("is taken out by the alarm after the kickoff's deletion, for an admin", async () => {
    const store = onboardingStore(env);
    await store.saveKickoff(
      {
        transcript: "We sell boats to the islands, and the ferries run late.",
        fileName: null,
        reading: {
          fields: { business: { text: "Boats", quote: "We sell boats" } },
          ask: {},
          teams: [],
        },
      },
      { type: "system" },
      await store.purgeMark()
    );
    const admin = await signedInWithRole(idp, "admin");
    const text = lineOf();
    await expect(sayForAdmin(admin.session, text)).resolves.toBe(200);

    const result = await erasedWithCacheDown(
      text,
      async () => await store.deleteKickoff({ type: "system" })
    );

    expect(result).toStrictEqual(takenOutByTheAlarm);
  });

  it("is taken out by the alarm after the admin it was said for is erased as a person", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "admin");
    const text = lineOf();
    await expect(sayForAdmin(person.session, text)).resolves.toBe(200);
    await admin.api.members.remove(person.userId);

    const result = await erasedWithCacheDown(
      text,
      async () =>
        await admin.api.members.erase(person.userId, String(person.person.name))
    );

    expect(result).toStrictEqual(takenOutByTheAlarm);
  });

  it("stays queued when it is queued again while a take-out of it is under way", async () => {
    const text = lineOf();
    const taken = await interviewSaying(text);
    await expect(sayOnLink(taken.link, text)).resolves.toBe(200);
    const key = await storedKeyOf(text);
    const store = onboardingStore(env);

    // Inside the store: a take-out of the line deletes it from the cache
    // and is held before it answers; meanwhile the voice keeps the line
    // again, as a request under way does, and that request's own
    // take-out can't reach the cache.
    await runInDurableObject(store, async (instance) => {
      const files: R2Bucket = env.FILES;
      const remove = files.delete.bind(files);
      const deleted = Promise.withResolvers<boolean>();
      const answered = Promise.withResolvers<boolean>();
      let calls = 0;
      const cache = vi
        .spyOn(files, "delete")
        .mockImplementation(async (keys) => {
          calls += 1;
          if (calls === 1) {
            await remove(keys);
            deleted.resolve(true);
            await answered.promise;
            return;
          }
          throw new Error("The cache can't be reached.");
        });
      try {
        const first = instance.forgetSpoken([key]);
        await deleted.promise;
        await keepLine(
          env,
          {
            text,
            spoken: text,
            voice: platformAi.speech.voices.stephen,
            model: speechModelOf(),
            language: "en",
          },
          JSON.stringify({ audio: "AAAA", mime: "audio/mpeg", words: [] })
        );
        await instance.forgetSpoken([key]);
        answered.resolve(true);
        await first;
      } finally {
        cache.mockRestore();
      }
    });
    const stuck = await leftOf(text);
    const ran = await runDurableObjectAlarm(store);

    expect({ stuck, ran, after: await leftOf(text) }).toStrictEqual({
      stuck: { cached: true, noted: 1, waiting: 1 },
      ran: true,
      after: { cached: false, noted: 1, waiting: 0 },
    });
  });
});
