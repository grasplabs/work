import {
  organizationLogoMaxBytes,
  organizationLogoMaxPixels,
} from "@grasp-os/shared/organization";
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
// first: a builder, a user, Grasp staff or an admin demoted since their
// session was checked setting or removing the logo (only the
// organization's own admins may), a file that isn't an image or one a
// browser could run (an SVG, HTML behind an image's header), a file too
// large or an image declaring too many pixels, someone who isn't a
// signed-in member reading it, and a replaced or removed logo still
// served or kept. A guest reading it is in guest-role.test.ts, with every
// other route.

const idp = mockIdp();

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];
/** `value` as `bytes` bytes, big-endian unless `little`. */
const numberBytes = (value: number, bytes: 2 | 4, little = false) => {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  if (bytes === 2) {
    view.setUint16(0, value, little);
  } else {
    view.setUint32(0, value, little);
  }
  return [...out.subarray(0, bytes)];
};
const be16 = (value: number) => numberBytes(value, 2);
const be32 = (value: number) => numberBytes(value, 4);
const le16 = (value: number) => numberBytes(value, 2, true);
const le32 = (value: number) => numberBytes(value, 4, true);
const le24 = (value: number) => le32(value).slice(0, 3);

/** `head`, then `fill` up to `size` bytes in all. */
const bytesOf = (
  head: readonly number[],
  size = head.length + 64,
  fill = 1
) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(head);
  return bytes;
};

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's signature and IHDR, `width` by `height`, `size` bytes in all. */
const png = ({ width = 64, height = 64, size = 88, fill = 1 } = {}) =>
  bytesOf(
    [
      ...pngSignature,
      ...be32(13),
      ...ascii("IHDR"),
      ...be32(width),
      ...be32(height),
    ],
    size,
    fill
  );

/**
 * A JPEG's SOI, an APP0 segment for the walk to step over, then a frame
 * header (`sof`: SOF0 baseline, SOF2 progressive) of `width` by `height`.
 */
const jpeg = ({ width = 64, height = 64, sof = 0xc0 } = {}) =>
  bytesOf([
    // SOI.
    0xff,
    0xd8,
    // APP0, 16 bytes long: "JFIF", its version, density and no thumbnail.
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF"),
    ...Array.from({ length: 10 }, () => 0),
    // The frame header: precision, height, width, three components.
    0xff,
    sof,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    ...Array.from({ length: 9 }, () => 1),
  ]);

/** A JPEG whose scan starts before any frame header. */
const scanFirst = bytesOf([0xff, 0xd8, 0xff, 0xda, ...be16(8)]);

const riff = (fourcc: string) => [
  ...ascii("RIFF"),
  ...le32(56),
  ...ascii(fourcc),
];

/** A simple lossy WebP ("VP8 "), `width` by `height`. */
const vp8 = (width = 64, height = 64) =>
  bytesOf([
    ...riff("WEBP"),
    ...ascii("VP8 "),
    ...le32(40),
    // A frame tag, then the start code.
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height),
  ]);

/** A lossless WebP ("VP8L"), `width` by `height`. */
const vp8l = (width = 64, height = 64) =>
  bytesOf([
    ...riff("WEBP"),
    ...ascii("VP8L"),
    ...le32(40),
    0x2f,
    ...le32(width - 1 + (height - 1) * 0x40_00),
  ]);

/** An extended WebP ("VP8X"), its canvas `width` by `height`. */
const vp8x = (width = 64, height = 64) =>
  bytesOf([
    ...riff("WEBP"),
    ...ascii("VP8X"),
    ...le32(10),
    // Flags, then three reserved bytes.
    0,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
  ]);

/** A RIFF file, but a sound: not a WebP. */
const wave = bytesOf(riff("WAVE"));

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

/** A PNG's header with a page of script after it. */
const polyglot = new Uint8Array([
  ...png({ size: 24 }),
  ...ascii("<html><script>alert(document.cookie)</script></html>"),
]);

/**
 * What `cookie` reads at `path`: its status and the headers every answer
 * there carries, and its type and caching when it is the logo.
 */
const read = async (path: string, cookie?: string) => {
  const response = await routed(
    path,
    cookie === undefined ? {} : { headers: { cookie } }
  );
  const { status, headers } = response;
  await response.body?.cancel();
  const guarded = {
    status,
    nosniff: headers.get("x-content-type-options"),
    policy: headers.get("content-security-policy"),
    resourcePolicy: headers.get("cross-origin-resource-policy"),
  };
  return status === 200
    ? {
        ...guarded,
        type: headers.get("content-type"),
        cache: headers.get("cache-control"),
      }
    : guarded;
};

/** What every answer on the logo's path carries, with `status`. */
const guardedAnswer = (status: number) => ({
  status,
  nosniff: "nosniff",
  policy: "default-src 'none'; sandbox",
  resourcePolicy: "same-origin",
});

/** How many logos the files bucket holds. */
const logosKept = async (): Promise<number> => {
  const listed = await env.FILES.list({ prefix: "organization/logo/" });
  return listed.objects.length;
};

/** Sets `userId`'s role in the organization, as an admin's change would. */
const setRole = async (userId: string, role: string): Promise<void> => {
  await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
    .bind(role, userId)
    .run();
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
          detail: { type: "image/png", bytes: 88 },
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

  it("is refused to an admin demoted since their session was checked, and leaves nothing of theirs behind", async () => {
    const admin = await signedInApi(idp, "admin");
    // The connection's reading of who they are holds for a few seconds
    // (session-check.ts): these calls come within it, so only the write's
    // own check of their role stands in the way.
    const { logo } = await admin.api.organization.setLogo(png({ fill: 4 }));
    await setRole(admin.userId, "user");

    const refused = [
      await outcome(admin.api.organization.setLogo(png({ fill: 5 }))),
      await outcome(admin.api.organization.removeLogo()),
    ];
    const kept = await admin.api.organization.get();
    const stored = await logosKept();
    await setRole(admin.userId, "admin");
    await admin.api.organization.removeLogo();

    expect({ refused, kept: kept.logo, stored }).toStrictEqual({
      refused: ["role.forbidden", "role.forbidden"],
      kept: logo,
      stored: 1,
    });
    await expect(logosKept()).resolves.toBe(0);
  });

  it("takes only a PNG, JPEG or WebP of at most 512 KB and 4096 pixels a side, told by its header", async () => {
    const admin = await signedInApi(idp, "admin");
    const most = organizationLogoMaxPixels;

    const invalid = await Promise.all(
      [
        svg,
        wave,
        new Uint8Array(),
        bytesOf(pngSignature),
        png({ width: 0 }),
        scanFirst,
      ].map(
        async (image) => await outcome(admin.api.organization.setLogo(image))
      )
    );
    const tooLarge = await outcome(
      admin.api.organization.setLogo(
        png({ size: organizationLogoMaxBytes + 1 })
      )
    );
    const tooWide = await Promise.all(
      [
        png({ width: most + 1 }),
        png({ height: most + 1 }),
        jpeg({ width: most + 1 }),
        jpeg({ height: most + 1, sof: 0xc2 }),
        vp8(most + 1),
        vp8l(64, most + 1),
        vp8x(most + 1),
      ].map(
        async (image) => await outcome(admin.api.organization.setLogo(image))
      )
    );
    const kept = await admin.api.organization.get();
    const taken = [];
    for (const image of [
      png({ width: most, height: most, size: organizationLogoMaxBytes }),
      jpeg({ width: most, height: most, sof: 0xc2 }),
      vp8(most, most),
      vp8l(most, most),
      vp8x(most, most),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one logo after another
      const { logo } = await admin.api.organization.setLogo(image);
      // oxlint-disable-next-line no-await-in-loop -- read before the next
      const served = await read(logo ?? "", admin.session);
      taken.push("type" in served ? served.type : served.status);
    }

    expect({
      invalid,
      tooLarge,
      tooWide,
      kept: kept.logo,
      taken,
    }).toStrictEqual({
      invalid: Array.from({ length: 6 }, () => "organization.logo_invalid"),
      tooLarge: "organization.logo_too_large",
      tooWide: Array.from({ length: 7 }, () => "organization.logo_too_wide"),
      kept: null,
      taken: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/webp",
        "image/webp",
      ],
    });
    await admin.api.organization.removeLogo();
  });

  it("is shown to signed-in members only, as an image that runs nothing, and only the logo the organization has now", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const first = await admin.api.organization.setLogo(png({ fill: 2 }));
    const firstPath = first.logo ?? "";
    const second = await admin.api.organization.setLogo(polyglot);
    const path = second.logo ?? "";

    let staffRead = {};
    const staffAudited = await auditedDuring(
      async () => {
        staffRead = await read(path, staffSession);
      },
      { staffAccesses: true }
    );
    const seen = {
      member: await read(path, user.session),
      signedOut: await read(path),
      staff: staffRead,
      replaced: await read(firstPath, user.session),
      kept: await logosKept(),
    };
    await admin.api.organization.removeLogo();

    expect({
      ...seen,
      staffAudited: staffAudited.map(({ action, detail }) => [
        action,
        detail.surface,
      ]),
      gone: await read(path, user.session),
      keptAfter: await logosKept(),
    }).toStrictEqual({
      member: {
        ...guardedAnswer(200),
        type: "image/png",
        cache: "private, max-age=31536000, immutable",
      },
      signedOut: guardedAnswer(401),
      staff: guardedAnswer(401),
      replaced: guardedAnswer(404),
      kept: 1,
      staffAudited: [["staff.accessed", "organization.logo"]],
      gone: guardedAnswer(404),
      keptAfter: 0,
    });
  });
});
