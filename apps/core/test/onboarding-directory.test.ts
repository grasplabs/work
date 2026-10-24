import type { DirectoryPeople } from "@grasp-os/shared/directory";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { consentCode, directoryControlUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Who works where from the organization's directory (GRA-369), in core:
// the admin connects their Microsoft sign-in from the onboarding's
// company step and comes back to it, and core reads everyone in the
// directory through connect, for the admin's browser to make a roster of.
// The ways it could go wrong come first: someone other than the client's
// admin connecting or reading it, a read without a trace, a directory
// cut short into a roster of part of the company. Connect's own threat
// model (a token that reads mail, planted names, foreign cursors) is
// tried in connect's test/directory.test.ts, with Graph and Google faked.

const idp = mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Who is in the tenant's directory, from now on, as Graph has them. */
const directoryHolds = async (
  users: Record<string, unknown>[]
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(directoryControlUrl, {
    method: "POST",
    body: JSON.stringify({ users }),
  });
};

const guid = (): string => crypto.randomUUID();

/** Someone in Entra, as Graph answers the directory's read. */
const user = (
  fields: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: guid(),
  displayName: "Someone",
  mail: null,
  department: null,
  jobTitle: null,
  accountEnabled: true,
  userType: "Member",
  manager: null,
  ...fields,
});

/** Where the company step sends the browser back to. */
const companyStep = "/setup?step=company";

/**
 * An admin who connected the directory from the company step: their API,
 * and where the browser came back to.
 */
const connected = async () => {
  const admin = await signedInApi(idp, "admin");
  const { url } = await admin.api.onboarding.connectDirectory(
    "microsoft",
    companyStep
  );
  const authorization = new URL(url);
  const response = await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(authorization, acmeTenant, `directory-${guid()}`),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: admin.session } }
  );
  return {
    admin,
    authorization,
    back: new URL(response.headers.get("location") ?? ""),
  };
};

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

describe("the onboarding's directory", () => {
  it("is connected by the client's admin from the company step, which the browser comes back to, and read by them alone, on the record", async () => {
    const before = await signedInApi(idp, "admin");
    const unconnected = {
      directory: await before.api.onboarding.directory(),
      read: await outcome(before.api.onboarding.readDirectory()),
    };
    const [lead, lisa] = [guid(), guid()];
    await directoryHolds([
      user({
        id: lead,
        displayName: "Daan Bakker",
        mail: "daan@acme.test",
        department: "Customer service",
        jobTitle: "Team lead",
      }),
      user({
        id: lisa,
        displayName: "Lisa Jansen",
        mail: "lisa@acme.test",
        department: "Customer service",
        jobTitle: "Agent",
        manager: { id: lead },
      }),
      user({ displayName: "A guest", userType: "Guest" }),
    ]);
    const { admin, authorization, back } = await connected();
    const member = await signedInApi(idp, "user");
    const staff = await asStaff();
    let read: DirectoryPeople | undefined;
    const events = await auditedDuring(async () => {
      read = await admin.api.onboarding.readDirectory();
    });
    expect({
      unconnected,
      client: authorization.searchParams.get("client_id"),
      back: `${back.pathname}?step=${back.searchParams.get("step") ?? ""}`,
      connection: back.searchParams.has("connection"),
      directory: await admin.api.onboarding.directory(),
      read,
      recorded: events
        .filter(({ action }) => action === "onboarding.directory_read")
        .map(({ actor, target }) => ({
          actor: actor.type,
          target: target?.type,
        })),
      memberDirectory: await outcome(member.api.onboarding.directory()),
      memberRead: await outcome(member.api.onboarding.readDirectory()),
      memberConnect: await outcome(
        member.api.onboarding.connectDirectory("microsoft", companyStep)
      ),
      staffRead: await outcome(staff.onboarding.readDirectory()),
      staffConnect: await outcome(
        staff.onboarding.connectDirectory("microsoft", companyStep)
      ),
      elsewhere: await outcome(
        admin.api.onboarding.connectDirectory("microsoft", "//evil.test/setup")
      ),
      otherSuite: await outcome(
        admin.api.onboarding.connectDirectory(
          // @ts-expect-error -- a suite there is no directory of
          "slack",
          companyStep
        )
      ),
    }).toStrictEqual({
      unconnected: { directory: null, read: "directory.not_connected" },
      client: "grasp-directory-entra",
      back: companyStep,
      connection: true,
      directory: { suite: "microsoft", status: "active" },
      read: {
        suite: "microsoft",
        people: [
          {
            id: lead,
            name: "Daan Bakker",
            email: "daan@acme.test",
            department: "Customer service",
            title: "Team lead",
            manager: null,
          },
          {
            id: lisa,
            name: "Lisa Jansen",
            email: "lisa@acme.test",
            department: "Customer service",
            title: "Agent",
            manager: lead,
          },
        ],
      },
      recorded: [{ actor: "person", target: "connection" }],
      memberDirectory: "role.forbidden",
      memberRead: "role.forbidden",
      memberConnect: "role.forbidden",
      staffRead: "role.forbidden",
      staffConnect: "role.forbidden",
      elsewhere: "connection.invalid",
      otherSuite: "directory.invalid",
    });
  });

  it("reads a directory page by page, and refuses one with more people than an onboarding takes rather than cut it short", async () => {
    const most = Array.from({ length: onboardingPeopleMax }, (_, index) =>
      user({ displayName: `Person ${String(index)}` })
    );
    await directoryHolds(most);
    const { admin } = await connected();
    const whole = await admin.api.onboarding.readDirectory();
    await directoryHolds([...most, user({ displayName: "One more" })]);
    const tooMany = await outcome(admin.api.onboarding.readDirectory());
    expect({ whole: whole.people.length, tooMany }).toStrictEqual({
      whole: onboardingPeopleMax,
      tooMany: "directory.too_large",
    });
  });
});
