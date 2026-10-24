import { linkChannel } from "@grasp-os/sdk/host";
import { appLinksPath } from "@grasp-os/shared/app-link-limits";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { screenPersonHeader } from "@grasp-os/shared/screen-limits";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { screenLeaseHeader } from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles } from "./notes-client-app.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// An App's external links (spec 10.7.7, 32.3), through core's link channel
// as a running screen's page reaches it (app-link-route.ts): which URL may
// open through the App's `resource.links` declaration, for whom, through
// which build, and the record of each opened. From the threat model on
// GRA-762: adversarial URLs (userinfo, Unicode names and punycode, ports,
// trailing dots, schemes, private networks, redirects through an allowed
// origin), a revoked permission or build, a restricted App, another site
// or another person asking, and what the record keeps.

const idp = mockIdp();

const declared = [
  "https://help.example.com",
  "https://docs.example.com:8443",
  "https://xn--bcher-kva.example",
];

/** The Notes App, its screen declaring `help` links and `attachments` files. */
const linkedFiles = (origins: readonly string[] | null = declared) => ({
  ...notesFiles,
  "app.ts": `import { app, resource } from "@grasp-os/sdk";
import { big, create, echo, get, list, remove, stamp, update } from "./operations/notes.ts";
import schema from "./schema.ts";

${origins === null ? "" : `export const help = resource.links("help", { origins: ${JSON.stringify(origins)} });\n`}
export const attachments = resource.files("attachments", { operations: ["read"] });

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { list, get, create, update, remove, echo, stamp, big } },
  internalOperations: {},
  screens: [],
  uses: [${origins === null ? "" : "help, "}attachments],
});
`,
});

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** Commits `files` to `app`, makes it current and has an admin approve its build. */
const released = async (
  builder: Person,
  admin: Person,
  app: string,
  files: Record<string, string>
): Promise<number> => {
  const { version } = await builder.api.apps.files.commit(app, files, "Next");
  await builder.api.apps.versions.setCurrent(app, version);
  const review = await admin.api.screenTrust.review(app);
  await admin.api.screenTrust.approve(app, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  return version;
};

/**
 * `person`'s open screen of `app`: its lease, the page's link channel,
 * and raw requests of the channel as a page that doesn't follow the
 * protocol would send them.
 */
const screenOf = async (person: Person, app: string) => {
  const { lease } = await person.api.screens.open(app, "notes");
  const fetch = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    // The page's own origin, unless the request says otherwise: `none`
    // sends none.
    if (!headers.has("origin")) {
      headers.set("origin", clientOrigin);
    } else if (headers.get("origin") === "none") {
      headers.delete("origin");
    }
    headers.set("cookie", person.session);
    if (!headers.has(screenPersonHeader)) {
      headers.set(screenPersonHeader, person.userId);
    }
    return await routed(path, { ...init, headers });
  };
  const channel = linkChannel({
    app,
    lease,
    person: async () => await Promise.resolve(person.userId),
    fetch,
  });
  const raw = async (
    resource: string,
    kind: string,
    body: unknown,
    headers: Record<string, string> = {},
    onApp: string = app
  ) => {
    const response = await fetch(
      `${appLinksPath}/${onApp}/${resource}/${kind}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [screenLeaseHeader]: lease,
          ...headers,
        },
        body: JSON.stringify(body),
      }
    );
    const answer: unknown = await response.json();
    return {
      status: response.status,
      code:
        typeof answer === "object" && answer !== null && "code" in answer
          ? answer.code
          : undefined,
    };
  };
  return { lease, channel, raw };
};

/**
 * A builder's App declaring links, current, approved and published (a
 * draft is its builders' alone), open in their screen.
 */
const openedApp = async (files = linkedFiles()) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const version = await released(builder, admin, id, files);
  await builder.api.apps.publish(id);
  return {
    app: id,
    version,
    builder,
    admin,
    screen: await screenOf(builder, id),
  };
};

/** The code `promise` was refused with, or "opened". */
const outcomeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return "opened";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : "unknown";
  }
};

/** The links the audit log has opened of `app`, each as its detail says. */
const linksOpened = async (
  app: string
): Promise<{ actor: unknown; detail: unknown }[]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) => action === "app.link_opened" && target?.id === app
    )
    .map(({ actor, detail }) => ({ actor, detail }));
};

describe("an App's external links", { timeout: 120_000 }, () => {
  it("opens a URL its declaration allows, as core parsed it, and records the open without its path", async () => {
    const { app, version, builder, screen } = await openedApp();
    const url = "https://help.example.com/guide?customer=ada#billing";

    const checked = await screen.channel.check("help", url);
    const opened = await screen.channel.open("help", url, "activation");

    expect({
      checked,
      opened,
      recorded: await linksOpened(app),
    }).toStrictEqual({
      checked: {
        url,
        origin: "https://help.example.com",
        confirm: false,
      },
      opened: { url, origin: "https://help.example.com", confirm: false },
      recorded: [
        {
          actor: { type: "person", userId: builder.userId },
          detail: {
            resource: "help",
            origin: "https://help.example.com",
            version,
            intent: "activation",
            restricted: false,
          },
        },
      ],
    });
  });

  it("decides on the URL's own origin, whatever its text says", async () => {
    const { app, screen } = await openedApp();
    // A sample of each kind, within one person's burst of requests: the
    // pure rules are app-link-limits.test.ts's, case by case.
    const cases = {
      userinfoBefore: "https://evil.test@help.example.com/",
      emptyUserinfo: "https://:@help.example.com/",
      lookAlike: "https://help.exаmple.com/",
      defaultPort: "https://help.example.com:443/x",
      otherPort: "https://help.example.com:8443/x",
      declaredPort: "https://docs.example.com:8443/api",
      trailingDot: "https://help.example.com./",
      script: ["javascript", "alert(1)"].join(":"),
      plainHttp: "http://help.example.com/",
      backslashes: "https:\\\\help.example.com\\",
      privateAddress: "https://10.0.0.1/",
      tooLong: `https://help.example.com/${"a".repeat(2048)}`,
    };
    const decided: Record<string, unknown> = {};
    for (const [name, url] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as a person clicks
      decided[name] = await outcomeOf(screen.channel.check("help", url));
    }
    const punycode = await screen.channel.check(
      "help",
      "https://bücher.example/katalog"
    );

    expect({
      decided,
      punycode,
      recorded: await linksOpened(app),
    }).toStrictEqual({
      decided: {
        userinfoBefore: "link.not_allowed",
        emptyUserinfo: "link.not_allowed",
        lookAlike: "link.not_allowed",
        defaultPort: "opened",
        otherPort: "link.not_allowed",
        declaredPort: "opened",
        trailingDot: "link.not_allowed",
        script: "link.not_allowed",
        plainHttp: "link.not_allowed",
        backslashes: "link.invalid",
        privateAddress: "link.not_allowed",
        tooLong: "link.invalid",
      },
      // The ASCII origin, as the confirmation names it.
      punycode: {
        url: "https://xn--bcher-kva.example/katalog",
        origin: "https://xn--bcher-kva.example",
        confirm: false,
      },
      // Checking records nothing.
      recorded: [],
    });
  });

  it("opens a redirect through an allowed origin as given, and fetches nothing", async () => {
    const { screen } = await openedApp();
    const fetched = vi.spyOn(globalThis, "fetch");
    const url = "https://help.example.com/out?to=https://evil.test/";
    try {
      const opened = await screen.channel.open("help", url, "confirmation");
      expect({
        opened: opened.url,
        fetched: fetched.mock.calls.filter(([target]) =>
          String(target instanceof Request ? target.url : target).includes(
            "example.com"
          )
        ).length,
      }).toStrictEqual({ opened: url, fetched: 0 });
    } finally {
      fetched.mockRestore();
    }
  });

  it("opens nothing through a resource that isn't a links declaration, or isn't declared", async () => {
    const { screen } = await openedApp();
    const url = "https://help.example.com/";

    expect({
      files: await outcomeOf(screen.channel.check("attachments", url)),
      none: await outcomeOf(screen.channel.check("elsewhere", url)),
    }).toStrictEqual({ files: "link.not_allowed", none: "link.not_allowed" });
  });

  it("opens nothing once its version no longer declares the links, for a person who lost their role, or for a build no longer approved", async () => {
    const { app, builder, admin, screen } = await openedApp();
    const colleague = await personApi("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
    const theirs = await screenOf(colleague, app);
    const url = "https://help.example.com/";
    const before = await outcomeOf(theirs.channel.check("help", url));
    await builder.api.apps.members.remove(app, {
      type: "person",
      id: colleague.userId,
    });
    const roleLost = await outcomeOf(theirs.channel.check("help", url));

    // The first screen's build, its approval taken back.
    const review = await admin.api.screenTrust.review(app);
    await Promise.all(
      builtArtifacts(review.screens).map(async (artifact) => {
        await admin.api.screenTrust.revoke(app, artifact);
      })
    );
    const buildRevoked = await outcomeOf(screen.channel.check("help", url));
    // A version without the declaration, approved and opened.
    await released(builder, admin, app, linkedFiles(null));
    const reopened = await screenOf(builder, app);
    const undeclared = await outcomeOf(reopened.channel.check("help", url));

    expect({
      before,
      roleLost: /^(?:app\.not_found|permission\.)/u.test(String(roleLost)),
      undeclared,
      buildRevoked: String(buildRevoked).startsWith("screen."),
    }).toStrictEqual({
      before: "opened",
      roleLost: true,
      undeclared: "link.not_allowed",
      buildRevoked: true,
    });
  });

  it("opens nothing through a release revoked since its screen opened", async () => {
    const { app, version, screen } = await openedApp();
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(app), version },
      "Leaks data"
    );

    await expect(
      outcomeOf(
        screen.channel.open("help", "https://help.example.com/", "activation")
      )
    ).resolves.not.toBe("opened");
  });

  it("opens a restricted App's links only once the person confirmed each", async () => {
    const { app, screen } = await openedApp();
    await appHost(env, appIdSchema.parse(app)).restrict();
    const url = "https://help.example.com/";

    const checked = await screen.channel.check("help", url);
    const clicked = await outcomeOf(
      screen.channel.open("help", url, "activation")
    );
    const confirmed = await screen.channel.open("help", url, "confirmation");

    const recorded = await linksOpened(app);
    expect({
      confirm: checked.confirm,
      clicked,
      confirmed: confirmed.url,
      recorded: recorded.map(({ detail }) => detail),
    }).toStrictEqual({
      confirm: true,
      clicked: "link.confirmation_required",
      confirmed: url,
      recorded: [
        expect.objectContaining({ intent: "confirmation", restricted: true }),
      ],
    });
  });

  it("answers only a screen of the person's own, from the deployment's own page", async () => {
    const { builder, screen } = await openedApp();
    const body = { url: "https://help.example.com/" };

    expect({
      noLease: await screen.raw("help", "check", body, {
        [screenLeaseHeader]: "",
      }),
      forgedLease: await screen.raw("help", "check", body, {
        [screenLeaseHeader]: `${screen.lease.split(".")[0]}.AAAA`,
      }),
      crossSite: await screen.raw("help", "check", body, {
        "sec-fetch-site": "cross-site",
      }),
      someoneElse: await screen.raw("help", "check", body, {
        [screenPersonHeader]: `${builder.userId}x`,
      }),
      openWithoutIntent: await screen.raw("help", "open", body),
      unknownIntent: await screen.raw("help", "open", {
        ...body,
        intent: "wish",
      }),
      extraField: await screen.raw("help", "check", {
        ...body,
        target: "_top",
      }),
      otherOrigin: await screen.raw("help", "check", body, {
        origin: "https://evil.test",
      }),
      noOrigin: await screen.raw("help", "check", body, { origin: "none" }),
      ownPage: await screen.raw("help", "check", body),
    }).toStrictEqual({
      noLease: { status: 403, code: "request.forbidden" },
      forgedLease: { status: 403, code: "request.forbidden" },
      crossSite: { status: 403, code: "request.forbidden" },
      someoneElse: { status: 401, code: "auth.principal_changed" },
      openWithoutIntent: { status: 422, code: "link.invalid" },
      unknownIntent: { status: 422, code: "link.invalid" },
      extraField: { status: 422, code: "link.invalid" },
      otherOrigin: { status: 403, code: "request.forbidden" },
      noOrigin: { status: 403, code: "request.forbidden" },
      ownPage: { status: 200, code: undefined },
    });
  });

  it("opens nothing through another App's path with this App's lease, though the person may open both", async () => {
    const { builder, admin, screen } = await openedApp();
    const { id: other } = await builder.api.apps.create({ name: "Other" });
    await released(builder, admin, other, linkedFiles());

    await expect(
      screen.raw(
        "help",
        "check",
        { url: "https://help.example.com/" },
        {},
        other
      )
    ).resolves.toStrictEqual({ status: 403, code: "request.forbidden" });
  });

  it("refuses a person's checks past their burst of requests, before reading anything", async () => {
    const { screen } = await openedApp();
    const body = { url: "https://help.example.com/" };
    const statuses: number[] = [];
    // The clock stands still, so no request comes back to the burst while
    // the test sends: on a slow runner, 30 requests take long enough for
    // one to.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, as a loop in a screen sends them
        const { status } = await screen.raw("help", "check", body);
        statuses.push(status);
      }
    } finally {
      vi.useRealTimers();
    }

    expect({
      firstAllowed: statuses[0],
      limited: statuses.includes(429),
      lastLimited: statuses.at(-1),
    }).toStrictEqual({ firstAllowed: 200, limited: true, lastLimited: 429 });
  });
});
