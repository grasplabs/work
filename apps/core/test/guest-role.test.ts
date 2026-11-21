import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { appFilesPath } from "@grasp-os/shared/app-file-limits";
import { appLinksPath } from "@grasp-os/shared/app-link-limits";
import { auditExportPath } from "@grasp-os/shared/audit-log";
import { errorReportPath } from "@grasp-os/shared/error-reports";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appFunctionPath, pageLeaseHeader } from "@grasp-os/shared/page-limits";
import { guestRole } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { runFilesPath } from "@grasp-os/shared/run-files";
import { speechPath } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOwnExportPath } from "../src/brain-next-exports.ts";
import { recallAs } from "../src/brain-next.ts";
import { newTeam } from "./admin-teams.ts";
import { mockIdp } from "./idp.ts";
import { onLink, openedFor } from "./interview-link.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  callAuth,
  outcome,
  routed,
  signIn,
  signedInApi,
  signedInWithRole,
  whoami,
} from "./sign-in.ts";

// A guest (GRA-2235): someone outside the company, holding a membership
// of the deployment's organization in Better Auth with the role `guest`.
// Nothing makes one yet, so these tests turn a member into one by hand.
// From the threat model, the ways a guest could reach the company, tried
// here:
//
// - A route answering a guest's session: every route that asks who a
//   request comes from answers them exactly as nobody signed in, but
//   those open to guests (guest-access.ts, guest-apps.test.ts).
// - Better Auth's own organization routes: refused.
// - Being counted as someone in the company: a team, the Brain; offered
//   to share an App with only marked as a guest.
// - Opening an interview.
// - Becoming, or ceasing to be, a guest by a side door: the members
//   settings' role change, a sign-in through the company's IdP.

const idp = mockIdp();

/** Makes the member `userId` a guest, as nothing in the product does yet. */
const makeGuest = async (userId: string): Promise<void> => {
  // Nameless, as guest-members.ts makes a guest.
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?").bind(
      guestRole,
      userId
    ),
    env.DB.prepare("UPDATE users SET name = '' WHERE id = ?").bind(userId),
  ]);
};

/** Someone signed in as a member, made a guest since. */
const signedInGuest = async () => {
  const guest = await signedInWithRole(idp, "user");
  await makeGuest(guest.userId);
  return guest;
};

/** `userId`'s membership role now; null for none. */
const roleOf = async (userId: string): Promise<string | null> =>
  await env.DB.prepare("SELECT role FROM members WHERE user_id = ?")
    .bind(userId)
    .first<string>("role");

/** A response's status and error code, if it carries one. */
const answerOf = async (response: Response): Promise<string> => {
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: its status alone.
  }
  const error = errorPayloadSchema.safeParse(parsed);
  return error.success
    ? `${response.status} ${error.data.code}`
    : `${response.status}`;
};

/**
 * Headers of the client's own page, with `cookie` when given: a lease of
 * a page, as an App's page sends its file and link requests with.
 */
const pageHeaders = (cookie: string | undefined, json = false) => ({
  origin: clientOrigin,
  "sec-fetch-site": "same-origin",
  [pageLeaseHeader]: "lease-none",
  ...(json ? { "content-type": "application/json" } : {}),
  ...(cookie === undefined ? {} : { cookie }),
});

/** A POST from the client's own page, with a JSON body. */
const posted = async (
  path: string,
  cookie: string | undefined,
  body: unknown = {}
): Promise<string> =>
  await answerOf(
    await routed(path, {
      method: "POST",
      headers: pageHeaders(cookie, true),
      body: JSON.stringify(body),
    })
  );

/** A GET from the client's own page. */
const got = async (path: string, cookie: string | undefined) =>
  await answerOf(await routed(path, { headers: pageHeaders(cookie) }));

/**
 * One request of each family of routes that finds who it comes from by
 * the session: what each answered `cookie` (none: nobody signed in).
 */
const routeAnswers = async (cookie?: string) => ({
  rpc: await outcome(whoami(cookie)),
  pageCall: await posted(`${appFunctionPath}/app-none`, cookie, {
    function: "list",
    args: {},
  }),
  file: await got(
    `${appFilesPath}/app-none/store-none/files/file-none`,
    cookie
  ),
  upload: await posted(`${appFilesPath}/app-none/store-none/uploads`, cookie),
  link: await posted(`${appLinksPath}/app-none/store-none/check`, cookie),
  runDownload: await got(
    `${runFilesPath}/workflow-none/run-none/file-none/content`,
    cookie
  ),
  auditExport: await got(`${auditExportPath}?format=csv`, cookie),
  brainExport: await got(brainOwnExportPath, cookie),
  errorReport: await posted(errorReportPath, cookie, {
    message: "Broken",
  }),
  speech: await posted(speechPath, cookie, {
    text: "Hello there.",
    language: "en",
  }),
});

/** The status Better Auth's list of the organization's teams answers `cookie`. */
const teamsListed = async (cookie: string): Promise<number> => {
  const response = await callAuth("/organization/list-teams", cookie);
  await response.body?.cancel();
  return response.status;
};

/** What a recall of the Brain as `personId` came to. */
const recalled = async (personId: string): Promise<string> =>
  await outcome(
    recallAs(env, personId, {
      personal: true,
      question: "What does the company do?",
      budget: { tokens: recallBudgetMax },
    })
  );

describe("a guest", { timeout: 60_000 }, () => {
  it("is answered as nobody signed in by every route but those open to guests, and refused by Better Auth's organization routes", async () => {
    const member = await signedInWithRole(idp, "user");
    const guest = await signedInGuest();

    const [nobody, asGuest, asMember] = [
      await routeAnswers(),
      await routeAnswers(guest.session),
      await routeAnswers(member.session),
    ];

    // Open to guests (guest-access.ts): who they are, and an App's page
    // calls, files and links, answered as a member's are for an App that
    // isn't theirs.
    const openToGuests = ["rpc", "pageCall", "file", "upload", "link"] as const;
    expect(asGuest).toStrictEqual({
      ...nobody,
      ...Object.fromEntries(
        openToGuests.map((family) => [family, asMember[family]])
      ),
    });
    // Each route tells a member from nobody, so a guest answered as
    // nobody was refused for who they are.
    expect(
      Object.entries(asMember)
        .filter(([family, answer]) => answer === Reflect.get(nobody, family))
        .map(([family]) => family)
    ).toStrictEqual([]);
    await expect(
      Promise.all([teamsListed(guest.session), teamsListed(member.session)])
    ).resolves.toStrictEqual([403, 200]);
  });

  it("is offered to share an App with only as a guest, and never put in a team", async () => {
    const owner = await signedInApi(idp, "admin");
    const colleague = await signedInWithRole(idp, "user");
    const guest = await signedInGuest();
    const { id: app } = await owner.api.apps.create({ name: "Shared" });

    const offered = await owner.api.apps.members.candidates(app);
    const team = await newTeam(owner, [colleague]);
    const added = await callAuth(
      "/organization/add-team-member",
      owner.session,
      {
        teamId: team,
        userId: guest.userId,
      }
    );
    const inTeams = await env.DB.prepare(
      "SELECT count(*) AS n FROM team_members WHERE user_id = ?"
    )
      .bind(guest.userId)
      .first<number>("n");

    expect({
      colleague: offered.people.find(({ id }) => id === colleague.userId),
      guest: offered.people.find(({ id }) => id === guest.userId),
      added: added.status,
      inTeams,
    }).toStrictEqual({
      colleague: { id: colleague.userId, name: colleague.person.name },
      guest: { id: guest.userId, name: guest.person.email, guest: true },
      added: 403,
      inTeams: 0,
    });
  });

  it("is named to no member by Better Auth's own lists of the organization", async () => {
    const member = await signedInWithRole(idp, "user");
    const guest = await signedInGuest();

    const lists = await Promise.all(
      ["/organization/list-members", "/organization/get-full-organization"].map(
        async (path) => {
          const response = await callAuth(path, member.session);
          return await response.text();
        }
      )
    );

    expect(
      lists.filter(
        (text) =>
          text.includes(guest.userId) ||
          text.includes(String(guest.person.email))
      )
    ).toStrictEqual([]);
  });

  it("reads nothing of the Brain", async () => {
    const member = await signedInWithRole(idp, "user");
    const guest = await signedInGuest();

    await expect(
      Promise.all([recalled(member.userId), recalled(guest.userId)])
    ).resolves.toStrictEqual(["ok", "permission.person_inactive"]);
  });

  it("opens no interview, even one whose link went to their address", async () => {
    const { link } = await openedFor();
    const before = await onLink({ action: "session", ...link });
    const { userId } = await whoami(link.cookie);
    await makeGuest(userId);

    const after = await onLink({ action: "session", ...link });

    expect([before.status, await answerOf(after)]).toStrictEqual([
      200,
      await answerOf(await onLink({ action: "session", secret: link.secret })),
    ]);
  });

  it("stays a guest through the members settings' role change, and is made no member by it", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInWithRole(idp, "user");
    const guest = await signedInGuest();

    const [raised, lowered] = [
      await outcome(admin.api.members.setRole(guest.userId, "admin")),
      await outcome(
        admin.api.members.setRole(
          member.userId,
          // SAFETY: a role no member holds: what a page someone changed could send.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          guestRole as Role
        )
      ),
    ];

    expect({
      raised,
      lowered,
      guest: await roleOf(guest.userId),
      member: await roleOf(member.userId),
    }).toStrictEqual({
      raised: "member.not_found",
      lowered: "member.role_invalid",
      guest: guestRole,
      member: "user",
    });
  });

  it("stays a guest through a sign-in with the company's IdP, which gives them no session", async () => {
    const guest = await signedInGuest();

    const again = await signIn(idp, "microsoft", guest.person);

    expect({
      session: again.session,
      role: await roleOf(guest.userId),
    }).toStrictEqual({ session: undefined, role: guestRole });
  });

  it("is removed as any member is", async () => {
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInGuest();

    await admin.api.members.remove(guest.userId);

    const removed = await env.DB.prepare(
      "SELECT count(*) AS n FROM member_removals WHERE user_id = ?"
    )
      .bind(guest.userId)
      .first<number>("n");
    expect({ removed, role: await roleOf(guest.userId) }).toStrictEqual({
      removed: 1,
      role: null,
    });
  });
});
