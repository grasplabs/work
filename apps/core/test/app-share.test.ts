import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appDraftKind } from "../src/apps.ts";
import { readDraft, saveDraft } from "../src/drafts.ts";
import { agentWriting } from "./draft-writers.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Share with your team, as the App's workspace does it (the web's
// share sheet): the builder's changes published (`drafts.publish`),
// then the App shared with each team chosen (`apps.members.add`), in one
// step for the person; Undo takes each new share back
// (`apps.members.remove`) and, when a version was live before, makes it
// live again over the one just published (`versions.rollback`). What
// could go wrong: the team not reaching what was shared, or still
// reaching it after Undo; Undo leaving the shared version live, or
// taking back a share that was there before.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A page that says `word`. */
const pageSaying = (word: string): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Desk = () => <main>${word}</main>;

export const Route = createFileRoute("/")({ component: Desk });
`,
});

/**
 * Writes `changes` into `app`'s draft as the agent of `person`'s chat for
 * the App writes them; the draft's revision after it.
 */
const writeDraft = async (
  person: Person,
  app: AppId,
  changes: Record<string, string>
): Promise<number> => {
  const { id: chatId } = await person.api.chats.forApp(app);
  const written = await saveDraft(
    env,
    appDraftKind,

    app,
    await readDraft(env, { kind: "app", id: app }),
    { changes, unchanged: [] },
    await agentWriting(person, chatId)
  );
  return written.revision;
};

/**
 * What Share does: publishes the draft at `revision` while it has changes
 * nobody else has, then shares with `teams` not yet sharing it.
 */
const share = async (
  builder: Person,
  app: AppId,
  revision: number,
  teams: readonly string[]
) => {
  const { currentVersion: before } = await builder.api.apps.get(app);
  const members = await builder.api.apps.members.list(app);
  const shared = new Set(members.map(({ id }) => id));
  const { changed } = await builder.api.drafts.get({ kind: "app", id: app });
  let published = before;
  if (changed.length > 0) {
    ({ version: published } = await builder.api.drafts.publish(
      { kind: "app", id: app },
      revision,
      "Shared"
    ));
  }
  const added = teams.filter((team) => !shared.has(team));
  for (const team of added) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await builder.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "user",
    });
  }
  return { before, published, added };
};

/** What Undo does: takes the new shares back, and the version before live again. */
const undo = async (
  builder: Person,
  app: AppId,
  { before, published, added }: Awaited<ReturnType<typeof share>>
): Promise<void> => {
  for (const team of added) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await builder.api.apps.members.remove(app, { type: "team", id: team });
  }
  if (before !== null && published !== null && published !== before) {
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    await builder.api.versions.rollback(
      { kind: "app", id: app },
      before,
      revision,
      published
    );
  }
};

/** Whether `person` opens `app`, and the version they would open. */
const seen = async (person: Person, app: AppId) => {
  const opened = await outcome(person.api.apps.get(app));
  if (opened !== "ok") {
    return opened;
  }
  const { currentVersion } = await person.api.apps.get(app);
  return currentVersion;
};

describe("sharing an App with a team", { timeout: 120_000 }, () => {
  it("publishes and shares in one step, and Undo takes both back", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const [member, outsider] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const team = await newTeam(admin, [member]);
    const { id } = await builder.api.apps.create({ name: `Desk ${unique()}` });
    const app = appIdSchema.parse(id);

    // The first share: nothing was live, nor shared, before.
    const first = await share(
      builder,
      app,
      await writeDraft(builder, app, pageSaying("One")),
      [team]
    );
    const afterFirst = {
      member: await seen(member, app),
      outsider: await seen(outsider, app),
    };
    await undo(builder, app, first);
    const undoneFirst = await seen(member, app);

    // Shared again, with nothing new to publish, then changes shared
    // later: the team stays, and Undo makes the version before live again.
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    await share(builder, app, revision, [team]);
    const later = await share(
      builder,
      app,
      await writeDraft(builder, app, pageSaying("Two")),
      [team]
    );
    const afterLater = await seen(member, app);
    await undo(builder, app, later);

    expect({
      first: { added: first.added, ...afterFirst },
      undoneFirst,
      later: { added: later.added, live: afterLater },
      undoneLater: await seen(member, app),
    }).toStrictEqual({
      first: {
        added: [team],
        member: first.published,
        outsider: "app.not_found",
      },
      undoneFirst: "app.not_found",
      later: { added: [], live: later.published },
      undoneLater: first.published,
    });
  });
});
