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
import { z } from "zod";

import { organizationId } from "../src/auth/auth.ts";
import { brainExportsPath } from "../src/brain-next-exports.ts";
import { uploadSource } from "../src/brain-next-origins.ts";
import { addSource, eraseSource, workBrain } from "../src/brain-next.ts";
import {
  auditOutboxRejected,
  brainUploads,
  teamMembers,
  teams,
} from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { allEvents } from "./audit-events.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { textOf } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import { callAuth, routed, signedInApi } from "./sign-in.ts";

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

/**
 * What `person` finds searching for `asked` by its words or exactly: each
 * passage's source id. Hits by meaning alone are left out: recall adds
 * the nearest readable passages by meaning, whatever they hold.
 */
const found = async (person: Person, asked: string): Promise<string[]> => {
  const { items } = await person.api.brainSources.search(asked);
  return items.flatMap(({ source, found: how }) =>
    how === "meaning" ? [] : [source.id]
  );
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
      await person.api.brainSources.uploadVersion(
        uploadId,
        fileOf("Again"),
        crypto.randomUUID()
      )
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

/** How many events the drain has set aside as rejected (a conflict, say). */
const rejectedCount = async (): Promise<number> => {
  const rows = await drizzle(env.DB).select().from(auditOutboxRejected);
  return rows.length;
};

/** The rows core keeps of the upload `uploadId`. */
const rowsWith = async (uploadId: string) =>
  await drizzle(env.DB)
    .select()
    .from(brainUploads)
    .where(eq(brainUploads.id, uploadId));

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
        me,
        crypto.randomUUID()
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
        me,
        crypto.randomUUID()
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
      await uploader.api.brainSources.uploadVersion(
        source.id,
        fileOf("Another note", "Diary.vtt"),
        crypto.randomUUID()
      );
      // Its name is theirs alone too: kept in their own store, never here.
      const [row] = await rowsWith(source.id);
      // From the list, as the page deletes it: by the source it lists.
      const { sources } = await uploader.api.brainSources.list();
      const fromList = sources.find((each) => each.source.id === source.id);
      await uploader.api.brainSources.deleteUpload(fromList?.source.id ?? "");

      expect({
        kept,
        listed,
        nameInCore: row?.name,
        afterDelete: await listedIds(),
        ownAfter: await personalBrainOf(namespace, uploader.userId).keyState(
          key
        ),
      }).toStrictEqual({
        kept: { shared: "free", own: "held" },
        listed: [`${source.id} true`],
        nameInCore: null,
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
              me,
              crypto.randomUUID()
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
        teamReaders(teamId),
        crypto.randomUUID()
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
              readers as BrainUploadReaders,
              crypto.randomUUID()
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
          async () =>
            await uploader.api.brainSources.upload(
              file,
              me,
              crypto.randomUUID()
            )
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
        everyone,
        crypto.randomUUID()
      );
      const next = await uploader.api.brainSources.uploadVersion(
        source.id,
        fileOf(`Handbook ${second}`, "Handbook 2.vtt"),
        crypto.randomUUID()
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
              fileOf("Overwritten"),
              crypto.randomUUID()
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
    "keeps a retried new version the version it made, even after a later version, and refuses its id sent again with another file",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Policy ${word()}`, "Policy.vtt"),
        everyone,
        crypto.randomUUID()
      );
      const [second, third] = [word(), word()];
      const secondId = crypto.randomUUID();
      const secondFile = fileOf(`Policy ${second}`, "Policy 2.vtt");
      await uploader.api.brainSources.uploadVersion(
        source.id,
        secondFile,
        secondId
      );
      await uploader.api.brainSources.uploadVersion(
        source.id,
        fileOf(`Policy ${third}`, "Policy 3.vtt"),
        crypto.randomUUID()
      );

      // The second's answer was lost, and the page sends it again.
      const retried = await uploader.api.brainSources.uploadVersion(
        source.id,
        secondFile,
        secondId
      );
      const otherFile = await outcome(
        async () =>
          await uploader.api.brainSources.uploadVersion(
            source.id,
            fileOf(`Policy ${word()}`, "Policy 4.vtt"),
            secondId
          )
      );
      const badIds = [
        await outcome(
          async () =>
            await uploader.api.brainSources.uploadVersion(
              source.id,
              secondFile,
              source.id
            )
        ),
        await outcome(
          async () =>
            await uploader.api.brainSources.uploadVersion(
              source.id,
              secondFile,
              "v2"
            )
        ),
      ];
      const { versions } = await uploader.api.brainSources.versions(source);
      const [row] = await rowsWith(source.id);
      const actions = await actionsOf(source.id);

      expect({
        retried,
        otherFile,
        badIds,
        versions: versions.length,
        current: await found(uploader, third),
        // The retry changed nothing: the current file's name stays, and
        // each version was audited as added once.
        name: row?.name,
        added: actions.filter((action) => action === "brain.upload.added")
          .length,
      }).toStrictEqual({
        retried: { source, version: 2 },
        otherFile: { refused: "brain.upload_other_file" },
        // Its first version's change, and no UUID.
        badIds: [{ refused: "upload.invalid" }, { refused: "upload.invalid" }],
        versions: 3,
        current: [source.id],
        name: "Policy 3.vtt",
        added: 3,
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
        everyone,
        crypto.randomUUID()
      );
      const ownUpload = await uploader.api.brainSources.upload(
        fileOf(`Diary ${own}`),
        me,
        crypto.randomUUID()
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
      const [uploader, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const teamId = await teamOf(uploader);
      const kept = word();
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Contract ${kept}`),
        teamReaders(teamId),
        crypto.randomUUID()
      );
      await failNextBucketPut();

      const failed = await outcome(async () => {
        await admin.api.brainSources.deleteUpload(source.id);
      });
      const afterFailure = await uploader.api.brainSources.uploadOf(source.id);
      await admin.api.brainSources.deleteUpload(source.id);

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
        everyone,
        crypto.randomUUID()
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
            fileOf(`Late ${late}`),
            crypto.randomUUID()
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
      const [uploader, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const teamId = await teamOf(uploader);
      const [inName, inText] = [word(), word()];
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Merger plan ${inText}`, `Merger ${inName}.vtt`),
        teamReaders(teamId),
        crypto.randomUUID()
      );
      await admin.api.brainSources.deleteUpload(source.id);
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

  it(
    "refuses a shared upload's delete to its uploader, changing nothing, and lets an admin outside the team erase it without its text in any reply",
    slow,
    async () => {
      const [uploader, mate, admin, stranger] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const teamId = await teamOf(uploader, mate);
      const secret = word();
      const shared = await uploader.api.brainSources.upload(
        fileOf(`Payroll plan ${secret}`, "Payroll.vtt"),
        teamReaders(teamId),
        crypto.randomUUID()
      );
      const own = await mate.api.brainSources.upload(
        fileOf(`The mate's own ${word()}`, "Mine.vtt"),
        me,
        crypto.randomUUID()
      );
      const missing = crypto.randomUUID();

      const uploaderSees = await uploader.api.brainSources.uploadOf(
        shared.source.id
      );
      const refused = await outcome(async () => {
        await uploader.api.brainSources.deleteUpload(shared.source.id);
      });
      const rowsAfterRefusal = await rowsWith(shared.source.id);
      const afterRefusal = {
        rows: rowsAfterRefusal.length,
        mateFinds: await found(mate, secret),
      };
      const asStranger = await askedOf(stranger, shared.source.id);
      const asAdminOfOwn = await askedOf(admin, own.source.id);
      // The admin isn't in the team: the listing shows it without its
      // name, and never its text.
      const listing = await admin.api.brainSources.sharedUploads();
      const listed = listing.uploads.find(
        ({ source }) => source.id === shared.source.id
      );
      const adminSees = await admin.api.brainSources.uploadOf(shared.source.id);
      await admin.api.brainSources.deleteUpload(shared.source.id);
      const nonAdminListing = await outcome(
        async () => await uploader.api.brainSources.sharedUploads()
      );
      const rowsAfterErase = await rowsWith(shared.source.id);
      const events = await eventsOf(shared.source.id);

      expect({
        uploaderSees: uploaderSees?.mayDelete,
        refused,
        afterRefusal,
        asStranger,
        asAdminOfOwn,
        listed:
          listed === undefined ? undefined : { ...listed, uploadedAt: "" },
        ownListed: listing.uploads.some(
          ({ source }) => source.id === own.source.id
        ),
        adminSees,
        textInReplies: [secret, "Payroll.vtt"].some((said) =>
          textOf([listing, adminSees]).includes(said)
        ),
        afterErase: {
          rows: rowsAfterErase.length,
          mateFinds: await found(mate, secret),
          mateSees: await mate.api.brainSources.uploadOf(shared.source.id),
        },
        nonAdminListing,
        refusedAs: events.find(
          ({ action }) => action === "brain.upload.refused"
        )?.detail,
      }).toStrictEqual({
        uploaderSees: false,
        refused: { refused: "brain.upload_admin_only" },
        afterRefusal: { rows: 1, mateFinds: [shared.source.id] },
        asStranger: await askedOf(stranger, missing),
        asAdminOfOwn: await askedOf(admin, missing),
        listed: {
          source: shared.source,
          name: null,
          readers: teamReaders(teamId),
          teamName: `Team ${teamId}`,
          uploaderName: String(uploader.person.name),
          uploadedAt: "",
        },
        ownListed: false,
        adminSees: {
          source: shared.source,
          readers: teamReaders(teamId),
          mayAddVersion: false,
          mayDelete: true,
        },
        textInReplies: false,
        afterErase: { rows: 0, mateFinds: [], mateSees: null },
        nonAdminListing: { refused: "role.forbidden" },
        refusedAs: { reason: "admin_only", readers: "team" },
      });
    }
  );

  it(
    "audits each version added exactly once, whatever order its adds land in or how often one is retried, and keeps the latest version's name",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      // What the log and the drain held before: a retry sent after its
      // version's event was logged must be a duplicate the log drops,
      // never a conflict (a gap, a rejected row).
      const loggedBefore = await allEvents();
      const rejectedBefore = await rejectedCount();
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`First ${word()}`, "First.vtt"),
        everyone,
        crypto.randomUUID()
      );
      const version = async (
        file: ReturnType<typeof fileOf>,
        versionId = crypto.randomUUID()
      ) =>
        await uploader.api.brainSources.uploadVersion(
          source.id,
          file,
          versionId
        );
      // Two tabs at once: whichever lands second, each is audited.
      await Promise.all([
        version(fileOf(`Alpha ${word()}`, "Alpha.vtt")),
        version(fileOf(`Beta ${word()}`, "Beta.vtt")),
      ]);
      // The Brain takes one whose answer is lost before core writes
      // anything: the text core sends for it, read from a scratch upload.
      const lost = fileOf(`Gamma ${word()}`, "Gamma.vtt");
      const scratch = await uploader.api.brainSources.upload(
        lost,
        everyone,
        crypto.randomUUID()
      );
      const lostId = crypto.randomUUID();
      const landed = await addSource(env, {
        source: uploadSource(source.id),
        change: lostId,
        text: String(await readAs(uploader, scratch.source)),
        readers: { kind: "everyone" },
      });
      // A later version, then the lost one sent again, then the later
      // one sent twice more: each after the log took what came before.
      const laterId = crypto.randomUUID();
      const later = fileOf(`Delta ${word()}`, "Delta.vtt");
      const last = await version(later, laterId);
      await allEvents();
      const retried = await version(lost, lostId);
      await allEvents();
      await version(later, laterId);
      await allEvents();
      await version(later, laterId);
      const events = await eventsOf(source.id);
      const loggedAfter = await allEvents();
      const sinceStart = loggedAfter.slice(loggedBefore.length);
      const rejectedAfter = await rejectedCount();
      const [row] = await rowsWith(source.id);

      expect({
        landed: landed.version,
        last: last.version,
        retried: retried.version,
        added: events
          .filter(({ action }) => action === "brain.upload.added")
          .map(({ detail }) => Number(detail?.version))
          .toSorted((a, b) => a - b),
        name: row?.name,
        version: row?.version,
        gaps: sinceStart.filter(({ action }) => action === "audit.gap").length,
        rejected: rejectedAfter - rejectedBefore,
      }).toStrictEqual({
        landed: 4,
        last: 5,
        retried: 4,
        added: [1, 2, 3, 4, 5],
        name: "Delta.vtt",
        version: 5,
        gaps: 0,
        rejected: 0,
      });
    }
  );

  it(
    "lists a shared upload to an admin by name only if they may read it, and one for a team since removed as that team's still, to open and erase",
    slow,
    async () => {
      const [uploader, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const teamId = await teamOf(uploader);
      const forTeam = await uploader.api.brainSources.upload(
        fileOf(`Rota ${word()}`, "Rota.vtt"),
        teamReaders(teamId),
        crypto.randomUUID()
      );
      const forAll = await uploader.api.brainSources.upload(
        fileOf(`Handbook ${word()}`, "Handbook.vtt"),
        everyone,
        crypto.randomUUID()
      );
      // Removed as an admin removes a team.
      const removed = await callAuth(
        "/organization/remove-team",
        admin.session,
        { teamId, organizationId }
      );
      const { uploads } = await admin.api.brainSources.sharedUploads();
      const shown = (id: string) => {
        const upload = uploads.find(({ source }) => source.id === id);
        return upload === undefined
          ? undefined
          : {
              name: upload.name,
              readers: upload.readers,
              teamName: upload.teamName,
            };
      };
      const opened = await admin.api.brainSources.uploadOf(forTeam.source.id);
      await admin.api.brainSources.deleteUpload(forTeam.source.id);
      const teamLeft = await drizzle(env.DB)
        .select()
        .from(teams)
        .where(eq(teams.id, teamId));
      const rowsLeft = await rowsWith(forTeam.source.id);

      expect({
        removed: removed.status,
        teamLeft: teamLeft.length,
        forTeam: shown(forTeam.source.id),
        forAll: shown(forAll.source.id),
        opened: opened?.mayDelete,
        rows: rowsLeft.length,
        actions: await actionsOf(forTeam.source.id),
      }).toStrictEqual({
        removed: 200,
        teamLeft: 0,
        forTeam: { name: null, readers: teamReaders(teamId), teamName: null },
        forAll: { name: "Handbook.vtt", readers: everyone, teamName: null },
        opened: true,
        rows: 0,
        actions: ["brain.upload.added", "brain.upload.deleted"],
      });
    }
  );

  it(
    "erases a shared upload for good when an admin deletes it: its key closed, erased again after a restore, and an export holding it stale",
    slow,
    async () => {
      const [uploader, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const secret = word();
      const { source } = await uploader.api.brainSources.upload(
        fileOf(`Price list ${secret}`),
        everyone,
        crypto.randomUUID()
      );
      const copy = await copyOfStore();
      // An export of the company's Brain holding it, written before.
      const started = await routed(brainExportsPath, {
        method: "POST",
        headers: { cookie: admin.session, "sec-fetch-site": "same-origin" },
      });
      const { id: exportId } = z
        .object({ id: z.string() })
        .parse(await started.json());
      await workBrain(env, new Date(), noProducers);
      const statusOf = async (): Promise<unknown> => {
        const response = await routed(
          `${brainExportsPath}?${new URLSearchParams({ id: exportId }).toString()}`,
          {
            headers: { cookie: admin.session, "sec-fetch-site": "same-origin" },
          }
        );
        return z.object({ state: z.string() }).parse(await response.json())
          .state;
      };
      const before = await statusOf();

      await admin.api.brainSources.deleteUpload(source.id);
      const erased = {
        key: await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(
          `upload:${source.id}`
        ),
        found: await found(uploader, secret),
        exported: await statusOf(),
      };
      await restoreStore(copy);
      const restored = {
        found: await found(uploader, secret),
        key: await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(
          `upload:${source.id}`
        ),
      };

      expect({ before, erased, restored }).toStrictEqual({
        before: "done",
        erased: { key: "erased", found: [], exported: "erased" },
        restored: { found: [], key: "erased" },
      });
    }
  );

  it(
    "keeps a retried upload one source, and refuses an id someone else's upload holds without touching it",
    slow,
    async () => {
      const [uploader, other] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const once = word();
      const uploadId = crypto.randomUUID();
      const file = fileOf(`Sent twice ${once}`);
      const first = await uploader.api.brainSources.upload(
        file,
        everyone,
        uploadId
      );
      // The answer lost, the page sends it again with the same id.
      const again = await uploader.api.brainSources.upload(
        file,
        everyone,
        uploadId
      );
      const otherReaders = await outcome(
        async () => await uploader.api.brainSources.upload(file, me, uploadId)
      );
      const byOther = await outcome(
        async () =>
          await other.api.brainSources.upload(
            fileOf(`Taken over ${word()}`),
            everyone,
            uploadId
          )
      );
      const rows = await drizzle(env.DB)
        .select()
        .from(brainUploads)
        .where(eq(brainUploads.id, uploadId));
      const { versions } = await other.api.brainSources.versions(first.source);

      expect({
        first,
        again,
        otherReaders,
        byOther,
        found: await found(other, once),
        versions: versions.length,
        rows: rows.map(({ uploadedBy, readers }) => ({ uploadedBy, readers })),
      }).toStrictEqual({
        first: { source: { producer: "upload", id: uploadId }, version: 1 },
        again: first,
        otherReaders: { refused: "brain.upload_retry_refused" },
        byOther: { refused: "brain.upload_retry_refused" },
        found: [uploadId],
        versions: 1,
        rows: [{ uploadedBy: uploader.userId, readers: "everyone" }],
      });
    }
  );

  it(
    "keeps a landed first upload when its id is sent again with another file: refused as such, nothing changed, and still deletable",
    slow,
    async () => {
      const [uploader, admin, mate] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const teamId = await teamOf(uploader, mate);
      const once = word();
      const uploadId = crypto.randomUUID();
      const first = await uploader.api.brainSources.upload(
        fileOf(`First ${once}`, "Same.vtt"),
        teamReaders(teamId),
        uploadId
      );

      const retried = await outcome(
        async () =>
          await uploader.api.brainSources.upload(
            fileOf(`Changed ${word()}`, "Same.vtt"),
            teamReaders(teamId),
            uploadId
          )
      );
      const rows = await rowsWith(uploadId);
      const mateBefore = await found(mate, once);
      const uploaderSees = await uploader.api.brainSources.uploadOf(uploadId);
      await admin.api.brainSources.deleteUpload(uploadId);

      expect({
        retried,
        rows: rows.length,
        mateBefore,
        versions: uploaderSees === null ? 0 : 1,
        mayDelete: uploaderSees?.mayDelete,
        mateAfter: [await found(mate, once), await readAs(mate, first.source)],
        actions: await actionsOf(uploadId),
      }).toStrictEqual({
        retried: { refused: "brain.upload_other_file" },
        rows: 1,
        mateBefore: [uploadId],
        versions: 1,
        // Its uploader asks an admin, who deletes it below.
        mayDelete: false,
        mateAfter: [[], null],
        actions: [
          "brain.upload.added",
          "brain.upload.refused",
          "brain.upload.deleted",
        ],
      });
    }
  );

  it(
    "keeps the row of a first upload whose add's outcome isn't known, so it can be deleted or sent again",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const uploadId = crypto.randomUUID();
      const file = fileOf(`Unknown ${word()}`);
      // The store's write fails part-way: core can't tell whether it landed.
      await failNextBucketPut();

      const failed = await outcome(
        async () =>
          await uploader.api.brainSources.upload(file, everyone, uploadId)
      );
      const kept = await rowsWith(uploadId);
      const shown = await uploader.api.brainSources.uploadOf(uploadId);
      const retried = await uploader.api.brainSources.upload(
        file,
        everyone,
        uploadId
      );
      const admin = await signedInApi(idp, "admin");
      const adminSees = await admin.api.brainSources.uploadOf(uploadId);
      await admin.api.brainSources.deleteUpload(uploadId);

      expect({
        failed,
        kept: kept.length,
        shown: shown?.source,
        mayDelete: adminSees?.mayDelete,
        retried,
        afterDelete: await rowsWith(uploadId),
        actions: await actionsOf(uploadId),
      }).toStrictEqual({
        failed: { refused: "internal.unexpected" },
        kept: 1,
        shown: { producer: "upload", id: uploadId },
        mayDelete: true,
        retried: { source: { producer: "upload", id: uploadId }, version: 1 },
        afterDelete: [],
        actions: [
          "brain.upload.failed",
          "brain.upload.added",
          "brain.upload.deleted",
        ],
      });
    }
  );

  it(
    "refuses a file whose text is past the Brain's bound as it indexes it, before anything is written",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const uploadId = crypto.randomUUID();
      // "ﷺ" is 3 bytes as given and 33 as the word index folds it: some
      // 40,000 of them are under the extractor's limit, past the Brain's.
      const cue = "ﷺ".repeat(19_000);
      const cues = [0, 1, 2]
        .map((index) => `00:00:0${index}.000 --> 00:00:0${index}.500\n${cue}`)
        .join("\n\n");
      const bytes = new TextEncoder().encode(`WEBVTT\n\n${cues}\n`);

      expect({
        refused: await outcome(
          async () =>
            await uploader.api.brainSources.upload(
              { name: "Folded.vtt", bytes },
              everyone,
              uploadId
            )
        ),
        rows: await rowsWith(uploadId),
        actions: await actionsOf(uploadId),
      }).toStrictEqual({
        refused: { refused: "brain.upload_text_too_long" },
        rows: [],
        actions: [],
      });
    }
  );

  it(
    "keeps two uploads of one id sent at once one source, one version and one row",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const uploadId = crypto.randomUUID();
      const file = fileOf(`At once ${word()}`);

      const both = await Promise.all([
        uploader.api.brainSources.upload(file, everyone, uploadId),
        uploader.api.brainSources.upload(file, everyone, uploadId),
      ]);
      const { versions } = await uploader.api.brainSources.versions({
        producer: "upload",
        id: uploadId,
      });
      const rows = await rowsWith(uploadId);

      expect({
        both,
        versions: versions.length,
        rows: rows.length,
      }).toStrictEqual({
        both: [
          { source: { producer: "upload", id: uploadId }, version: 1 },
          { source: { producer: "upload", id: uploadId }, version: 1 },
        ],
        versions: 1,
        rows: 1,
      });
    }
  );

  it(
    "refuses a deleted upload's id on a new upload, whoever sends it, keeping nothing",
    slow,
    async () => {
      const [uploader, other, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const uploadId = crypto.randomUUID();
      await uploader.api.brainSources.upload(
        fileOf(`Gone ${word()}`),
        everyone,
        uploadId
      );
      await admin.api.brainSources.deleteUpload(uploadId);

      expect({
        byUploader: await outcome(
          async () =>
            await uploader.api.brainSources.upload(
              fileOf(`Again ${word()}`),
              everyone,
              uploadId
            )
        ),
        byOther: await outcome(
          async () =>
            await other.api.brainSources.upload(
              fileOf(`Other ${word()}`),
              me,
              uploadId
            )
        ),
        rows: await rowsWith(uploadId),
      }).toStrictEqual({
        byUploader: { refused: "brain.upload_retry_refused" },
        byOther: { refused: "brain.upload_retry_refused" },
        rows: [],
      });
    }
  );

  it(
    "says a file's text is too long, not that the file is, and keeps nothing of it",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      // Captions of about 1.4 MB: well within an upload's 10 MB, but text
      // past what a source keeps.
      const cue = "word ".repeat(3999);
      const cues = Array.from(
        { length: 70 },
        (_, index) =>
          `00:00:${String(index % 60).padStart(2, "0")}.000 --> 00:00:${String(index % 60).padStart(2, "0")}.500\n${cue}`
      ).join("\n\n");
      const bytes = new TextEncoder().encode(`WEBVTT\n\n${cues}\n`);

      expect({
        size: bytes.byteLength < uploadMaxBytes,
        refused: await outcome(
          async () =>
            await uploader.api.brainSources.upload(
              { name: "Long.vtt", bytes },
              me,
              crypto.randomUUID()
            )
        ),
        kept: await drizzle(env.DB)
          .select()
          .from(brainUploads)
          .where(eq(brainUploads.uploadedBy, uploader.userId)),
      }).toStrictEqual({
        size: true,
        refused: { refused: "brain.upload_text_too_long" },
        kept: [],
      });
    }
  );

  it(
    "refuses an upload while the Brain restores an export, keeps its row, and takes the same id once the restore is done",
    slow,
    async () => {
      const uploader = await signedInApi(idp, "user");
      const uploadId = crypto.randomUUID();
      const file = fileOf(`While it restores ${word()}`);
      // A restore under way in the shared store, as an admin starts one.
      const restore = crypto.randomUUID();
      await runInDurableObject(sharedStore(), (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO restores (export, checked, part, restored, state, started_at) VALUES (?, 0, 0, 0, 'running', ?)",
          restore,
          Date.now()
        );
      });

      let refused: unknown;
      try {
        refused = await outcome(
          async () =>
            await uploader.api.brainSources.upload(file, everyone, uploadId)
        );
      } finally {
        await runInDurableObject(sharedStore(), (_instance, state) => {
          state.storage.sql.exec(
            "DELETE FROM restores WHERE export = ?",
            restore
          );
        });
      }
      const kept = await rowsWith(uploadId);
      const events = await eventsOf(uploadId);
      const retried = await uploader.api.brainSources.upload(
        file,
        everyone,
        uploadId
      );

      expect({
        refused,
        kept: kept.length,
        refusedAs: events[0]?.detail?.reason,
        retried,
        actions: await actionsOf(uploadId),
      }).toStrictEqual({
        refused: { refused: "brain.restoring" },
        kept: 1,
        refusedAs: "restoring",
        retried: { source: { producer: "upload", id: uploadId }, version: 1 },
        actions: ["brain.upload.refused", "brain.upload.added"],
      });
    }
  );
});
