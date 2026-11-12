import { describe, expect, it } from "vite-plus/test";

import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// An App's own link (app-own-links.ts). These tests start from its threat
// model: someone opening through a link an App they may not use, or one
// that isn't live; a link standing for one of the workspace's pages;
// two Apps with one link; a link changed by someone who doesn't build the
// App, or by Grasp staff; and a change nobody audited.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A builder's App, shared with `user` to use, nothing of it live yet. */
const appOf = async (builder: Person, user?: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  if (user !== undefined) {
    await builder.api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  }
  return id;
};

/** A link no other test has. */
const newLink = (): string => `invoices-${unique()}`;

/** What `person` gets opening `link`: the App's id, or core's refusal. */
const opening = async (person: Person, link: string): Promise<string> => {
  let app: string | undefined;
  const result = await outcome(
    (async () => {
      ({ app } = await person.api.apps.openLink(link));
    })()
  );
  return app ?? result;
};

describe("an App's link", () => {
  it("opens a live App for those who may use it, and nothing else for anyone, as a link nobody has", async () => {
    const [builder, user, outsider] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const app = await appOf(builder, user);
    const link = newLink();
    const set = await builder.api.apps.setLink(app, link);

    const notLive = await Promise.all([
      opening(builder, link),
      opening(user, link),
    ]);
    await published(app);
    const live = await Promise.all([
      opening(builder, link),
      opening(user, link),
      opening(outsider, link),
      opening(user, newLink()),
      opening(user, "Not A Link!"),
    ]);
    await builder.api.apps.archive(app);
    const archived = await Promise.all([
      opening(builder, link),
      opening(user, link),
    ]);
    await builder.api.apps.restore(app);
    const restored = await opening(user, link);

    expect({
      set: set.link,
      notLive,
      live,
      archived,
      restored,
    }).toStrictEqual({
      set: link,
      // Not even its builders: nothing live has a link to open yet.
      notLive: ["app.not_found", "app.not_found"],
      live: [
        app,
        app,
        // No role in it: as for an App that isn't there.
        "app.not_found",
        "app.not_found",
        "app.not_found",
      ],
      archived: ["app.not_found", "app.not_found"],
      restored: app,
    });
  });

  it("is set only by the App's builders, never staff, once per link, in the form a link takes, audited with the change", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const [app, other] = await Promise.all([
      appOf(builder, user),
      appOf(builder),
    ]);
    const link = newLink();
    const moved = newLink();
    await published(app);

    const refused = await Promise.all([
      outcome(user.api.apps.setLink(app, link)),
      outcome(staff.apps.setLink(app, link)),
      outcome(builder.api.apps.setLink(app, "settings")),
      outcome(builder.api.apps.setLink(app, "Two--Dashes")),
      outcome(builder.api.apps.setLink(app, "x".repeat(49))),
    ]);
    const changes = await auditedDuring(async () => {
      await builder.api.apps.setLink(app, link);
      // Setting the link it has already changes and records nothing.
      await builder.api.apps.setLink(app, link);
      await builder.api.apps.setLink(app, moved);
      await builder.api.apps.setLink(app, null);
    });
    await builder.api.apps.setLink(other, link);
    const taken = await outcome(builder.api.apps.setLink(app, link));
    const kept = await opening(user, moved);
    await builder.api.apps.archive(other);
    const ofArchived = await outcome(builder.api.apps.setLink(other, null));
    // Removed, an App no longer holds its link.
    await builder.api.apps.remove(other);
    await builder.api.apps.setLink(app, link);
    const freed = await opening(user, link);

    expect({
      refused,
      changes: changes
        .filter(({ target }) => target?.id === app)
        .map(({ action, actor, detail }) => ({ action, actor, detail })),
      taken,
      kept,
      ofArchived,
      freed,
    }).toStrictEqual({
      refused: [
        "role.forbidden",
        "role.forbidden",
        "app.invalid_link",
        "app.invalid_link",
        "app.invalid_link",
      ],
      changes: [
        {
          action: "app.link_set",
          actor: { type: "person", userId: builder.userId },
          detail: { from: null, to: link },
        },
        {
          action: "app.link_set",
          actor: { type: "person", userId: builder.userId },
          detail: { from: link, to: moved },
        },
        {
          action: "app.link_removed",
          actor: { type: "person", userId: builder.userId },
          detail: { from: moved, to: null },
        },
      ],
      taken: "app.link_taken",
      // Taken off, a link opens nothing.
      kept: "app.not_found",
      ofArchived: "app.archived",
      freed: app,
    });
  });
});
