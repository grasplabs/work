import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewApproval,
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import { interviewStoryPath } from "@grasp-os/shared/interview-story";
import type { StorySentence } from "@grasp-os/shared/interview-story";
import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import {
  answering,
  approve,
  codeOf,
  countedFor,
  modelOf,
  onLink,
  opened,
  openedFor,
  participate,
  quick,
  revisionsOf,
} from "./interview-link.ts";
import type { ProviderReply } from "./model-provider.ts";
import { routed } from "./sign-in.ts";

// The read-back (src/onboarding/story.ts and the store's agreement): Stephen
// tells a part of what he wrote down back as a short story, the person puts
// lines right and agrees, and only what they agreed to reaches the drawing
// of their work. The model provider is the outside system, faked behind
// connect. The ways it can fail, tried here:
//
// - A story that says more than the lines, or other things: it is no story,
//   and the page reads the lines as they stand.
// - A link that isn't open, a device that isn't the link's, or someone who
//   didn't agree to take part (GRA-329, T1) getting one.
// - A fact counting before its person agreed to it, or one they added after
//   counting before they agreed to that too.
// - From the threat model of read-back approval (GRA-329): the page's own
//   `agreed` counting for anything (T2); an edit, or a fact taken out,
//   keeping its approval (T2); an approval sent twice, or its answer lost,
//   making two receipts or drawing again (T3, T7); an approval of a
//   revision no longer kept counting (T3, T8); and what was approved
//   counting after they withdraw (T5).

const lines = [
  { id: "f1", text: "You weigh the parcel." },
  { id: "f2", text: "You write the weight on the label." },
  { id: "f3", text: "You put the parcel on the belt." },
];

const told = (sentences: StorySentence[]): ProviderReply => ({
  text: JSON.stringify({ sentences }),
  inputTokens: 900,
  outputTokens: 60,
});

const tell = async (
  link: { secret: string; key: string },
  more: object = {}
): Promise<Response> =>
  await routed(interviewStoryPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...link, locale: "en", lines, ...more }),
  });

const fact = (
  id: string,
  record: string,
  more: Partial<InterviewFact> = {}
): InterviewFact => ({ id, tag: "step", text: record, record, ...more });

/** Where their interview is: talking, or agreed to (`completed`). */
const progressOf = (
  person: InterviewProgress["person"],
  facts: InterviewFact[]
): InterviewProgress => ({
  person,
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What did you do this morning?" },
    { from: "person", text: "I weighed the parcels.", typed: true },
  ],
  facts,
  phase: person === "completed" ? "readback" : "story",
  wants: person === "completed" ? "end" : "readback",
  startedAt: Date.now(),
  confirmed: facts.filter(({ agreed }) => agreed === true).length,
  adding: false,
  addedAt: 0,
});

const save = async (
  link: { secret: string; key: string },
  version: number,
  progress: InterviewProgress
): Promise<number> => {
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...link, version, progress }),
  });
  const saved: InterviewSaved = await response.json();
  if (!saved.saved) {
    throw new Error(`Not saved: version ${saved.version}`);
  }
  return saved.version;
};

/** What the drawing would get from `person` now: whether they're due, and which records. */
const drawingOf = async (person: string) => {
  const store = onboardingStore(env);
  const input = await store.drawInput(person);
  const due = await store.drawsDue();
  return {
    due: due.includes(person),
    records: input?.facts.map(({ record }) => record) ?? [],
  };
};

describe(
  "a part of the read-back, told as a story",
  { timeout: 60_000 },
  () => {
    it("tells the lines back in his sentences, from the quick model, and counts it", async () => {
      const link = await opened();
      const before = await countedFor(quick);
      const sentences = [
        {
          say: "You weigh the parcel and write its weight on the label.",
          ids: ["f1", "f2"],
        },
        { say: "Then it goes on the belt.", ids: ["f3"] },
      ];
      const { requests, result } = await answering(
        [told(sentences)],
        async () => await tell(link)
      );
      const after = await countedFor(quick);
      expect({
        status: result.status,
        body: await result.json(),
        models: requests.map(modelOf),
        system: JSON.stringify(requests[0]?.body).includes(
          "Telling back what you wrote down"
        ),
        counted: after.calls - before.calls,
      }).toStrictEqual({
        status: 200,
        body: { sentences },
        models: ["claude-sonnet-4-5"],
        system: true,
        counted: 1,
      });
    });

    it("is no story when it says more than the lines: the page reads them as they stand", async () => {
      const link = await opened();
      const { result } = await answering(
        [
          told([
            {
              say: "You weigh the parcel on the grey scale by the door, which takes a while, and you take your time for it because it matters to everyone.",
              ids: ["f1", "f2", "f3"],
            },
          ]),
        ],
        async () => await tell(link)
      );
      expect(result.status).toBe(502);
    });

    it("is refused to a link that isn't open, another device, and a page naming someone, with nothing sent", async () => {
      const link = await opened();
      const { requests, result } = await answering([], async () => [
        await codeOf(await tell({ ...link, secret: "x".repeat(43) })),
        await codeOf(await tell({ ...link, key: "y".repeat(43) })),
        await codeOf(await tell(link, { name: "Someone else" })),
      ]);
      expect({ result, sent: requests.length }).toStrictEqual({
        result: [
          [404, "interview.link_invalid"],
          [403, "interview.elsewhere"],
          [400, "interview.invalid"],
        ],
        sent: 0,
      });
    });

    it("is refused to someone who didn't agree to take part, or withdrew, with nothing sent", async () => {
      const { link } = await openedFor({ participating: false });
      const { requests, result } = await answering([], async () => {
        const before = await codeOf(await tell(link));
        await participate(link);
        await onLink({ action: "withdraw", ...link });
        return [before, await codeOf(await tell(link))];
      });
      expect({ result, sent: requests.length }).toStrictEqual({
        result: [
          [403, "interview.not_participating"],
          [410, "interview.withdrawn"],
        ],
        sent: 0,
      });
    });
  }
);

describe("what counts of an interview", { timeout: 60_000 }, () => {
  it("is what its person agreed to: a line put right, and what they add later once they agree to it too", async () => {
    const { link, person } = await openedFor();
    const store = onboardingStore(env);
    const weigh = fact("f1", "Weigh the parcel.");
    const label = fact("f2", "Write the weight on the label.");

    // Written down, and being read back: nothing counts yet.
    let version = await save(link, 0, progressOf("progress", [weigh, label]));
    const reading = await drawingOf(person);

    // They change a line on screen: it reaches Stephen as if they had typed
    // it, and what he writes down follows.
    const { result: changing } = await answering(
      [
        {
          text: "TONE: none\nSAY: Changed.\nPART: readback\nWANTS: readback\nMORE: no\nAGREED: no\n",
          inputTokens: 1500,
          outputTokens: 20,
        },
        {
          text: JSON.stringify({
            facts: [],
            changes: [
              {
                id: "f2",
                text: "You write the weight on the parcel.",
                record: "Write the weight on the parcel.",
              },
            ],
          }),
          inputTokens: 1600,
          outputTokens: 60,
        },
      ],
      async () => {
        const response = await routed(interviewTurnPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...link,
            event: "readback",
            locale: "en",
            lines: [
              {
                from: "person",
                text: "Change “Write the weight on the label.” to “Write the weight on the parcel.”",
                typed: true,
              },
            ],
            facts: [weigh, label].map(({ id, tag, text }) => ({
              id,
              tag,
              text,
            })),
            phase: "readback",
            minutes: 12,
            reading: ["f1", "f2"],
          }),
        });
        return turnEvents(`${await response.text()}\n`).events.flatMap(
          (event) => ("turn" in event ? event.turn.changes : [])
        );
      }
    );
    const changed = fact("f2", "Write the weight on the parcel.");

    // They agree: the interview is completed, and what they approved, as
    // it stands, is drawn.
    version = await save(
      link,
      version,
      progressOf("completed", [
        { ...weigh, agreed: true },
        { ...changed, agreed: true },
      ])
    );
    await approve(link, [weigh, changed]);
    const agreed = await drawingOf(person);
    const first = await store.drawInput(person);
    await store.drawn(person, first?.generation ?? "");
    const drawn = await drawingOf(person);

    // Back to add something: until they agree to it, it doesn't count.
    const belt = fact("f3", "Put the parcel on the belt.");
    const kept = [
      { ...weigh, agreed: true as const },
      { ...changed, agreed: true as const },
    ];
    version = await save(link, version, {
      ...progressOf("completed", [...kept, belt]),
      adding: true,
    });
    const adding = await drawingOf(person);
    await save(
      link,
      version,
      progressOf("completed", [...kept, { ...belt, agreed: true }])
    );
    await approve(link, [weigh, changed, belt]);
    const added = await drawingOf(person);

    expect({ reading, changing, agreed, drawn, adding, added }).toStrictEqual({
      reading: { due: false, records: [] },
      changing: [
        {
          id: "f2",
          text: "You write the weight on the parcel.",
          record: "Write the weight on the parcel.",
        },
      ],
      agreed: {
        due: true,
        records: ["Weigh the parcel.", "Write the weight on the parcel."],
      },
      drawn: {
        due: false,
        records: ["Weigh the parcel.", "Write the weight on the parcel."],
      },
      adding: {
        due: false,
        records: ["Weigh the parcel.", "Write the weight on the parcel."],
      },
      added: {
        due: true,
        records: [
          "Weigh the parcel.",
          "Write the weight on the parcel.",
          "Put the parcel on the belt.",
        ],
      },
    });
  });

  it("is nothing once they delete their interview", async () => {
    const { link, person } = await openedFor();
    const weigh = fact("f1", "Weigh the parcel.", { agreed: true });
    await save(link, 0, progressOf("completed", [weigh]));
    await approve(link, [weigh]);
    const before = await drawingOf(person);
    await routed(interviewApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", ...link }),
    });
    expect({ before, after: await drawingOf(person) }).toStrictEqual({
      before: { due: true, records: ["Weigh the parcel."] },
      after: { due: false, records: [] },
    });
  });

  it("is never what the page says it agreed to: only what they approved, at the revision it stands at", async () => {
    const { link, person } = await openedFor();
    const weigh = fact("f1", "Weigh the parcel.");
    const label = fact("f2", "Write the weight on the label.");

    // The page says both are agreed to, without approving: nothing counts,
    // and reading it back says so.
    let version = await save(
      link,
      0,
      progressOf("completed", [
        { ...weigh, agreed: true },
        { ...label, agreed: true },
      ])
    );
    const flagged = await drawingOf(person);
    const shown = async () => {
      const session = await onLink({ action: "session", ...link });
      const { progress }: InterviewSession = await session.json();
      return progress?.facts.map(({ id, agreed }) => [id, agreed ?? false]);
    };
    const flaggedShown = await shown();

    // They approve both, as they stand.
    await approve(link, [weigh, label]);
    const approved = await drawingOf(person);
    const approvedShown = await shown();

    // A line changed after, still marked agreed by the page: it counts no
    // more, until they approve it as it is now.
    const changed = fact("f2", "Write the weight on the parcel.");
    version = await save(
      link,
      version,
      progressOf("completed", [
        { ...weigh, agreed: true },
        { ...changed, agreed: true },
      ])
    );
    const edited = await drawingOf(person);
    const editedShown = await shown();
    await approve(link, [weigh, changed]);
    const reapproved = await drawingOf(person);

    // A line taken out counts no more either.
    await save(
      link,
      version,
      progressOf("completed", [
        { ...weigh, agreed: true },
        { ...changed, agreed: true, out: true },
      ])
    );
    const takenOut = await drawingOf(person);

    expect({
      flagged,
      flaggedShown,
      approved,
      approvedShown,
      edited,
      editedShown,
      reapproved,
      takenOut,
    }).toStrictEqual({
      flagged: { due: false, records: [] },
      flaggedShown: [
        ["f1", false],
        ["f2", false],
      ],
      approved: {
        due: true,
        records: ["Weigh the parcel.", "Write the weight on the label."],
      },
      approvedShown: [
        ["f1", true],
        ["f2", true],
      ],
      edited: { due: true, records: ["Weigh the parcel."] },
      editedShown: [
        ["f1", true],
        ["f2", false],
      ],
      reapproved: {
        due: true,
        records: ["Weigh the parcel.", "Write the weight on the parcel."],
      },
      takenOut: { due: true, records: ["Weigh the parcel."] },
    });
  });

  it("answers one receipt however often the same approval comes, and draws nothing again for it", async () => {
    const { link, person } = await openedFor();
    const store = onboardingStore(env);
    const weigh = fact("f1", "Weigh the parcel.");
    await save(link, 0, progressOf("completed", [weigh]));

    const first = await approve(link, [weigh]);
    const firstBody: InterviewApproval = await first.json();
    const input = await store.drawInput(person);
    await store.drawn(person, input?.generation ?? "");
    // The answer was lost: the page asks again, the same.
    const again = await approve(link, [weigh]);
    const againBody: InterviewApproval = await again.json();

    expect({
      first: first.status,
      again: again.status,
      same: JSON.stringify(againBody) === JSON.stringify(firstBody),
      receipt: firstBody.approved
        ? /^rb-[0-9a-f]{32}$/u.test(firstBody.receipt)
        : false,
      drawing: await drawingOf(person),
    }).toStrictEqual({
      first: 200,
      again: 200,
      same: true,
      receipt: true,
      drawing: { due: false, records: ["Weigh the parcel."] },
    });
  });

  it("refuses an approval of what isn't kept, or of nothing that was written down, answering the copy kept", async () => {
    const { link, person } = await openedFor();
    const label = fact("f2", "Write the weight on the label.");
    const changed = fact("f2", "Write the weight on the parcel.");
    const version = await save(link, 0, progressOf("completed", [label]));
    // Another tab saved the change meanwhile; this one approves what it read.
    await save(link, version, progressOf("completed", [changed]));

    const stale = await approve(link, [label]);
    const staleBody: InterviewApproval = await stale.json();
    const unknown = await onLink({
      action: "approve",
      ...link,
      facts: await revisionsOf([fact("f9", "Never written down.")]),
    });

    expect({
      stale: stale.status,
      kept: staleBody.approved
        ? null
        : staleBody.progress?.facts.map(({ record, agreed }) => [
            record,
            agreed ?? false,
          ]),
      unknown: unknown.status,
      drawing: await drawingOf(person),
    }).toStrictEqual({
      stale: 409,
      kept: [["Write the weight on the parcel.", false]],
      unknown: 409,
      drawing: { due: false, records: [] },
    });
  });

  it("is nothing once they withdraw, and they approve nothing more", async () => {
    const { link, person } = await openedFor();
    const weigh = fact("f1", "Weigh the parcel.");
    await save(link, 0, progressOf("completed", [weigh]));
    await approve(link, [weigh]);
    const before = await drawingOf(person);

    const withdrawn = await onLink({ action: "withdraw", ...link });
    const again = await onLink({ action: "withdraw", ...link });
    const [first, second] = [await withdrawn.json(), await again.json()];

    expect({
      before,
      withdrawn: withdrawn.status,
      same: JSON.stringify(first) === JSON.stringify(second),
      after: await drawingOf(person),
      approve: await codeOf(await approve(link, [weigh])),
    }).toStrictEqual({
      before: { due: true, records: ["Weigh the parcel."] },
      withdrawn: 200,
      same: true,
      after: { due: false, records: [] },
      approve: [410, "interview.withdrawn"],
    });
  });
});
