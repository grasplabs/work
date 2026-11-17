import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  outcome,
  signedIn,
  signedInApi,
  whoami,
} from "./sign-in.ts";

// A person's own name (Settings › Profile). The ways it can fail, first:
// changing someone else's, a name of nothing or of any length, and the
// next sign-in putting the organization's name for them back.

const idp = mockIdp();

describe("a person's own name", { timeout: 60_000 }, () => {
  it("is theirs to change, once in the audit log, and stays through their next sign-in", async () => {
    const me = await signedInApi(idp, "user");
    const someoneElse = await signedInApi(idp, "user");
    const { name: theirName } = await whoami(someoneElse.session);

    const audited = await auditedDuring(async () => {
      await me.api.setName("  Sam de Vries  ");
      // The same name again changes nothing, and records nothing more.
      await me.api.setName("Sam de Vries");
    });
    const refused = await Promise.all([
      outcome(me.api.setName(" ")),
      outcome(me.api.setName("x".repeat(101))),
    ]);
    // Signing in again, the organization's sign-in names them as before.
    const again = await signedIn(idp, "microsoft", me.person);
    const { name: mine } = await whoami(again);
    const { name: theirs } = await whoami(someoneElse.session);

    expect({
      audited: audited.map(({ actor, action, target }) => ({
        actor,
        action,
        target,
      })),
      refused,
      mine,
      theirs,
    }).toStrictEqual({
      audited: [
        {
          actor: { type: "person", userId: me.userId },
          action: "member.name.updated",
          target: { type: "user", id: me.userId },
        },
      ],
      refused: ["member.name_invalid", "member.name_invalid"],
      mine: "Sam de Vries",
      theirs: theirName,
    });
  });
});
