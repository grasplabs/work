import { signInConfigSchema } from "@grasp-os/shared/deployment-config";
import { describe, expect, it } from "vite-plus/test";

import {
  adminUnreachable,
  clientSignInSchema,
  derivedCoreConfig,
  signInProblem,
  signInSettingProblem,
} from "../src/deploy/core-config.ts";

const entra = {
  domains: ["acme.test", "acme-group.test"],
  entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
};

/** The codes of the issues `signIn` is refused with; empty when it's taken. */
const codesOf = (signIn: unknown): unknown[] => {
  const parsed = clientSignInSchema.safeParse(signIn);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue): unknown =>
        issue.code === "custom" ? issue.params?.code : issue.code
      );
};

describe("a client's sign-in", () => {
  it("takes first admins whose emails are in the email domains, whatever their case", () => {
    expect([
      codesOf({ ...entra, admins: ["ada@acme.test"] }),
      codesOf({ ...entra, admins: ["Ada@ACME-Group.test", "bo@acme.test"] }),
      codesOf({
        domains: ["acme.test"],
        googleHostedDomain: "acme.test",
        admins: ["ada@acme.test"],
      }),
    ]).toStrictEqual([[], [], []]);
  });

  it("refuses a sign-in no first admin could ever sign in with", () => {
    expect({
      none: codesOf({ ...entra, admins: [] }),
      outside: codesOf({ ...entra, admins: ["ada@elsewhere.test"] }),
      // A subdomain isn't the domain: core matches domains exactly.
      subdomain: codesOf({ ...entra, admins: ["ada@eu.acme.test"] }),
      // One admin who can sign in doesn't cover one who can't.
      mixed: codesOf({
        ...entra,
        admins: ["ada@acme.test", "bo@gmail.test"],
      }),
    }).toStrictEqual({
      none: [adminUnreachable],
      outside: [adminUnreachable],
      subdomain: [adminUnreachable],
      mixed: [adminUnreachable],
    });
  });

  it("refuses a SIGN_IN setting no admin could sign in with, as it would be saved or deployed", () => {
    const setting = {
      origin: "https://acme.grasp.test",
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      google: { hostedDomain: "acme.test", clientId: "google-app" },
    };
    expect({
      reachable: signInSettingProblem(setting),
      none: signInSettingProblem({ ...setting, admins: [] }),
      outside: signInSettingProblem({
        ...setting,
        admins: ["ada@elsewhere.test"],
      }),
      invalid: signInSettingProblem({ domains: ["acme.test"] }),
    }).toStrictEqual({
      reachable: null,
      none: adminUnreachable,
      outside: adminUnreachable,
      invalid: "sign_in_invalid",
    });
  });

  it("takes a SIGN_IN setting with an Entra tenant, a Google Workspace or both, and refuses one with neither", () => {
    const setting = {
      origin: "https://acme.grasp.test",
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
    };
    const entraIdp = {
      tenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
      clientId: "entra-app",
    };
    const google = { hostedDomain: "acme.test", clientId: "google-app" };
    expect({
      entra: signInSettingProblem({ ...setting, entra: entraIdp }),
      google: signInSettingProblem({ ...setting, google }),
      both: signInSettingProblem({ ...setting, entra: entraIdp, google }),
      // Nobody could sign in: no admin either, but that isn't what's wrong.
      neither: signInSettingProblem(setting),
    }).toStrictEqual({
      entra: null,
      google: null,
      both: null,
      neither: "sign_in_invalid",
    });
  });

  it("says who can't sign in, and why, as the new-client form shows it", () => {
    expect(
      signInProblem({ ...entra, admins: ["ada@acme.test", "bo@gmail.test"] })
    ).toBe(
      "bo@gmail.test can't sign in: every first admin's email must be in the email domains (acme.test, acme-group.test)."
    );
  });

  describe("with Grasp's staff window", () => {
    const record = JSON.stringify({
      ...entra,
      admins: ["ada@acme.test"],
    });
    const staff = {
      tenantId: "4b2c6e1a-9d3f-4a7b-8c5e-1f2a3b4c5d6e",
      domains: ["joingrasp.com"],
      oids: ["0f1e2d3c-4b5a-4968-8776-655443322110"],
    };
    const window = JSON.stringify({
      opened: "2026-11-06T09:00:00.000Z",
      until: "2026-11-13T09:00:00.000Z",
      scope: "onboarding",
    });
    const entraClientId = "01228906-bd5b-488e-b7c1-720f4dc12dc2";

    it("gives core's SIGN_IN Grasp's staff, as admins of the onboarding, while a window is open", () => {
      const config = derivedCoreConfig({
        clientId: "acme",
        signIn: record,
        domain: "grasp.test",
        apps: { entraClientId, staff },
        staffWindow: window,
      });
      expect(signInConfigSchema.parse(config.SIGN_IN).staff).toStrictEqual({
        tenantId: staff.tenantId,
        clientId: entraClientId,
        domains: staff.domains,
        oids: staff.oids,
        role: "admin",
        scope: "onboarding",
        opened: "2026-11-06T09:00:00.000Z",
        until: "2026-11-13T09:00:00.000Z",
      });
      expect(signInSettingProblem(config.SIGN_IN)).toBeNull();
    });

    it("gives none without a window, or with one longer than seven days", () => {
      const staffOf = (staffWindow: string | null) =>
        signInConfigSchema.parse(
          derivedCoreConfig({
            clientId: "acme",
            signIn: record,
            domain: "grasp.test",
            apps: { entraClientId, staff },
            staffWindow,
          }).SIGN_IN
        ).staff;
      expect({
        none: staffOf(null),
        tooLong: staffOf(
          JSON.stringify({
            opened: "2026-11-01T09:00:00.000Z",
            until: "2026-11-13T09:00:00.000Z",
            scope: "onboarding",
          })
        ),
      }).toStrictEqual({ none: undefined, tooLong: undefined });
    });

    it("gives a window without Grasp's staff sign-in while the admin doesn't know Grasp's staff", () => {
      const config = derivedCoreConfig({
        clientId: "acme",
        signIn: record,
        domain: "grasp.test",
        apps: { entraClientId },
        staffWindow: window,
      });
      expect(signInConfigSchema.parse(config.SIGN_IN).staff).toStrictEqual({
        role: "admin",
        scope: "onboarding",
        opened: "2026-11-06T09:00:00.000Z",
        until: "2026-11-13T09:00:00.000Z",
      });
      expect(signInSettingProblem(config.SIGN_IN)).toBeNull();
    });
  });
});
