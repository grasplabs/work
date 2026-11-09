import { describe, expect, it } from "vite-plus/test";

import { channelText } from "../src/channels/stephen-rules.ts";
import { peopleMatters } from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
import {
  colleaguesInHrNotes,
  companyOnce,
  doorClockRunsAhead,
  later,
  leaksIn,
  postedTo,
  probeTime,
  secretsOf,
  sentCount,
  sentSince,
} from "./permission-probing.ts";
import { messageFrom, post, watched } from "./teams-door.ts";

// Who may see what (GRA-731), in the permission probes' company
// (permission-probing.ts): people matters (sickness, harassment, a
// conflict) go to a person. The rule is in what the model is told in a
// chat app, and what HR keeps about a colleague never reaches it. Whether
// a real model follows the rule is the eval's (GRA-739), not a stub's.
// The members' probes and their controls are in the other
// permission-probes-*.test.ts files.

const idp = mockIdp();

watched();

const setUp = companyOnce(idp);

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
