import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { openRpc, outcome, signedInApi } from "./sign-in.ts";

// People's own choice of the emails Grasp sends them, through `/rpc` as
// the frontend reaches it, kept in each person's own Workspace object.
// The ways it can fail come first: someone else reads or changes a
// person's choice; one never saved reads as no emails rather than every
// one; saving one email puts back another a second page changed; a page
// saves more than the preferences, or not a yes or no, and overwrites
// what was saved.

const idp = mockIdp();

/** Every email, as a person who never chose gets them. */
const everyEmail = {
  needsYou: true,
  weeklySummary: true,
  billingProblems: true,
};

/** Someone signed in on a connection of their own, and their email preferences. */
const person = async () => {
  const signedIn = await signedInApi(idp, "user");
  return { ...signedIn, preferences: signedIn.api.emailPreferences };
};

describe("a person's email preferences", () => {
  it("are every email until they change one, then theirs as saved", async () => {
    const { preferences } = await person();
    await expect(preferences.get()).resolves.toStrictEqual(everyEmail);

    await preferences.save({ weeklySummary: false, billingProblems: false });
    await expect(preferences.get()).resolves.toStrictEqual({
      needsYou: true,
      weeklySummary: false,
      billingProblems: false,
    });

    await preferences.save({ needsYou: false, weeklySummary: true });
    await expect(preferences.get()).resolves.toStrictEqual({
      needsYou: false,
      weeklySummary: true,
      billingProblems: false,
    });
  });

  it("change only the emails a save names, so two pages open at once keep each other's changes", async () => {
    const { session, api } = await signedInApi(idp, "user");
    const first = api.emailPreferences;
    const { core } = await openRpc(session);
    const second = core.authenticate().emailPreferences;
    // Both pages read every email, then each changes a different one.
    await first.get();
    await second.get();

    await first.save({ needsYou: false });
    await second.save({ weeklySummary: false });
    await expect(first.get()).resolves.toStrictEqual({
      needsYou: false,
      weeklySummary: false,
      billingProblems: true,
    });
  });

  it("are each person's own: another's stay as they were", async () => {
    const ann = await person();
    const bob = await person();
    const none = {
      needsYou: false,
      weeklySummary: false,
      billingProblems: false,
    };
    await ann.preferences.save(none);

    await expect(bob.preferences.get()).resolves.toStrictEqual(everyEmail);
    await bob.preferences.save({ weeklySummary: false });
    await expect(ann.preferences.get()).resolves.toStrictEqual(none);
    await expect(bob.preferences.get()).resolves.toStrictEqual({
      ...everyEmail,
      weeklySummary: false,
    });
  });

  it("refuse anything but a yes or no for Grasp's emails, and keep what was saved", async () => {
    const { preferences } = await person();
    const saved = {
      needsYou: false,
      weeklySummary: true,
      billingProblems: true,
    };
    await preferences.save(saved);
    const save = async (sent: unknown) =>
      await outcome(
        preferences.save(
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          sent as never
        )
      );

    expect({
      notBoolean: await save({ needsYou: "yes" }),
      unknown: await save({ marketing: true }),
      more: await save({ needsYou: true, personId: "someone-else" }),
      nothing: await save(null),
    }).toStrictEqual({
      notBoolean: "email_preferences.invalid",
      unknown: "email_preferences.invalid",
      more: "email_preferences.invalid",
      nothing: "email_preferences.invalid",
    });
    await expect(preferences.get()).resolves.toStrictEqual(saved);
  });
});
