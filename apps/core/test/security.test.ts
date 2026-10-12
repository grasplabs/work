import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  googlePerson,
  openRpc,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The Security section's reads: how the person signs in, and where. These
// tests start from the ways it can fail: someone reading another person's
// sessions, a session token handed to the page, and the page not telling
// this browser apart from the others.

const idp = mockIdp();

/** `session`'s own API, on a connection of its own. */
const apiOf = async (session: string) => {
  const { core } = await openRpc(session);
  return await core.authenticate();
};

describe("the person's sign-in", () => {
  it("names where they signed in", async () => {
    const entra = entraPerson(acmeTenant);
    const google = googlePerson();
    const viaEntra = await apiOf(await signedIn(idp, "microsoft", entra));
    const viaGoogle = await apiOf(await signedIn(idp, "google", google));
    const staff = await apiOf(
      await signedIn(idp, "grasp-staff", staffPerson())
    );

    await expect(viaEntra.security.signIn()).resolves.toMatchObject({
      provider: "microsoft",
      email: entra.email,
    });
    await expect(viaGoogle.security.signIn()).resolves.toMatchObject({
      provider: "google",
      email: google.email,
    });
    await expect(staff.security.signIn()).resolves.toMatchObject({
      provider: "grasp-staff",
    });
  });
});

describe("the person's sessions", () => {
  it("lists their own, marks this one, and hands out no token", async () => {
    const person = await signedInApi(idp, "user");
    const otherBrowser = await signedIn(idp, "microsoft", person.person);
    const someoneElse = await signedInApi(idp, "user");

    const sessions = await person.api.security.sessions();

    expect(sessions).toHaveLength(2);
    expect(sessions.filter(({ current }) => current)).toHaveLength(1);
    const otherApi = await apiOf(otherBrowser);
    const theirs = await otherApi.security.sessions();
    expect(theirs.find(({ current }) => current)?.id).not.toBe(
      sessions.find(({ current }) => current)?.id
    );
    const sent = JSON.stringify(sessions);
    for (const cookie of [person.session, otherBrowser]) {
      const [, value = ""] = cookie.split("=");
      const [token] = decodeURIComponent(value).split(".");
      expect(token).not.toBe("");
      expect(sent).not.toContain(token);
    }
    const others = await someoneElse.api.security.sessions();
    expect(others.map(({ id }) => id)).not.toContain(sessions[0]?.id);
  });

  it("are down to this one once they sign out the others", async () => {
    const person = await signedInApi(idp, "user");
    await signedIn(idp, "microsoft", person.person);
    await signedIn(idp, "microsoft", person.person);
    await expect(person.api.security.sessions()).resolves.toHaveLength(3);

    const response = await callAuth(
      "/revoke-other-sessions",
      person.session,
      {}
    );
    expect(response.ok).toBeTruthy();

    const left = await person.api.security.sessions();
    expect(left).toStrictEqual([expect.objectContaining({ current: true })]);
  });
});
