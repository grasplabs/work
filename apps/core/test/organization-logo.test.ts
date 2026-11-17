import { organizationLogoMaxBytes } from "@grasp-os/shared/organization";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The organization's logo (Settings › Workspace). The ways it can fail,
// first: a builder, a user or Grasp staff setting or removing the logo
// (only the organization's own admins may), a file that isn't an image or
// one a browser could run (an SVG), a file too large, and someone who
// isn't a signed-in member reading it.

const idp = mockIdp();

/** A PNG's signature, then `size` bytes more: what core tells a PNG by. */
const png = (size = 64, fill = 1): Uint8Array => {
  const bytes = new Uint8Array(8 + size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

/** What `cookie` reads at `path`: its status, and its type when it is the logo. */
const read = async (path: string, cookie?: string) => {
  const response = await routed(
    path,
    cookie === undefined ? {} : { headers: { cookie } }
  );
  const { status } = response;
  const type = response.headers.get("content-type");
  await response.body?.cancel();
  return status === 200 ? { status, type } : { status };
};

describe("the organization's logo", { timeout: 60_000 }, () => {
  it("is set and taken away by the organization's own admins alone, each once in the audit log", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();

    const refused = await Promise.all([
      outcome(builder.api.organization.setLogo(png())),
      outcome(user.api.organization.setLogo(png())),
      outcome(staff.organization.setLogo(png())),
      outcome(builder.api.organization.removeLogo()),
    ]);
    const audited = await auditedDuring(async () => {
      await admin.api.organization.setLogo(png());
      // The same image again changes nothing, and records nothing more.
      await admin.api.organization.setLogo(png());
    });
    const { logo } = await admin.api.organization.get();
    const removed = await auditedDuring(async () => {
      await admin.api.organization.removeLogo();
    });
    const after = await admin.api.organization.get();

    expect({
      refused,
      audited: audited
        .filter(({ action }) => action.startsWith("organization.logo"))
        .map(({ action, actor, detail }) => ({ action, actor, detail })),
      logo: logo?.startsWith("/api/organization/logo/"),
      removed: removed.map(({ action }) => action),
      after: after.logo,
    }).toStrictEqual({
      refused: [
        "role.forbidden",
        "role.forbidden",
        refused[2],
        "role.forbidden",
      ],
      audited: [
        {
          action: "organization.logo.updated",
          actor: { type: "person", userId: admin.userId },
          detail: { type: "image/png", bytes: 72 },
        },
      ],
      logo: true,
      removed: ["organization.logo.removed"],
      after: null,
    });
    // Grasp staff are refused too, whatever the refusal is called.
    expect(refused[2]).not.toBe("ok");
  });

  it("takes only a PNG, JPEG or WebP of at most 512 KB, told by its bytes", async () => {
    const admin = await signedInApi(idp, "admin");

    const outcomes = await Promise.all([
      outcome(admin.api.organization.setLogo(svg)),
      outcome(
        admin.api.organization.setLogo(new TextEncoder().encode("not an image"))
      ),
      outcome(admin.api.organization.setLogo(png(organizationLogoMaxBytes))),
    ]);

    expect(outcomes).toStrictEqual([
      "organization.logo_invalid",
      "organization.logo_invalid",
      "organization.logo_too_large",
    ]);
    await expect(admin.api.organization.get()).resolves.toMatchObject({
      logo: null,
    });
  });

  it("is shown to signed-in members only, and only the logo the organization has now", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const first = await admin.api.organization.setLogo(png(64, 2));
    const firstPath = first.logo ?? "";
    const second = await admin.api.organization.setLogo(png(64, 3));
    const path = second.logo ?? "";

    const seen = {
      member: await read(path, user.session),
      signedOut: await read(path),
      replaced: await read(firstPath, user.session),
    };
    await admin.api.organization.removeLogo();

    expect({ ...seen, gone: await read(path, user.session) }).toStrictEqual({
      member: { status: 200, type: "image/png" },
      signedOut: { status: 401 },
      replaced: { status: 404 },
      gone: { status: 404 },
    });
  });
});
