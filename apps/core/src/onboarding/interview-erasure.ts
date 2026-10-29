import type { OnErase } from "@grasp-os/brain/purge";
import { auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { interviewLimits } from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";

import { onboardingStore } from "./store.ts";

// The interviews as a Knowledge purge reaches them (GRA-528): what people
// said, and what Stephen said to them, may quote what a purge takes out
// (the kickoff's words, Stephen's context, say). A purge is the admin's
// hard delete, so a content purge rewrites their words as it rewrites
// the brain's records: each line, each mark in it, each file's name and
// each fact, as read back and as the record keeps it. Nothing else of an
// interview is words (ids, tags, states), so nothing else is touched.
// Each one rewritten is audited without its words or whose it was. What
// was drawn from them goes too: a drawing holding a purged word is
// forgotten, to be drawn again from what the purge left, and a piece of
// work's names are rewritten.

/** `text` rewritten, no longer than `max`. */
const within = (
  text: string,
  rewrite: (text: string) => string,
  max: number
): string => rewrite(text).slice(0, max);

/** `progress` with its words rewritten. */
const rewritten = (
  progress: InterviewProgress,
  rewrite: (text: string) => string
): InterviewProgress => ({
  ...progress,
  lines: progress.lines.map((line) => ({
    ...line,
    text: within(line.text, rewrite, interviewLimits.line),
    ...(line.file === undefined
      ? {}
      : { file: within(line.file, rewrite, interviewLimits.file) }),
    ...(line.marks === undefined
      ? {}
      : {
          marks: line.marks.map((mark) => ({
            ...mark,
            quote: within(mark.quote, rewrite, interviewLimits.fact),
          })),
        }),
  })),
  facts: progress.facts.map((fact) => ({
    ...fact,
    text: within(fact.text, rewrite, interviewLimits.fact),
    record: within(fact.record, rewrite, interviewLimits.fact),
  })),
});

/** Every word of `progress` a purge looks in. */
const wordsOf = (progress: InterviewProgress): string[] => [
  ...progress.lines.flatMap((line) => [
    line.text,
    ...(line.file === undefined ? [] : [line.file]),
    ...(line.marks ?? []).map(({ quote }) => quote),
  ]),
  ...progress.facts.flatMap(({ text, record }) => [text, record]),
];

/** How often a purge reads an interview again that was saved as it rewrote it. */
const rewriteAttempts = 5;

/**
 * Rewrites `person`'s interview, read as `progress`: kept only if it is
 * still as read (`rewriteInterview`). One saved meanwhile is read again and
 * rewritten as it is then, a few times; if it still won't land, the purge
 * fails here, so it is run again, and never reports done with the words
 * left.
 */
const rewriteOne = async (
  store: ReturnType<typeof onboardingStore>,
  person: string,
  read: InterviewProgress,
  rewrite: (text: string) => string,
  actor: AuditActor
): Promise<void> => {
  let progress: InterviewProgress | null = read;
  for (let attempt = 0; attempt < rewriteAttempts; attempt += 1) {
    if (
      progress === null ||
      !wordsOf(progress).some((text) => rewrite(text) !== text)
    ) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- read again only when it lost
    const landed = await store.rewriteInterview(
      person,
      progress,
      rewritten(progress, rewrite),
      actor
    );
    if (landed) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- read again only when it lost
    progress = await store.interviewSaid(person);
  }
  throw new Error("An interview kept changing while the purge rewrote it");
};

/**
 * The interviews' words as a content purge reaches them: run before the
 * brain's records are rewritten, so an intake after it reads the words as
 * the purge left them (the store's brain lock keeps one from landing
 * between). They name no one by their words: a personal purge has no one
 * to forget here.
 */
export const interviewErasure = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
): Pick<OnErase, "count" | "rewrite" | "forgetActor"> => {
  const store = onboardingStore(env);
  return {
    count: async (holds) => {
      const said = await store.interviewsSaid();
      return said.filter(({ progress }) => wordsOf(progress).some(holds))
        .length;
    },
    rewrite: async (by, rewrite) => {
      const said = await store.interviewsSaid();
      const actor = auditActorSchema.parse(by.actor);
      for (const { person, progress } of said) {
        // oxlint-disable-next-line no-await-in-loop -- one interview after another
        await rewriteOne(store, person, progress, rewrite, actor);
      }
    },
    forgetActor: async () => {
      // An interview's words name no one by an id.
    },
  };
};

/**
 * What was drawn from the interviews, as a content purge reaches it: a
 * drawing holding a purged word is forgotten, to be drawn again from the
 * words as the purge left them, and a piece of work's names and what a
 * team does (drawn from its lead's interview) are rewritten. Run right
 * after the interviews, before the brain's records (knowledge/rpc.ts). A
 * drawing under way as the purge ran keeps nothing (the store's
 * `purgeMark`).
 */
export const drawingErasure = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
): Pick<OnErase, "count" | "rewrite" | "forgetActor"> => {
  const store = onboardingStore(env);
  return {
    count: async (holds) => {
      const { drawings, teams, works } = await store.drawingsSaid();
      return (
        drawings.filter(({ drawn }) => holds(drawn)).length +
        teams.filter(({ does }) => holds(does)).length +
        works.filter(({ name, local, one, many }) =>
          [name, local, one, many].some(holds)
        ).length
      );
    },
    rewrite: async (by, rewrite) => {
      const { drawings, teams, works } = await store.drawingsSaid();
      const changes = (text: string) => rewrite(text) !== text;
      await store.forgetDrawings(
        drawings.filter(({ drawn }) => changes(drawn)),
        works.flatMap(({ id, ...from }) =>
          Object.values(from).some(changes)
            ? [
                {
                  id,
                  from,
                  to: {
                    name: rewrite(from.name),
                    local: rewrite(from.local),
                    one: rewrite(from.one),
                    many: rewrite(from.many),
                  },
                },
              ]
            : []
        ),
        teams.flatMap(({ id, does }) =>
          changes(does) ? [{ id, from: does, to: rewrite(does) }] : []
        ),
        auditActorSchema.parse(by.actor)
      );
    },
    forgetActor: async () => {
      // A drawing names people by their roles, never by an id of theirs.
    },
  };
};
