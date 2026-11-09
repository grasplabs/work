import { describe, expect, it } from "vite-plus/test";

import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import {
  permissionProbes,
  unreadableTo,
} from "./fixtures/permission-probes.ts";
import type { ProbeTarget } from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
import {
  askedInWorkspace,
  askedThroughDoor,
  companyOnce,
  doorClockRunsAhead,
  memberProbes,
  outsiderProbes,
  probeTime,
  probesOf,
  secretsOf,
  sentSince,
} from "./permission-probing.ts";
import type { ProbeOutcome } from "./permission-probing.ts";
import { watched } from "./teams-door.ts";

// Who may see what (GRA-731): the 150 permission probes
// (fixtures/permission-probes.ts) in the Brain baseline's company, each
// asked as one person about what another may see, through `Workspace.ask`
// and once more through the Teams door, as the Brain baseline's security
// gate checks a trial: nothing its asker may not read reaches a model or
// the answer. The model is a stand-in that tries every read it can
// (permission-probing.ts), so a probe passes on the platform's permissions
// alone. The probes are split over files that can run apart: the
// members' probes by channel, asker and tactic
// (permission-probes-{ask,teams}-{ana,bram}-{plain,pretext}.test.ts),
// people matters in permission-probes-people.test.ts.
// Here: the probes are what the gate asks, and the files share the
// members' between them. Controls show the same reads do reach what the
// asker may read. Someone removed and a guest get one line, and nothing is
// read.

const idp = mockIdp();

watched();

const setUp = companyOnce(idp);

describe("the permission probes", probeTime, () => {
  doorClockRunsAhead();

  it("are 150, guests and removed people among them, each asking as one person about what another may see", () => {
    expect({
      probes: permissionProbes.length,
      unique: new Set(permissionProbes.map(({ id }) => id)).size,
      askers: [...new Set(permissionProbes.map(({ asker }) => asker))],
      // Every probe's target is one its asker may not see.
      foreign: permissionProbes.every(
        ({ asker, target }) =>
          asker === "removed" ||
          asker === "guest" ||
          unreadableTo[asker].includes(target)
      ),
    }).toStrictEqual({
      probes: 150,
      unique: 150,
      askers: ["ana", "bram", "removed", "guest"],
      foreign: true,
    });
  });

  it("are the members' 120 between the files that ask them, each in one", () => {
    const shared = (["ana", "bram"] as const).flatMap((asker) =>
      (["ask", "pretext"] as const).map((tactic) => probesOf(asker, tactic))
    );
    expect({
      members: memberProbes.length,
      files: shared.map((probes) => probes.length),
      asked: new Set(shared.flat().map(({ id }) => id)).size,
    }).toStrictEqual({ members: 120, files: [25, 25, 35, 35], asked: 120 });
  });

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
