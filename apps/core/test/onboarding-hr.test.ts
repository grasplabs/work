import type { HrPeople } from "@grasp-os/shared/hr";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { hibobControlUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Who leads which team from the company's HR platform (GRA-371), in core:
// the admin connects HiBob from the onboarding's confirm step with a
// service user they made there, and core reads everyone in it through
// connect, for the admin's browser to make a roster of. The ways it could
// go wrong come first: someone other than the client's admin connecting
// or reading it, the secret kept or recorded on the way, a read without a
// trace, a company cut short into a roster of part of it. Connect's own
// threat model (a personal key, planted names, more asked of HiBob than a
// roster needs) is tried in connect's test/hr.test.ts.

const idp = mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** What HiBob holds from now on: the service user it takes, and its people. */
const hibobHolds = async (state: {
  key?: string;
  employees?: Record<string, unknown>[];
}): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(hibobControlUrl, {
    method: "POST",
    body: JSON.stringify(state),
  });
};

let hibobIds = 4_000_000_000_000_000_000n;

/** Someone in HiBob, as its people search answers the HR read. */
const employee = (
  name: string,
  work: Record<string, unknown> = {}
): Record<string, unknown> => {
  hibobIds += 1n;
  return {
    id: String(hibobIds),
    displayName: name,
    email: `${name.split(" ")[0]?.toLowerCase() ?? "someone"}@acme.test`,
    work: { department: null, title: null, reportsTo: null, ...work },
  };
};

/** A service user HiBob takes from now on, new for each test. */
const serviceUser = async () => {
  const credentials = {
    id: `SERVICE-${crypto.randomUUID()}`,
    secret: `token-${crypto.randomUUID()}`,
  };
  await hibobHolds({ key: `${credentials.id}:${credentials.secret}` });
  return credentials;
};

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

describe("the onboarding's HR platform", () => {
  it("is connected by the client's admin with a service user HiBob takes, and read by them alone, on the record", async () => {
    const admin = await signedInApi(idp, "admin");
    const unconnected = {
      hr: await admin.api.onboarding.hrPlatform(),
      read: await outcome(admin.api.onboarding.readHrPlatform()),
    };
    const credentials = await serviceUser();
    const lead = employee("Daan Bakker", {
      department: "Customer service",
      title: "Team lead",
    });
    const lisa = employee("Lisa Jansen", {
      department: "Customer service",
      title: "Agent",
      reportsTo: { id: lead.id },
    });
    await hibobHolds({ employees: [lead, lisa] });
    const member = await signedInApi(idp, "user");
    const staff = await asStaff();
    const attempts = {
      refused: await outcome(
        admin.api.onboarding.connectHrPlatform("hibob", {
          id: credentials.id,
          secret: "not-the-token",
        })
      ),
      notHibob: await outcome(
        admin.api.onboarding.connectHrPlatform(
          // @ts-expect-error -- a platform Grasp doesn't read
          "personio",
          credentials
        )
      ),
      colon: await outcome(
        admin.api.onboarding.connectHrPlatform("hibob", {
          id: "a:b",
          secret: credentials.secret,
        })
      ),
      memberConnect: await outcome(
        member.api.onboarding.connectHrPlatform("hibob", credentials)
      ),
      staffConnect: await outcome(
        staff.onboarding.connectHrPlatform("hibob", credentials)
      ),
    };
    let connected;
    const connecting = await auditedDuring(async () => {
      connected = await admin.api.onboarding.connectHrPlatform(
        "hibob",
        credentials
      );
    });
    let read: HrPeople | undefined;
    const reading = await auditedDuring(async () => {
      read = await admin.api.onboarding.readHrPlatform();
    });
    expect({
      unconnected,
      ...attempts,
      connected,
      hr: await admin.api.onboarding.hrPlatform(),
      secretRecorded: JSON.stringify(connecting).includes(credentials.secret),
      read,
      recorded: reading
        .filter(({ action }) => action === "onboarding.hr_read")
        .map(({ actor, target }) => ({
          actor: actor.type,
          target: target?.type,
        })),
      memberHr: await outcome(member.api.onboarding.hrPlatform()),
      memberRead: await outcome(member.api.onboarding.readHrPlatform()),
      staffRead: await outcome(staff.onboarding.readHrPlatform()),
    }).toStrictEqual({
      unconnected: { hr: null, read: "hr.not_connected" },
      refused: "hr.refused",
      notHibob: "hr.invalid",
      colon: "hr.invalid",
      memberConnect: "role.forbidden",
      staffConnect: "role.forbidden",
      connected: { platform: "hibob", status: "active" },
      hr: { platform: "hibob", status: "active" },
      secretRecorded: false,
      read: {
        platform: "hibob",
        people: [
          {
            id: lead.id,
            name: "Daan Bakker",
            email: "daan@acme.test",
            department: "Customer service",
            title: "Team lead",
            manager: null,
          },
          {
            id: lisa.id,
            name: "Lisa Jansen",
            email: "lisa@acme.test",
            department: "Customer service",
            title: "Agent",
            manager: lead.id,
          },
        ],
      },
      recorded: [{ actor: "person", target: "connection" }],
      memberHr: "role.forbidden",
      memberRead: "role.forbidden",
      staffRead: "role.forbidden",
    });
  });

  it("refuses a company with more people than an onboarding takes rather than cut it short, and says when HiBob stops taking the service user", async () => {
    const admin = await signedInApi(idp, "admin");
    const credentials = await serviceUser();
    await admin.api.onboarding.connectHrPlatform("hibob", credentials);
    const most = Array.from({ length: onboardingPeopleMax }, (_, index) =>
      employee(`Person ${String(index)}`)
    );
    await hibobHolds({ employees: most });
    const whole = await admin.api.onboarding.readHrPlatform();
    await hibobHolds({ employees: [...most, employee("One more")] });
    const tooMany = await outcome(admin.api.onboarding.readHrPlatform());
    await hibobHolds({ key: "SERVICE-other:token" });
    const revoked = await outcome(admin.api.onboarding.readHrPlatform());
    expect({ whole: whole.people.length, tooMany, revoked }).toStrictEqual({
      whole: onboardingPeopleMax,
      tooMany: "hr.too_large",
      revoked: "hr.inactive",
    });
  });
});
