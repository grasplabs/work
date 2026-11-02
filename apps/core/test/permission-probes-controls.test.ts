import { describe, expect, it } from "vite-plus/test";

import { channelText } from "../src/channels/stephen-rules.ts";
import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import { peopleMatters } from "./fixtures/permission-probes.ts";
import type { ProbeTarget } from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
import {
  askedInWorkspace,
  askedThroughDoor,
  colleaguesInHrNotes,
  companyOnce,
  doorClockRunsAhead,
  later,
  leaksIn,
  outsiderProbes,
  postedTo,
  probeTime,
  secretsOf,
  sentCount,
  sentSince,
} from "./permission-probing.ts";
import type { ProbeOutcome } from "./permission-probing.ts";
import { messageFrom, post, watched } from "./teams-door.ts";

// Who may see what (GRA-731): the 150 permission probes
// (fixtures/permission-probes.ts) in the Brain baseline's company, each
// asked as one person about what another may see, through `Workspace.ask`
// and once more through the Teams door, as the Brain baseline's security
// gate checks a trial: nothing its asker may not read reaches a model or
// the answer. The model is a stand-in that tries every read it can
// (permission-probing.ts), so a probe passes on the platform's permissions
// alone. The probes are split over files that can run apart:
// permission-probes-ask.test.ts asks the members' probes through
// `Workspace.ask`, permission-probes-teams.test.ts through the Teams door,
// and permission-probes-controls.test.ts has the controls, the outsiders
// and people matters.
// Here: controls show the same reads do reach what the asker may read.
// Someone removed and a guest get one line, and nothing is read. People
// matters (sickness, harassment, a conflict) go to a person: the rule is in
// what the model is told in a chat app, and what HR keeps about a colleague
// never reaches it. Whether a real model follows the rule is the eval's
// (GRA-739), not a stub's.

const idp = mockIdp();

watched();

const setUp = companyOnce(idp);

describe("the permission probes", probeTime, () => {
  doorClockRunsAhead();

  it("reach what their asker may read: the same reads would catch a leak", async () => {
    const place = await setUp();
    // Each target, asked by someone who may read it.
    const readers: [BrainPersona, ProbeTarget][] = [
      ["ana", "routePlans"],
      ["ana", "planningOfficeDays"],
      ["ana", "roster"],
      ["ana", "hubs"],
      ["bram", "budget"],
      ["bram", "tolls"],
      ["ana", "memory:ana"],
      ["bram", "memory:bram"],
    ];
    const reachedSecrets: string[] = [];
    for (const [asker, target] of readers) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      const probed = await askedInWorkspace(
        {
          id: `control-${asker}-${target}`,
          asker,
          target,
          language: "en",
          tactic: "ask",
          question: "Tell me everything.",
        },
        place
      );
      const sent = sentSince(place.model.provider.requests, 0);
      reachedSecrets.push(
        ...(secretsOf(target).every((secret) => sent.includes(secret))
          ? [target]
          : [`${target} not reached`])
      );
      expect(probed.leaked).toStrictEqual([]);
    }
    expect(reachedSecrets).toStrictEqual(readers.map(([, target]) => target));
  });

  it("refuse someone removed in Workspace.ask, and give them and a guest one line through the door, with nothing read", async () => {
    const place = await setUp();
    const inWorkspace: ProbeOutcome[] = [];
    for (const probe of outsiderProbes.filter(
      ({ asker }) => asker === "removed"
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      inWorkspace.push(await askedInWorkspace(probe, place));
    }
    const throughDoor: ProbeOutcome[] = [];
    for (const probe of outsiderProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      throughDoor.push(await askedThroughDoor(probe, place));
    }
    expect({
      inWorkspace: inWorkspace.map(({ read, refusedWith }) => ({
        read,
        refusedWith,
      })),
      throughDoor: throughDoor.map(({ read, refusedWith }) => ({
        read,
        refusedWith,
      })),
    }).toStrictEqual({
      inWorkspace: inWorkspace.map(() => ({
        read: false,
        refusedWith: "permission.person_inactive",
      })),
      throughDoor: throughDoor.map(() => ({
        read: false,
        refusedWith: "1 line",
      })),
    });
  });
});

describe("people matters", probeTime, () => {
  doorClockRunsAhead();

  it("go to a person: the rule is what Stephen is told on Teams, in every language, and no colleague HR keeps notes about reaches a model or the answer", async () => {
    const place = await setUp();
    const { text: rule } = await channelText();
    const outcomes: { id: string; told: boolean; leaked: string[] }[] = [];
    for (const matter of peopleMatters) {
      for (const asker of ["ana", "bram"] as const) {
        place.model.probing({
          queries: [matter.question, "sick leave", "complaint"],
          ids: [place.brain.documents.get("sickNotes")?.id ?? ""],
        });
        const from = place.model.provider.requests.length;
        const person = place.teams[asker];
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        const before = await sentCount(person);
        later();
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        await post(
          messageFrom(person, {
            text: matter.question,
            locale: matter.language,
          })
        );
        const sent = sentSince(place.model.provider.requests, from);
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        const posted = await postedTo(person, before);
        outcomes.push({
          id: `${asker}-${matter.id}`,
          told: sent.includes(rule) && sent.includes("always goes to a person"),
          leaked: leaksIn(`${sent}\n${posted}`, [
            ...colleaguesInHrNotes,
            ...secretsOf("sickNotes"),
          ]),
        });
      }
    }
    expect(
      outcomes.filter(({ told, leaked }) => !told || leaked.length > 0)
    ).toStrictEqual([]);
    expect(outcomes).toHaveLength(30);
  });
});
