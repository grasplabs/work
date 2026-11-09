import { describe, expect, it } from "vite-plus/test";

import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import {
  peopleMatters,
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
  peopleFile,
  probeFile,
  probeTime,
  probesIn,
  secretsOf,
  sentSince,
} from "./permission-probing.ts";
import type { ProbeFile, ProbeOutcome } from "./permission-probing.ts";
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
// (permission-probes-{ask,teams}-{ana,bram}-{plain,pretext}.test.ts, the
// Teams door's Bram asking plainly in two parts), people matters a file a
// matter (permission-probes-people-*.test.ts), each file's name saying
// what it asks (permission-probing.ts).
// Here: the probes are what the gate asks, and the files there are, read
// by their names, share the members' between them: a file deleted or
// renamed leaves probes unasked, and this fails. Controls show the same
// reads do reach what the asker may read. Someone removed and a guest get
// one line, and nothing is read.

const idp = mockIdp();

watched();

const setUp = companyOnce(idp);

// The files themselves, by name: Vite lists them without loading them.
const probeFiles = Object.keys(
  import.meta.glob("./permission-probes-{ask,teams}-*.test.ts")
).map((file) => probeFile(file));
const peopleFiles = Object.keys(
  import.meta.glob("./permission-probes-people-*.test.ts")
).map((file) => peopleFile(file));

/** The probes each of `channel`'s files asks. */
const shared = (channel: ProbeFile["channel"]) =>
  probeFiles
    .filter((file) => file.channel === channel)
    .map(({ asker, tactic, part }) => probesIn(asker, tactic, part));

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
    const workspace = shared("workspace");
    const teams = shared("teams");
    const people = peopleFiles.map((kind) =>
      peopleMatters.filter(({ matter }) => matter === kind)
    );
    expect({
      members: memberProbes.length,
      files: {
        workspace: workspace.map((probes) => probes.length),
        teams: teams.map((probes) => probes.length),
        people: people.map((matters) => matters.length),
      },
      asked: {
        workspace: new Set(workspace.flat().map(({ id }) => id)).size,
        teams: new Set(teams.flat().map(({ id }) => id)).size,
        people: new Set(people.flat().map(({ id }) => id)).size,
      },
      once: {
        workspace: workspace.flat().length,
        teams: teams.flat().length,
        people: people.flat().length,
      },
    }).toStrictEqual({
      members: 120,
      files: {
        workspace: [25, 25, 35, 35],
        teams: [25, 25, 18, 17, 35],
        people: [5, 5, 5],
      },
      asked: { workspace: 120, teams: 120, people: peopleMatters.length },
      once: { workspace: 120, teams: 120, people: peopleMatters.length },
    });
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
