import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import type {
  BrainSourceRef,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
import { uploadMaxBytes } from "@grasp-os/shared/uploads";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { eraseSource } from "../src/brain-next.ts";
import { brainUploads, teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { allEvents } from "./audit-events.ts";
import { textOf } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// Files uploaded straight into the Brain on Brain › Sources (GRA-1824),
// through core's RPC (`session.brainSources`), from the threat model on
// the issue: who may read an upload is only its uploader, a team they are
// in, or everyone, as they choose, and never more; leaving a team hides
// its uploads from the next question on; an upload someone may not read
// answers exactly as one that doesn't exist, whatever they ask of it; a
// new version is its uploader's alone and keeps its readers; a delete is
// its uploader's, or an admin's for a shared one, and erases it for good
// before core forgets it, so a failed erasure leaves it to delete again
// and an add after the erasure is refused; the audit log names IDs, never
// the file's name or words. Checks read what the person reads (a version,
// a search), which hold whichever store keeps what only they may read.

const idp = mockIdp();

/** Signing people in and reading files can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A word no other test's uploads hold, without a digit. */
const word = (): string =>
  `w${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 10)}`;

/** WebVTT captions saying `text`: a file the extractor reads. */
const captions = (text: string): Uint8Array =>
  new TextEncoder().encode(
    `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${text}\n`
  );

/** A file named `name` that says `text`. */
const fileOf = (text: string, name = `Notes ${word()}.vtt`) => ({
  name,
  bytes: captions(text),
});

const me: BrainUploadReaders = { kind: "me" };
const everyone: BrainUploadReaders = { kind: "everyone" };
const teamReaders = (teamId: string): BrainUploadReaders => ({
  kind: "team",
  teamId,
});

const teamOf = async (...members: Person[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${teamId}`,
    organizationId,
    createdAt: new Date(),
  });
  for (const { userId } of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

const leave = async (teamId: string, { userId }: Person): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** What `person` finds searching for `asked`: each passage's source id. */
const found = async (person: Person, asked: string): Promise<string[]> => {
  const { items } = await person.api.brainSources.search(asked);
  return items.map(({ source }) => source.id);
};

/** The text of `version` of `source` as `person` reads it: null if not. */
const readAs = async (
  person: Person,
  source: BrainSourceRef,
  version = 1
): Promise<string | null> => {
  const read = await person.api.brainSources.read(source, version);
  return read?.text ?? null;
};

/** What `call` answered, or the code it was refused with. */
const outcome = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { value: await call() };
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : String(error);
    return { refused: code };
  }
};

/** Every way `person` can ask of the upload `uploadId`, each one's answer. */
const askedOf = async (person: Person, uploadId: string) => ({
  info: await person.api.brainSources.uploadOf(uploadId),
  version: await outcome(
    async () =>
      await person.api.brainSources.uploadVersion(uploadId, fileOf("Again"))
  ),
  deleted: await outcome(async () => {
    await person.api.brainSources.deleteUpload(uploadId);
  }),
});

/** Each audit event of the upload `uploadId`, by action, in order. */
const eventsOf = async (uploadId: string) => {
  const events = await allEvents();
  return events.filter(({ target }) => target?.id === uploadId);
};

/** The actions of the audit events of the upload `uploadId`, in order. */
const actionsOf = async (uploadId: string): Promise<string[]> => {
  const events = await eventsOf(uploadId);
  return events.map(({ action }) => action);
};

/** The store that holds what more than one person may read. */
const sharedStore = () => env.BRAIN_STORE.getByName("brain");

/** Has the shared store's next write to its bucket fail. */
const failNextBucketPut = async (): Promise<void> => {
  await runInDurableObject(sharedStore(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_OBJECTS: {
        get: async (key: string) => await bucket.get(key),
        list: async (options: R2ListOptions) => await bucket.list(options),
        delete: async (keys: string | string[]) => {
          await bucket.delete(keys);
        },
        put: async () => {
          Reflect.set(instance, "env", objectEnv);
          await Promise.resolve();
          throw new Error("R2 failed, by the test");
        },
      },
    });
  });
};

describe("uploading a file straight into the Brain", () => {
  it(
    "keeps an upload for only me to its uploader: nobody else, an admin included, reads, finds or acts on it",
    slow,
    async () => {
      const [uploader, other, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const secret = word();
      const { source, version } = await uploader.api.brainSources.upload(
        fileOf(`Salary review ${secret}`, "Salary.vtt"),
        me
      );
      const missing = crypto.randomUUID();

      expect({
        version,
        own: {
          found: await found(uploader, secret),
          read: await readAs(uploader, source),
          info: await uploader.api.brainSources.uploadOf(source.id),
        },
        other: {
          found: await found(other, secret),
          read: await readAs(other, source),
          asked: await askedOf(other, source.id),
        },
        admin: {
          found: await found(admin, secret),
          read: await readAs(admin, source),
          asked: await askedOf(admin, source.id),
        },
      }).toStrictEqual({
        version: 1,
        own: {
          found: [source.id],
          read: `Salary.vtt\n\n## 0:00\n\n(0:00) Salary review ${secret}`,
          info: {
            source,
            readers: me,
            mayAddVersion: true,
            mayDelete: true,
          },
        },
        other: {
          found: [],
          read: null,
          asked: await askedOf(other, missing),
        },
        admin: {
          found: [],
          read: null,
          asked: await askedOf(admin, missing),
        },
      });
    }
  );

  it(
    "keeps an upload for only me in its uploader's own store, lists it among their sources, and deletes it from there",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const { source } = await uploader.api.brainSources.upload(
        fileOf("A note to myself"),
        me
      );
      const key = `upload:${source.id}`;
      const namespace = inJurisdiction(env, env.BRAIN_STORE);
      const kept = {
        shared: await brainOf(namespace).keyState(key),
        own: await personalBrainOf(namespace, uploader.userId).keyState(key),
      };
      const listedIds = async (): Promise<string[]> => {
        const { sources } = await uploader.api.brainSources.list();
        return sources.flatMap((each) =>
          each.source.id === source.id
            ? [`${each.source.id} ${each.personal}`]
            : []
        );
      };
      const listed = await listedIds();
      // From the list, as the page deletes it: by the source it lists.
      const { sources } = await uploader.api.brainSources.list();
      const fromList = sources.find((each) => each.source.id === source.id);
      await uploader.api.brainSources.deleteUpload(fromList?.source.id ?? "");

      expect({
        kept,
        listed,
        afterDelete: await listedIds(),
        ownAfter: await personalBrainOf(namespace, uploader.userId).keyState(
          key
        ),
      }).toStrictEqual({
        kept: { shared: "free", own: "held" },
        listed: [`${source.id} true`],
        afterDelete: [],
        ownAfter: "erased",
      });
    }
  );

  it(
    "refuses a file with no text, such as a scan without a text layer, and keeps nothing of it",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const response = await env.ASSETS.fetch(
        "https://assets/uploads/scan.pdf"
      );
      const scan = new Uint8Array(await response.arrayBuffer());

      expect({
        refused: await outcome(
          async () =>
            await uploader.api.brainSources.upload(
              { name: "Scan.pdf", bytes: scan },
              me
            )
        ),
        kept: await drizzle(env.DB)
          .select()
          .from(brainUploads)
          .where(eq(brainUploads.uploadedBy, uploader.userId)),
      }).toStrictEqual({
        refused: { refused: "upload.no_text" },
        kept: [],
      });
    }
  );

  it(
    "lets a team's members find a team's upload, and stops once they leave the team, from the next question on",
    slow,
    async () => {
      const [uploader, mate, outsider] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const teamId = await teamOf(uploader, mate);
      const minutes = word();
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Board minutes ${minutes}`),
        teamReaders(teamId)
      );
      const asMember = {
        found: await found(mate, minutes),
        info: await mate.api.brainSources.uploadOf(source.id),
      };
      const outsiderFound = await found(outsider, minutes);
      await leave(teamId, mate);

      expect({
        asMember,
        outsider: outsiderFound,
        afterLeaving: {
          found: await found(mate, minutes),
          read: await readAs(mate, source),
          info: await mate.api.brainSources.uploadOf(source.id),
        },
      }).toStrictEqual({
        asMember: {
          found: [source.id],
          info: {
            source,
            readers: teamReaders(teamId),
            mayAddVersion: false,
            mayDelete: false,
          },
        },
        outsider: [],
        afterLeaving: { found: [], read: null, info: null },
      });
    }
  );

  it(
    "refuses readers that aren't the uploader's to choose, before anything is kept",
    slow,
    async () => {
      const [uploader, other] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const othersTeam = await teamOf(other);
      const leaked = word();
      const upload = async (readers: unknown) =>
        await outcome(
          async () =>
            await uploader.api.brainSources.upload(
              fileOf(`Planted ${leaked}`),
              // SAFETY: what a client outside TypeScript could send.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
              readers as BrainUploadReaders
            )
        );
      const refused = { refused: "brain.upload_readers" };

      expect({
        othersTeam: await upload(teamReaders(othersTeam)),
        noTeam: await upload(teamReaders(crypto.randomUUID())),
        aPerson: await upload({ kind: "owner", personId: other.userId }),
        nobody: await upload({ kind: "none" }),
        foundByOther: await found(other, leaked),
        foundByUploader: await found(uploader, leaked),
        kept: await drizzle(env.DB)
          .select()
          .from(brainUploads)
          .where(eq(brainUploads.uploadedBy, uploader.userId)),
      }).toStrictEqual({
        othersTeam: refused,
        noTeam: refused,
        aPerson: refused,
        nobody: refused,
        foundByOther: [],
        foundByUploader: [],
        kept: [],
      });
    }
  );

  it(
    "refuses a file too large or not what its name says, and one without text",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const upload = async (file: { name: string; bytes: Uint8Array }) =>
        await outcome(
          async () => await uploader.api.brainSources.upload(file, me)
        );

      expect({
        tooLarge: await upload({
          name: "big.vtt",
          bytes: new Uint8Array(uploadMaxBytes + 1).fill(0x41),
        }),
        notCaptions: await upload({
          name: "notes.vtt",
          bytes: new TextEncoder().encode("Just text"),
        }),
        noType: await upload({ name: "notes.txt", bytes: captions("Hello") }),
        noText: await upload({
          name: "empty.vtt",
          bytes: new TextEncoder().encode("WEBVTT\n"),
        }),
      }).toStrictEqual({
        tooLarge: { refused: "upload.too_large" },
        notCaptions: { refused: "upload.unsupported" },
        noType: { refused: "upload.unsupported" },
        noText: { refused: "upload.no_text" },
      });
    }
  );

  it(
    "adds the uploader's next version for the same readers, keeps the one before as history, and lets nobody else add one",
    slow,
    async () => {
      const [uploader, other] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const [first, second] = [word(), word()];
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Handbook ${first}`, "Handbook.vtt"),
        everyone
      );
      const next = await uploader.api.brainSources.uploadVersion(
        source.id,
        fileOf(`Handbook ${second}`, "Handbook 2.vtt")
      );

      expect({
        next,
        current: await found(other, second),
        replaced: await found(other, first),
        history: await readAs(other, source, 1),
        named: await found(other, "Handbook 2.vtt"),
        info: await other.api.brainSources.uploadOf(source.id),
        byOther: await outcome(
          async () =>
            await other.api.brainSources.uploadVersion(
              source.id,
              fileOf("Overwritten")
            )
        ),
      }).toStrictEqual({
        next: { source, version: 2 },
        current: [source.id],
        replaced: [],
        history: `Handbook.vtt\n\n## 0:00\n\n(0:00) Handbook ${first}`,
        named: [source.id],
        info: {
          source,
          readers: everyone,
          mayAddVersion: false,
          mayDelete: false,
        },
        byOther: { refused: "brain.upload_not_allowed" },
      });
    }
  );

  it(
    "lets an admin delete a shared upload, erasing it for everyone, and the uploader delete their own",
    slow,
    async () => {
      const [uploader, other, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const [shared, own] = [word(), word()];
      const sharedUpload = await uploader.api.brainSources.upload(
        fileOf(`Price list ${shared}`),
        everyone
      );
      const ownUpload = await uploader.api.brainSources.upload(
        fileOf(`Diary ${own}`),
        me
      );
      const adminSees = await admin.api.brainSources.uploadOf(
        sharedUpload.source.id
      );
      await admin.api.brainSources.deleteUpload(sharedUpload.source.id);
      await uploader.api.brainSources.deleteUpload(ownUpload.source.id);

      expect({
        adminSees: adminSees?.mayDelete,
        shared: {
          found: [await found(other, shared), await found(uploader, shared)],
          read: await readAs(uploader, sharedUpload.source),
          info: await uploader.api.brainSources.uploadOf(
            sharedUpload.source.id
          ),
        },
        own: {
          found: await found(uploader, own),
          read: await readAs(uploader, ownUpload.source),
        },
        again: await outcome(async () => {
          await uploader.api.brainSources.deleteUpload(ownUpload.source.id);
        }),
      }).toStrictEqual({
        adminSees: true,
        shared: { found: [[], []], read: null, info: null },
        own: { found: [], read: null },
        again: { refused: "brain.upload_not_found" },
      });
    }
  );

  it(
    "leaves an upload whose erasure failed as it was, to delete again",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const teamId = await teamOf(uploader);
      const kept = word();
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Contract ${kept}`),
        teamReaders(teamId)
      );
      await failNextBucketPut();

      const failed = await outcome(async () => {
        await uploader.api.brainSources.deleteUpload(source.id);
      });
      const afterFailure = await uploader.api.brainSources.uploadOf(source.id);
      await uploader.api.brainSources.deleteUpload(source.id);

      expect({
        failed,
        afterFailure: afterFailure?.source,
        afterRetry: {
          info: await uploader.api.brainSources.uploadOf(source.id),
          found: await found(uploader, kept),
        },
        actions: await actionsOf(source.id),
      }).toStrictEqual({
        failed: { refused: "internal.unexpected" },
        afterFailure: source,
        afterRetry: { info: null, found: [] },
        actions: [
          "brain.upload.added",
          "brain.upload.delete_failed",
          "brain.upload.deleted",
        ],
      });
    }
  );

  it(
    "refuses a version added after its upload was erased, and forgets the upload with the refusal",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const late = word();
      const { source } = await uploader.api.brainSources.upload(
        fileOf("Draft"),
        everyone
      );
      // Erased, but core never forgot the upload: as a delete whose
      // erasure returned and whose forgetting failed, or a version whose
      // file was read while the delete ran.
      await eraseSource(env, {
        source,
        readers: { kind: "everyone" },
        reason: "deleted",
      });

      const added = await outcome(
        async () =>
          await uploader.api.brainSources.uploadVersion(
            source.id,
            fileOf(`Late ${late}`)
          )
      );
      const foundLate = await found(uploader, late);

      expect({
        added,
        foundLate,
        info: await uploader.api.brainSources.uploadOf(source.id),
        deletedAgain: await outcome(async () => {
          await uploader.api.brainSources.deleteUpload(source.id);
        }),
        actions: await actionsOf(source.id),
      }).toStrictEqual({
        added: { refused: "brain.upload_deleted" },
        foundLate: [],
        info: null,
        deletedAgain: { refused: "brain.upload_not_found" },
        actions: ["brain.upload.added", "brain.upload.refused"],
      });
    }
  );

  it(
    "audits each upload by IDs, never by its file's name or words",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const teamId = await teamOf(uploader);
      const [inName, inText] = [word(), word()];
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Merger plan ${inText}`, `Merger ${inName}.vtt`),
        teamReaders(teamId)
      );
      await uploader.api.brainSources.deleteUpload(source.id);
      const events = await eventsOf(source.id);

      expect({
        actions: events.map(({ action }) => action),
        added: events[0]?.detail,
        deleted: events[1]?.detail,
        leaked: [inName, inText].filter((each) =>
          textOf(events).includes(each)
        ),
      }).toStrictEqual({
        actions: ["brain.upload.added", "brain.upload.deleted"],
        added: {
          readers: "team",
          teamId,
          mediaType: "text/vtt",
          bytes: captions(`Merger plan ${inText}`).byteLength,
          version: 1,
        },
        deleted: { readers: "team" },
        leaked: [],
      });
    }
  );
});
