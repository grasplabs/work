import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { keepOnboardingRecords } from "../src/brain-records.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Taking a source, or some things that were said, out of the brain on an
// admin's word (`brain.forgetPreview`, `brain.forget`, core's
// brain-forget.ts). What can go wrong, tried here: someone who isn't an
// admin taking things out, or seeing what would go; a preview that says
// less (or more) than forget takes; words left behind in the stored
// record or in what the brain serves; a removed statement or source
// coming back when it is sent again, or something new resting on it; the
// audit trail keeping what was said; a second call taking or recording
// anything; a source or statement the brain doesn't hold.

const idp = mockIdp();

/** What one source said, under ids no other test uses. */
const said = (tag: string) => {
  const ids = {
    source: `src-${tag}`,
    other: `src-${tag}-other`,
    tool: `tool-${tag}`,
    blocker: `st-${tag}-1`,
    followUp: `st-${tag}-2`,
    elsewhere: `st-${tag}-3`,
    gap: `gap-${tag}`,
  };
  const words = {
    title: `Finance interview ${tag}`,
    blocker: `Invoices are typed over by hand ${tag}.`,
    followUp: `Typing invoices over still takes a day ${tag}.`,
    elsewhere: `Month end closes late ${tag}.`,
  };
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: ids.source,
      kind: "interview",
      title: words.title,
      date: "2026-10-20",
      who: "Head of finance",
      how: "Live, 45 minutes",
    },
    {
      type: "source",
      id: ids.other,
      kind: "document",
      title: "Close checklist",
      date: "2026-10-21",
    },
    {
      type: "tool",
      id: ids.tool,
      name: "Exact Online",
      sourceId: ids.source,
    },
    {
      type: "statement",
      id: ids.blocker,
      kind: "blocker",
      text: words.blocker,
      sourceId: ids.source,
      toolIds: [ids.tool],
      pain: "high",
    },
    {
      type: "statement",
      id: ids.elsewhere,
      kind: "blocker",
      text: words.elsewhere,
      sourceId: ids.other,
    },
    {
      type: "statement",
      id: ids.followUp,
      kind: "blocker",
      text: words.followUp,
      sourceId: ids.other,
      followsUp: ids.blocker,
    },
    {
      type: "gap",
      id: ids.gap,
      question: "Who checks the typed invoices?",
      owner: "Controller",
      sourceId: ids.other,
      about: [ids.blocker, ids.elsewhere],
    },
  ];
  return { ids, words, records };
};

/** Every stored body of the brain's records, as one text. */
const storedText = async (): Promise<string> => {
  const { results } = await env.DB.prepare(
    "SELECT body FROM brain_records"
  ).all<{ body: string }>();
  return results.map(({ body }) => body).join("\n");
};

describe("taking things out of the brain", { timeout: 120_000 }, () => {
  it("takes a source with what was said in it, as its preview said, leaving no words", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { ids, words, records } = said(unique());
    await admin.api.brain.addRecords(records);
    // The onboarding draws a workflow whose numbers rest on the source.
    const workflow = `wf-${ids.source}`;
    await keepOnboardingRecords(
      env,
      [
        {
          type: "team",
          id: `team-${ids.source}`,
          name: `Finance ${ids.source}`,
          sourceId: ids.other,
        },
        {
          type: "workflow",
          id: workflow,
          name: "Invoice entry",
          teamId: `team-${ids.source}`,
          sourceId: ids.source,
          status: "drawn",
        },
      ],
      { sources: new Set(), teams: new Set() }
    );
    const before = await member.api.brain.read();

    const preview = await admin.api.brain.forgetPreview({ source: ids.source });
    let forgotten: unknown;
    const events = await auditedDuring(async () => {
      forgotten = await admin.api.brain.forget({ source: ids.source });
    });
    const after = await member.api.brain.read();
    const stored = await storedText();
    const gone = (id: string) =>
      before.statements.some((each) => each.id === id) &&
      !after.statements.some((each) => each.id === id);

    expect({
      preview,
      forgotten,
      // What the preview named is what went, and nothing else.
      wentAsPreviewed: before.statements
        .filter(({ id }) => gone(id))
        .map(({ id }) => id)
        .toSorted(),
      source: after.sources.find(({ id }) => id === ids.source),
      // The workflow keeps its number, which still names the source.
      workflow: after.workflows.find(({ id }) => id === workflow)?.id,
      // What said it after stands on its own; the gap is no longer about it.
      followUp: after.statements.find(({ id }) => id === ids.followUp)
        ?.followsUp,
      gapAbout: after.gaps.find(({ id }) => id === ids.gap)?.about,
      wordsLeft: [words.title, words.blocker, "Head of finance"].filter(
        (text) => JSON.stringify(after).includes(text) || stored.includes(text)
      ),
      events: events.map(({ action, actor, target }) => ({
        action,
        actor: actor.type,
        target,
      })),
      eventsHoldWords: JSON.stringify(events).includes(words.blocker),
    }).toStrictEqual({
      preview: {
        source: ids.source,
        statements: [ids.blocker],
        workflows: [workflow],
      },
      forgotten: preview,
      wentAsPreviewed: [ids.blocker],
      source: {
        id: ids.source,
        kind: "interview",
        title: "",
        date: "2026-10-20",
        removedAt: new Date().toISOString().slice(0, 10),
      },
      workflow,
      followUp: undefined,
      gapAbout: [ids.elsewhere],
      // The gap's question stays: it is the other source's.
      wordsLeft: [],
      events: [
        {
          action: "brain.records.forgotten",
          actor: "person",
          target: { type: "brain_record", id: `statement:${ids.blocker}` },
        },
        {
          action: "brain.records.forgotten",
          actor: "person",
          target: { type: "brain_record", id: `source:${ids.source}` },
        },
      ],
      eventsHoldWords: false,
    });
  });

  it("takes statements alone, keeping their source", async () => {
    const admin = await signedInApi(idp, "admin");
    const { ids, records } = said(unique());
    await admin.api.brain.addRecords(records);

    const preview = await admin.api.brain.forgetPreview({
      statements: [ids.elsewhere, ids.followUp],
    });
    await admin.api.brain.forget({ statements: [ids.elsewhere, ids.followUp] });
    const after = await admin.api.brain.read();

    expect({
      preview,
      left: after.statements
        .filter(({ sourceId }) => [ids.source, ids.other].includes(sourceId))
        .map(({ id }) => id),
      other: after.sources.find(({ id }) => id === ids.other)?.title,
    }).toStrictEqual({
      preview: {
        source: null,
        statements: [ids.followUp, ids.elsewhere].toSorted(),
        workflows: [],
      },
      left: [ids.blocker],
      other: "Close checklist",
    });
  });

  it("takes nothing the second time, records nothing, and never lets it come back", async () => {
    const admin = await signedInApi(idp, "admin");
    const { ids, records } = said(unique());
    await admin.api.brain.addRecords(records);
    await admin.api.brain.forget({ source: ids.source });

    let again: unknown;
    const events = await auditedDuring(async () => {
      again = await admin.api.brain.forget({ source: ids.source });
    });
    // Sent again exactly as it was (a retry, or the onboarding giving it
    // again): left as removed.
    const resent = await admin.api.brain.addRecords(records);
    // Something new resting on what is gone is refused.
    const onGone = await outcome(
      admin.api.brain.addRecords([
        {
          type: "statement",
          id: `${ids.blocker}-new`,
          kind: "wish",
          text: "Something new.",
          sourceId: ids.source,
        },
      ])
    );
    const following = await outcome(
      admin.api.brain.addRecords([
        {
          type: "statement",
          id: `${ids.blocker}-next`,
          kind: "wish",
          text: "Something new.",
          sourceId: ids.other,
          followsUp: ids.blocker,
        },
      ])
    );
    const after = await admin.api.brain.read();

    expect({
      again,
      events: events.length,
      resent,
      onGone,
      following,
      blocker: after.statements.some(({ id }) => id === ids.blocker),
      title: after.sources.find(({ id }) => id === ids.source)?.title,
    }).toStrictEqual({
      again: { source: null, statements: [], workflows: [] },
      events: 0,
      resent: { added: 0, unchanged: records.length },
      onGone: "brain.record_missing",
      following: "brain.record_missing",
      blocker: false,
      title: "",
    });
  });

  it("is refused to anyone but an admin, and for what the brain doesn't hold", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const { ids, records } = said(unique());
    await admin.api.brain.addRecords(records);
    // A source and statements at once: neither of the two shapes.
    const malformed = { source: ids.source, statements: [] };

    const outcomes = {
      memberPreview: await outcome(
        member.api.brain.forgetPreview({ source: ids.source })
      ),
      member: await outcome(member.api.brain.forget({ source: ids.source })),
      builder: await outcome(
        builder.api.brain.forget({ statements: [ids.blocker] })
      ),
      unknownSource: await outcome(
        admin.api.brain.forget({ source: `${ids.source}-none` })
      ),
      // The onboarding's sources leave the brain their own way.
      onboardingSource: await outcome(
        admin.api.brain.forget({ source: "src-roster" })
      ),
      // A tool isn't a statement.
      notAStatement: await outcome(
        admin.api.brain.forget({ statements: [ids.tool] })
      ),
      malformed: await outcome(admin.api.brain.forget(malformed)),
    };
    const after = await admin.api.brain.read();

    expect({
      outcomes,
      kept: after.statements.filter(({ sourceId }) => sourceId === ids.source)
        .length,
    }).toStrictEqual({
      outcomes: {
        memberPreview: "role.forbidden",
        member: "role.forbidden",
        builder: "role.forbidden",
        unknownSource: "brain.forget_missing",
        onboardingSource: "brain.forget_missing",
        notAStatement: "brain.forget_missing",
        malformed: "brain.invalid",
      },
      kept: 1,
    });
  });
});
