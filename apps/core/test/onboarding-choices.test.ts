import type { SetupChoicesInput } from "@grasp-os/shared/onboarding-choices";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// What the company's admin chose in the onboarding about what Grasp may
// connect (src/onboarding/store.ts), over `/rpc`, and how much it counts
// in what Grasp knows (src/onboarding/gate.ts). The ways it can fail,
// tried here:
//
// - Anyone but an admin reading or changing it.
// - What isn't a choice kept: a place nobody offers, one named twice, a
//   platform made up.
// - What the admin typed in the audit log.
// - A choice counting for more than its weight, or one only asked for
//   counting at all.

const idp = mockIdp();

/** A place nobody else asks for, to look for where it must not be. */
const sentinel = "Quillfeather Vault";

const chosen: SetupChoicesInput = {
  sources: ["sharepoint", "confluence"],
  sourcesWanted: [sentinel],
  pulse: "skipped",
  hr: { kind: "platform", name: "Personio" },
};

/** How much each part is known, by part. */
const knownOf = (parts: { source: string; known: number }[]) =>
  Object.fromEntries(parts.map(({ source, known }) => [source, known]));

describe("what the admin chose", () => {
  it("is kept, read back, and counted by its weights: places and an HR platform named, Pulse skipped", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.saveChoices({
      sources: [],
      sourcesWanted: [],
      pulse: null,
      hr: null,
    });
    const before = await api.onboardingGate.view();
    const saved = await api.onboarding.saveChoices(chosen);
    const after = await api.onboardingGate.view();
    const { sources, tools, leads } = knownOf(after.parts);
    expect({
      saved,
      read: await api.onboarding.choices(),
      moved: after.known - before.known,
      parts: { sources, tools, leads },
    }).toStrictEqual({
      saved: chosen,
      read: chosen,
      // Where the documents live (5) and the leads (10); Pulse skipped counts nothing.
      moved: 15,
      parts: { sources: 1, tools: 0, leads: 1 },
    });
  });

  it("counts Pulse once it is to be set up, and neither a place nor a platform only asked for", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.saveChoices({
      sources: [],
      sourcesWanted: ["Dropbox"],
      pulse: "wanted",
      hr: { kind: "asked", name: "Workday" },
    });
    const { parts } = await api.onboardingGate.view();
    expect(knownOf(parts)).toMatchObject({ sources: 0, tools: 1, leads: 0 });
  });

  it.each([
    ["a place nobody offers", { ...chosen, sources: ["dropbox"] }],
    ["a place named twice", { ...chosen, sources: ["notion", "notion"] }],
    [
      "an HR platform made up",
      { ...chosen, hr: { kind: "platform", name: "Workday" } },
    ],
    ["Pulse half-chosen", { ...chosen, pulse: "maybe" }],
    ["a name asked for that is empty", { ...chosen, sourcesWanted: ["  "] }],
  ])("refuses %s", async (_, choices) => {
    const { api } = await signedInApi(idp, "admin");
    // SAFETY: what the type refuses, as a client could still send it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const sent = choices as SetupChoicesInput;
    await expect(outcome(api.onboarding.saveChoices(sent))).resolves.toBe(
      "onboarding.invalid"
    );
  });

  it("is the admin's alone, and in the audit log as them without what they typed", async () => {
    const { api: user } = await signedInApi(idp, "user");
    const { api, userId } = await signedInApi(idp, "admin");
    const events = await auditedDuring(async () => {
      await api.onboarding.saveChoices(chosen);
    });
    const saved = events.filter(
      ({ action }) => action === "onboarding.choices.saved"
    );
    expect({
      read: await outcome(user.onboarding.choices()),
      save: await outcome(user.onboarding.saveChoices(chosen)),
      saved: saved.map(({ actor, detail }) => ({
        actor: actor.type === "person" ? actor.userId : actor.type,
        detail,
      })),
      typed: JSON.stringify(events).includes(sentinel),
    }).toStrictEqual({
      read: "role.forbidden",
      save: "role.forbidden",
      saved: [
        {
          actor: userId,
          detail: {
            sources: "sharepoint confluence",
            asked: 1,
            pulse: "skipped",
            hr: "platform",
          },
        },
      ],
      typed: false,
    });
  });
});
