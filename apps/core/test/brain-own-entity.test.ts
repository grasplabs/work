import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { erasePerson, ownEntityIdAs, rememberAs } from "../src/brain-next.ts";
import type { Remembered } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { entraPerson, signedIn, whoami, withSignIn } from "./sign-in.ts";

// A member's own entity in the Brain (GRA-1836): the person they are, in
// their own store, made by their first memory about themselves and never
// found by a name or an email. The threat model is on GRA-1836; each test
// names the threats it holds.

const idp = mockIdp();

/** Signing in takes a while on CI. */
const slow = { timeout: 60_000 };

/** A member signed in through their IdP: their user id and email. */
const signedInMember = async () => {
  const email = `person-${crypto.randomUUID()}@acme.test`;
  const person = entraPerson(acmeTenant, "acme.test", { email });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({ admins: [email] }),
  });
  const { userId } = await whoami(session);
  return { userId, email };
};

/** A memory of the member's own word about `about`. */
const saying = (about: Remembered["about"], statement: string): Remembered => ({
  change: crypto.randomUUID(),
  about,
  type: "fact",
  statement,
  quote: statement,
});

/** The member themselves, as a memory names them. */
const themselves = { kind: "person", own: true } as const;

describe("a member's own entity", () => {
  // T8: none until their first memory about themselves; the same after.
  it(
    "is made by their first memory about themselves, and is the same after",
    slow,
    async () => {
      const { userId } = await signedInMember();
      const before = await ownEntityIdAs(env, userId);
      const first = await rememberAs(
        env,
        userId,
        saying(themselves, "Leads the Rotterdam depot")
      );
      const second = await rememberAs(
        env,
        userId,
        saying(themselves, "Prefers short answers")
      );

      expect({
        before,
        first: first.entity,
        second: second.entity,
      }).toStrictEqual({
        before: null,
        first: await ownEntityIdAs(env, userId),
        second: first.entity,
      });
    }
  );

  // T1, T2: their email, or a reference that looks like them, names
  // another entity: never who they are.
  it(
    "is never what their email or a self-looking reference names",
    slow,
    async () => {
      const { userId, email } = await signedInMember();
      const byEmail = await rememberAs(
        env,
        userId,
        saying(
          { kind: "person", identifiers: [{ type: "email", value: email }] },
          "Wants payroll sent to a new account"
        )
      );
      const byRef = await rememberAs(
        env,
        userId,
        saying(
          {
            kind: "person",
            identifiers: [{ type: "ref", value: `grasp:person:${userId}` }],
          },
          "Approves every invoice"
        )
      );
      const mine = await rememberAs(
        env,
        userId,
        saying(themselves, "Works from Utrecht")
      );

      expect({
        email: byEmail.entity === mine.entity,
        ref: byRef.entity === mine.entity,
        own: await ownEntityIdAs(env, userId),
      }).toStrictEqual({ email: false, ref: false, own: mine.entity });
    }
  );

  // T7: erasing the person takes it with their store.
  it("goes when the person is erased", slow, async () => {
    const { userId } = await signedInMember();
    await rememberAs(env, userId, saying(themselves, "Works in sales"));

    await erasePerson(env, { personId: userId, reason: "person_erased" });

    await expect(ownEntityIdAs(env, userId)).resolves.toBeNull();
  });
});
