import { organizationLogoMaxBytes } from "@grasp-os/shared/organization";
import { env } from "cloudflare:workers";
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
// one a browser could run (an SVG, HTML behind an image's first bytes), a
// file too large, someone who isn't a signed-in member reading it, and a
// replaced or removed logo still served or kept. A guest reading it is in
// guest-role.test.ts, with every other route.

const idp = mockIdp();

/** `head`, then `size` bytes in all of `fill`. */
const bytesOf = (head: readonly number[], size: number, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(head);
  return bytes;
};

/** A PNG's signature, then `size` bytes more: what core tells a PNG by. */
const png = (size = 64, fill = 1): Uint8Array =>
  bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 8 + size, fill);

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

const jpeg = bytesOf([0xff, 0xd8, 0xff, 0xe0], 64);
const webp = bytesOf([...ascii("RIFF"), 56, 0, 0, 0, ...ascii("WEBP")], 64);
/** A RIFF file, but a sound: not a WebP. */
const wave = bytesOf([...ascii("RIFF"), 56, 0, 0, 0, ...ascii("WAVE")], 64);

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

/** A PNG's signature with a page of script after it. */
const polyglot = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...ascii("<html><script>alert(document.cookie)</script></html>"),
]);

/** What `cookie` reads at `path`: its status, and its headers when it is the logo. */
const read = async (path: string, cookie?: string) => {
  const response = await routed(
    path,
    cookie === undefined ? {} : { headers: { cookie } }
  );
  const { status, headers } = response;
  await response.body?.cancel();
  return status === 200
    ? {
        status,
        type: headers.get("content-type"),
        nosniff: headers.get("x-content-type-options"),
        policy: headers.get("content-security-policy"),
        cache: headers.get("cache-control"),
      }
    : { status };
};

/** How many logos the files bucket holds. */
const logosKept = async (): Promise<number> => {
  const listed = await env.FILES.list({ prefix: "organization/logo/" });
  return listed.objects.length;
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
      outcome(staff.organization.removeLogo()),
    ]);
    const unset = await admin.api.organization.get();
    const audited = await auditedDuring(async () => {
      await admin.api.organization.setLogo(png());
      // The same image again changes nothing, and records nothing more.
      await admin.api.organization.setLogo(png());
    });
    const { logo } = await admin.api.organization.get();
    const removed = await auditedDuring(async () => {
      await admin.api.organization.removeLogo();
      // Taking away a logo it no longer has changes nothing either.
      await admin.api.organization.removeLogo();
    });
    const after = await admin.api.organization.get();

    expect({
      refused,
      unset: unset.logo,
      audited: audited
        .filter(({ action }) => action.startsWith("organization.logo"))
        .map(({ action, actor, detail }) => ({ action, actor, detail })),
      logo: logo?.startsWith("/api/organization/logo/"),
      removed: removed
        .filter(({ action }) => action.startsWith("organization.logo"))
        .map(({ action, actor }) => ({ action, actor })),
      after: after.logo,
    }).toStrictEqual({
      refused: Array.from({ length: 5 }, () => "role.forbidden"),
      unset: null,
      audited: [
        {
          action: "organization.logo.updated",
          actor: { type: "person", userId: admin.userId },
          detail: { type: "image/png", bytes: 72 },
        },
      ],
      logo: true,
      removed: [
        {
          action: "organization.logo.removed",
          actor: { type: "person", userId: admin.userId },
        },
      ],
      after: null,
    });
  });

  it("takes only a PNG, JPEG or WebP of at most 512 KB, told by its bytes", async () => {
    const admin = await signedInApi(idp, "admin");

    const refused = await Promise.all([
      outcome(admin.api.organization.setLogo(svg)),
      outcome(admin.api.organization.setLogo(wave)),
      outcome(admin.api.organization.setLogo(new Uint8Array())),
      outcome(
        admin.api.organization.setLogo(png(organizationLogoMaxBytes - 7))
      ),
    ]);
    const kept = await admin.api.organization.get();
    const taken = [];
    for (const image of [jpeg, webp, png(organizationLogoMaxBytes - 8)]) {
      // oxlint-disable-next-line no-await-in-loop -- one logo after another
      const { logo } = await admin.api.organization.setLogo(image);
      // oxlint-disable-next-line no-await-in-loop -- read before the next
      const served = await read(logo ?? "", admin.session);
      taken.push(served.type);
    }

    expect({ refused, kept: kept.logo, taken }).toStrictEqual({
      refused: [
        "organization.logo_invalid",
        "organization.logo_invalid",
        "organization.logo_invalid",
        "organization.logo_too_large",
      ],
      kept: null,
      taken: ["image/jpeg", "image/webp", "image/png"],
    });
    await admin.api.organization.removeLogo();
  });

  it("is shown to signed-in members only, as an image that runs nothing, and only the logo the organization has now", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const first = await admin.api.organization.setLogo(png(64, 2));
    const firstPath = first.logo ?? "";
    const second = await admin.api.organization.setLogo(polyglot);
    const path = second.logo ?? "";

    const seen = {
      member: await read(path, user.session),
      signedOut: await read(path),
      replaced: await read(firstPath, user.session),
      kept: await logosKept(),
    };
    await admin.api.organization.removeLogo();

    expect({
      ...seen,
      gone: await read(path, user.session),
      keptAfter: await logosKept(),
    }).toStrictEqual({
      member: {
        status: 200,
        type: "image/png",
        nosniff: "nosniff",
        policy: "default-src 'none'; sandbox",
        cache: "private, max-age=31536000, immutable",
      },
      signedOut: { status: 401 },
      replaced: { status: 404 },
      kept: 1,
      gone: { status: 404 },
      keptAfter: 0,
    });
  });
});
