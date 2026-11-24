import {
  appPictureMaxBytes,
  appPictureMaxPixels,
  appPicturePath,
} from "@grasp-os/shared/apps";
import { describe, expect, it } from "vite-plus/test";

import { commitApp, published } from "./apps.ts";
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

// A picture of each published App version, for the Apps overview's cards
// (app-pictures.ts). From its threat model: someone who may not publish
// the App sets one (a builder of another App, a user of it, Grasp staff);
// one is set for a version not published, or for another App's version; a
// file a browser would run (HTML or an SVG posing as a PNG), one too
// large, with no pixels or cut short, is kept; anyone who may not open the
// App (a member without a role in it, a builder of another App, staff,
// nobody signed in) reads it; the overview shows an older version's
// picture for the current one; a set goes unrecorded. A guest reading it
// is in guest-role.test.ts, with every other route; its removal with its
// App in app-removal.test.ts.

const idp = mockIdp();

/** Signing people in and publishing can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/** A real PNG, 8 by 8 pixels, from Pillow (organization-logo.test.ts). */
const realPng = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGUlEQVR42mNkYGhQYGDARCwMCgxYweCUAABobwJednxjlwAAAABJRU5ErkJggg=="
);

/** A real lossless WebP, 1 by 1 pixel. */
const realWebp = fromBase64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");

const be32 = (value: number): number[] => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return [...out];
};

/**
 * A PNG's signature and IHDR, `width` by `height`, and its IEND, `size`
 * bytes in all.
 */
const png = ({ width = 64, height = 64, size = 88 } = {}): Uint8Array => {
  const bytes = new Uint8Array(size).fill(1);
  bytes.set([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...utf8("IHDR"),
    ...be32(width),
    ...be32(height),
  ]);
  bytes.set([...be32(0), ...utf8("IEND"), 0xae, 0x42, 0x60, 0x82], size - 12);
  return bytes;
};

/** A GIF's header and logical screen, 2 by 1 pixels. */
const gif = new Uint8Array([...utf8("GIF89a"), 2, 0, 1, 0, 0, 0, 0, 0x3b]);

/** What `cookie` reads at `path`: its status and headers, and its bytes. */
const served = async (path: string, cookie?: string) => {
  const response = await routed(
    path,
    cookie === undefined ? {} : { headers: { cookie } }
  );
  const { status, headers } = response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status,
    type: status === 200 ? headers.get("content-type") : undefined,
    cache: status === 200 ? headers.get("cache-control") : undefined,
    nosniff: headers.get("x-content-type-options"),
    policy: headers.get("content-security-policy"),
    bytes: status === 200 ? [...bytes] : undefined,
  };
};

/** What every answer on a picture's path carries, with `status`. */
const guardedAnswer = (status: number) => ({
  status,
  type: undefined,
  cache: undefined,
  nosniff: "nosniff",
  policy: "default-src 'none'; sandbox",
  bytes: undefined,
});

/** An answer of `bytes`, a picture of `type`. */
const pictureAnswer = (type: string, bytes: Uint8Array) => ({
  status: 200,
  type,
  cache: "private, no-cache",
  nosniff: "nosniff",
  policy: "default-src 'none'; sandbox",
  bytes: [...bytes],
});

/** Grasp staff, signed in, and their API. */
const staffApi = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return { session, api: core.authenticate() };
};

/** A builder's App, shared with `user` to use, its first version live. */
const liveApp = async (builder: Person, user?: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  if (user !== undefined) {
    await builder.api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  }
  await published(id);
  return id;
};

/** The picture the Apps overview shows `person` for App `app`. */
const overviewPicture = async (
  person: Person,
  app: string
): Promise<string | null | undefined> => {
  const listed = await person.api.apps.overview();
  return listed.find((overview) => overview.app.id === app)?.picture;
};

describe("an App version's picture", slow, () => {
  it("is set only by whoever may publish the App, for a published version of it, as a PNG, JPEG or WebP within the limits", async () => {
    const [owner, otherBuilder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const staff = await staffApi();
    const app = await liveApp(owner, user);
    // A second version, committed and never published.
    const { version: unpublished } = await commitApp(owner.api, app, {
      "README.md": "Two.\n",
    });
    // Another App, whose versions go past this one's.
    const other = await liveApp(otherBuilder);
    await commitApp(otherBuilder.api, other, { "README.md": "Two.\n" });
    await published(other);
    const { version: othersOnly } = await commitApp(otherBuilder.api, other, {
      "README.md": "Three.\n",
    });
    await published(other);
    const set = async (by: Person["api"], version: number, image: Uint8Array) =>
      await outcome(by.apps.setVersionPicture(app, version, image));

    expect({
      otherBuilder: await set(otherBuilder.api, 1, realPng),
      user: await set(user.api, 1, realPng),
      staff: await set(staff.api, 1, realPng),
      unpublished: await set(owner.api, unpublished, realPng),
      unknown: await set(owner.api, 99, realPng),
      othersVersion: await set(owner.api, othersOnly, realPng),
      htmlAsPng: await set(
        owner.api,
        1,
        utf8("<html><script>alert(document.cookie)</script></html>")
      ),
      svgAsPng: await set(
        owner.api,
        1,
        utf8(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        )
      ),
      gif: await set(owner.api, 1, gif),
      oversized: await set(owner.api, 1, png({ size: appPictureMaxBytes + 1 })),
      tooWide: await set(
        owner.api,
        1,
        png({ width: appPictureMaxPixels + 1, height: 10 })
      ),
      noPixels: await set(owner.api, 1, png({ height: 0 })),
      // Its header, then an upload cut short.
      cutShort: await set(owner.api, 1, realPng.subarray(0, 40)),
      // Nothing refused was kept.
      overview: await overviewPicture(owner, app),
      read: await served(appPicturePath(app, 1), owner.session),
      // At the limits, it is taken.
      atLimits: await set(
        owner.api,
        1,
        png({
          width: appPictureMaxPixels,
          height: appPictureMaxPixels,
          size: appPictureMaxBytes,
        })
      ),
    }).toStrictEqual({
      otherBuilder: "app.not_found",
      user: "role.forbidden",
      staff: "role.forbidden",
      unpublished: "version.unpublished",
      unknown: "app.version_not_found",
      othersVersion: "app.version_not_found",
      htmlAsPng: "app.picture_invalid",
      svgAsPng: "app.picture_invalid",
      gif: "app.picture_invalid",
      oversized: "app.picture_invalid",
      tooWide: "app.picture_invalid",
      noPixels: "app.picture_invalid",
      cutShort: "app.picture_invalid",
      overview: null,
      read: guardedAnswer(404),
      atLimits: "ok",
    });
  });

  it("is replaced when set again, each time audited, and served as its bytes' type to whoever may open the App alone", async () => {
    const [owner, otherBuilder, user, outsider] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const staff = await staffApi();
    const app = await liveApp(owner, user);
    await liveApp(otherBuilder);
    const path = appPicturePath(app, 1);

    let paths: string[] = [];
    const events = await auditedDuring(async () => {
      paths = [
        await owner.api.apps.setVersionPicture(app, 1, realPng),
        await owner.api.apps.setVersionPicture(app, 1, realWebp),
      ];
    });

    expect({
      paths,
      // Its version, type and size: never its bytes.
      audited: events
        .filter(({ action }) => action === "app.version.picture_set")
        .map(({ target, detail }) => [
          target?.id,
          detail.version,
          detail.type,
          detail.bytes,
        ]),
      owner: await served(path, owner.session),
      user: await served(path, user.session),
      // No role in it: as for an App that isn't there.
      outsider: await served(path, outsider.session),
      otherBuilder: await served(path, otherBuilder.session),
      staff: await served(path, staff.session),
      nobody: await served(path),
      // A version without one, and an App that isn't there.
      noPicture: await served(appPicturePath(app, 2), owner.session),
      noApp: await served(
        appPicturePath(crypto.randomUUID(), 1),
        owner.session
      ),
    }).toStrictEqual({
      paths: [path, path],
      audited: [
        [app, 1, "image/png", realPng.byteLength],
        [app, 1, "image/webp", realWebp.byteLength],
      ],
      owner: pictureAnswer("image/webp", realWebp),
      user: pictureAnswer("image/webp", realWebp),
      outsider: guardedAnswer(404),
      otherBuilder: guardedAnswer(404),
      staff: guardedAnswer(401),
      nobody: guardedAnswer(401),
      noPicture: guardedAnswer(404),
      noApp: guardedAnswer(404),
    });
  });

  it("is the overview's only while its version is current, never an older version's in its place", async () => {
    const [owner, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const app = await liveApp(owner, user);
    const before = await overviewPicture(user, app);
    await owner.api.apps.setVersionPicture(app, 1, realPng);
    const set = await overviewPicture(user, app);
    await commitApp(owner.api, app, { "README.md": "Two.\n" });
    await published(app);
    const moved = await overviewPicture(user, app);

    expect({ before, set, moved }).toStrictEqual({
      before: null,
      set: appPicturePath(app, 1),
      // The current version has none: the card shows the App's tile.
      moved: null,
    });
    // The older version's is still read where it is.
    await expect(
      served(appPicturePath(app, 1), user.session)
    ).resolves.toStrictEqual(pictureAnswer("image/png", realPng));
  });
});
