import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { memberOf } from "../src/auth/identity.ts";
import {
  addInstructionFile,
  brainExportFile,
  brainExportStatus,
  eraseSource,
  erasePerson,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import type {
  InstructionFile,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { removeLostRunSources } from "../src/brain-run-sources.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-members.ts";
import {
  markerWord,
  markersIn,
  surfaces,
  reading,
  findingsOf,
  leave,
  newTeam,
  everyVersionOf,
  sharedStore,
  newSource,
  add,
  answerOf,
  textsFor,
} from "./brain-next-leaks-harness.ts";
import type { Finding } from "./brain-next-leaks-harness.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import { textOf } from "./brain-next-surfaces.ts";
import type { Probe, Probing } from "./brain-next-surfaces.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { carrying } from "./platform-providers.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import {
  definitionOf,
  ended,
  published as publishedWorkflow,
  start,
} from "./workflow-resource-runs-harness.ts";

// The marker test (brain-next-leaks.test.ts), for what an erasure, a
// removed upload, a restore from an older copy or a lost workflow takes:
// each must answer, through every surface that reads, exactly as what was
// never added, while it is under way and once it is done.

const idp = mockIdp();

/** The trigger that holds the shared store's erasures (`whileErasureHeld`). */
const heldErasures = "leaks_test_holds_erasures";

/**
 * Runs `run` while the shared store's erasures are held part-way: an
 * erasure hides what it covers and returns, and every deletion of a
 * version fails, in the erasure's own batch and in each tick's, so what
 * it hid stays stored and hidden (erasure.ts) until a tick after `run`.
 */
const whileErasureHeld = async (run: () => Promise<void>): Promise<void> => {
  await runInDurableObject(sharedStore(), (_store, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${heldErasures} BEFORE DELETE ON source_versions
      BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
    );
  });
  try {
    await run();
  } finally {
    await runInDurableObject(sharedStore(), (_store, state) => {
      state.storage.sql.exec(`DROP TRIGGER IF EXISTS ${heldErasures}`);
    });
  }
};

/** Whether the shared store has an erasure recorded and not yet done. */
const erasureUnfinished = async (): Promise<boolean> => {
  const { erasing } = await sharedStore().workOverview();
  return erasing > 0;
};

/**
 * `read` of what an erasure covers (`true`) against `read` of what no one
 * added (`false`): "as if never added" when they answer alike, else what
 * the first answered.
 */
const asIfNeverAdded = async (
  read: (erased: boolean) => Promise<unknown>
): Promise<string> => {
  const erased = await answerOf(async () => await read(true));
  const missing = await answerOf(async () => await read(false));
  return erased === missing ? "as if never added" : erased;
};

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
    it("gives no surface anything erased, once the store is restored from a copy taken before the erasure", async () => {
      await answeringProvider(() => {});
      // The holder's own sources, under each producer's kind (an upload, a
      // chat, a run), their instruction file, and a team's source: each
      // erased, then a copy of
      // the store from before the erasures comes back. Every surface is
      // then probed as those who could read them before.
      const [{ userId: holder }, { userId: teamMate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = await newTeam(holder, teamMate);
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source": markerWord(),
        "the holder's upload": markerWord(),
        "the holder's chat turn": markerWord(),
        "the holder's run": markerWord(),
        "the holder's instruction file": markerWord(),
      };
      const {
        "the holder's own source": ownMarker,
        "a team's source": teamMarker,
        "the holder's upload": uploadMarker,
        "the holder's chat turn": chatMarker,
        "the holder's run": runMarker,
        "the holder's instruction file": fileMarker,
      } = markers;
      const sharedWord = `s${unique()}`;
      const own = await add(`Salary ${sharedWord} ${ownMarker}`, {
        kind: "owner",
        personId: holder,
      });
      const teamSource = await add(`Minutes ${sharedWord} ${teamMarker}`, {
        kind: "team",
        teamId: team,
      });
      const upload: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      const chat: SourceRef = { producer: "chat", id: crypto.randomUUID() };
      const run: SourceRef = { producer: "run", id: crypto.randomUUID() };
      const holders: SourceReaders = { kind: "owner", personId: holder };
      await add(`Contract ${sharedWord} ${uploadMarker}`, holders, upload);
      await add(`Asked ${sharedWord} ${chatMarker}`, holders, chat);
      await add(`Run note ${sharedWord} ${runMarker}`, holders, run);
      const holderFile: InstructionFile = { scope: "person", personId: holder };
      await addInstructionFile(env, {
        file: holderFile,
        change: crypto.randomUUID(),
        text: `Instructions ${sharedWord} ${fileMarker}`,
        after: 0,
      });
      const backup = await copyOfStore();

      // A chat and an upload deleted for good, a run past its retention,
      // the team's source deleted, and then the holder erased.
      const teamReaders: SourceReaders = { kind: "team", teamId: team };
      await eraseSource(env, {
        source: chat,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: upload,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: run,
        readers: holders,
        reason: "retention",
      });
      await eraseSource(env, {
        source: teamSource,
        readers: teamReaders,
        reason: "deleted",
      });
      // Their own store answers that it is still deleting until an add
      // under way could have written its file: as if that time had passed.
      await Promise.allSettled([
        erasePerson(env, { personId: holder, reason: "person_erased" }),
      ]);
      await ageOwnErasure(holder);
      await erasePerson(env, { personId: holder, reason: "person_erased" });
      await workBrain(env, new Date(), noProducers);
      await restoreStore(backup);

      const erased = [own, teamSource, upload, chat, run].flatMap((source) =>
        [1, 2].map((version) => ({ source, version }))
      );
      const asReader = (
        personId: string,
        hiddenInstructionFiles: InstructionFile[]
      ): Probing => ({
        personId,
        reader: { person: personId, groups: [`team:${team}`] },
        personal: true,
        sharedWord,
        markers: Object.values(markers),
        hiddenVersions: erased,
        hiddenInstructionFiles,
        instructionGroups: ["company"],
      });
      // Their own store was erased whole, and takes nothing from then on:
      // the surfaces that write a skill of theirs (and decide a share of
      // one) can only be refused for them, and are probed as the
      // team-mate.
      const holderWritesOwn = new Set([
        "instructions saveInstructionFile",
        "core addOwnSkill",
        "shares readSkill",
        "shares saveOwnSkill",
        "shares shareOwnSkill",
        "shares approveShare",
        "shares declineShare",
        "shares retireSkill",
      ]);
      const findings = [
        // Their own file is theirs to write again, and what they write
        // after an erasure is new: saving it is probed as the team-mate
        // only, so the holder's pass finds their erased file if it came
        // back, and nothing they wrote since.
        ...(await findingsOf(
          "the holder, after a restore",
          asReader(holder, []),
          markers,
          {
            among: surfaces.filter(([name]) => !holderWritesOwn.has(name)),
          }
        )),
        ...(await findingsOf(
          "a team-mate, after a restore",
          asReader(teamMate, [holderFile]),
          markers
        )),
      ];
      const carried = await Promise.all(Object.values(markers).map(carrying));
      const prompted = carried.flat();

      expect({ findings, prompted }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    /**
     * A team's source with a version before its current one, both marked,
     * and a memory drawn from each, about a customer only they name: what
     * the two tests below erase through core, its markers by name, and the
     * readers it had: the holder and a team-mate.
     */
    const teamSourceToErase = async () => {
      await answeringProvider(() => {});
      const [{ userId: holder }, { userId: teamMate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const teamId = await newTeam(holder, teamMate);
      const group = `team:${teamId}`;
      const sharedWord = `s${unique()}`;
      const markers = {
        "a version before the current one": markerWord(),
        "the current version": markerWord(),
        "a memory drawn from them": markerWord(),
        "a customer only they name": markerWord(),
      };
      const readers: SourceReaders = { kind: "team", teamId };
      const source = await add(
        `Minutes ${sharedWord} ${markers["a version before the current one"]}`,
        readers
      );
      await add(
        `Minutes ${sharedWord} ${markers["the current version"]}`,
        readers,
        source
      );
      const key = `${source.producer}:${source.id}`;
      const customer = markers["a customer only they name"];
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [
          {
            key: "c",
            kind: "customer",
            names: [`${sharedWord} ${customer}`],
            identifiers: [{ type: "ref", value: `ref:${customer}` }],
          },
        ],
        memories: [1, 2].map((version) => ({
          about: "c",
          type: "fact" as const,
          statement: `${sharedWord} ${markers["a memory drawn from them"]} ${version}`,
          speaker: { kind: "system" as const },
          basis: {
            kind: "source" as const,
            source: key,
            version,
            quote: sharedWord,
          },
        })),
      });
      return {
        holder,
        teamMate,
        group,
        readers,
        sharedWord,
        markers,
        source,
        key,
        customer,
        entity: drawn.entities.c ?? "",
      };
    };

    /** A team's source with memories drawn from two of its versions, as `teamSourceToErase` and `teamUploadToRemove` make it. */
    interface TeamSource {
      group: string;
      sharedWord: string;
      markers: Readonly<Record<string, string>>;
      source: SourceRef;
      key: string;
      customer: string;
      entity: string;
    }

    /**
     * What `personId` gets of `team`'s source's versions, history,
     * passages, memories and customer, through core and the store, each
     * against what they get of what no one added.
     */
    const readsOfTeamSource = async (team: TeamSource, personId: string) => {
      const { group, sharedWord, markers, source, key, customer, entity } =
        team;
      const missing = newSource();
      const unknownEntity = crypto.randomUUID();
      const unknownWord = markerWord();
      const reader = { person: personId, groups: [group, "company"] };
      const pack = await recallAs(env, personId, {
        personal: true,
        question: `${sharedWord} ${Object.values(markers).join(" ")}`,
        budget: { tokens: recallBudgetMax },
      });
      return {
        versions: await Promise.all(
          [1, 2].map(
            async (version) =>
              await asIfNeverAdded(
                async (erased) =>
                  await readSourceVersionAs(env, personId, {
                    source: erased ? source : missing,
                    version,
                  })
              )
          )
        ),
        history: await asIfNeverAdded(
          async (erased) =>
            await listVersionsAs(env, personId, {
              source: erased ? source : missing,
            })
        ),
        // What it found: its "not found" holds the question's words.
        recalled: markersIn(
          [pack.items, pack.memories, pack.contested],
          markers
        ),
        memories: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readMemories({
              entity: erased ? entity : unknownEntity,
              reader,
              history: true,
            })
        ),
        names: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readEntityNames({
              entity: erased ? entity : unknownEntity,
              reader,
            })
        ),
        customer: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readEntity({
              entity: erased ? entity : unknownEntity,
              reader,
            })
        ),
        byName: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().findEntities({
              reader,
              name: `${sharedWord} ${erased ? customer : unknownWord}`,
            })
        ),
        byReference: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().findEntities({
              reader,
              identifier: {
                type: "ref",
                value: `ref:${erased ? customer : unknownWord}`,
              },
            })
        ),
        // Drawing from a version, as extraction does: refused alike.
        drawing: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().addMemories({
              change: crypto.randomUUID(),
              access: { kind: "audience", group },
              entities: [{ key: "c", kind: "customer", names: ["Plain"] }],
              memories: [
                {
                  about: "c",
                  type: "fact",
                  statement: "Plain",
                  speaker: { kind: "system" },
                  basis: {
                    kind: "source",
                    source: erased ? key : `upload:${missing.id}`,
                    version: 1,
                    quote: sharedWord,
                  },
                },
              ],
            })
        ),
      };
    };

    /** What a source answers to its readers once nothing of it may be read: as if no one added it. */
    const unreadable = {
      versions: ["as if never added", "as if never added"],
      history: "as if never added",
      recalled: [],
      memories: "as if never added",
      names: "as if never added",
      customer: "as if never added",
      byName: "as if never added",
      byReference: "as if never added",
      drawing: "as if never added",
    };

    /** The reads of `read` that answered as unreadable (`unreadable`). */
    const asUnreadable = (read: Readonly<Record<string, unknown>>): string[] =>
      Object.entries(unreadable)
        .filter(([name, got]) => textOf(read[name]) === textOf(got))
        .map(([name]) => name);

    it("answers a team's source as erased to each of its readers, and leaves it out of an export, while its erasure is still under way, as once it is done", async () => {
      const erasing = await teamSourceToErase();
      const { markers, source } = erasing;
      const readsOf = async (personId: string) =>
        await readsOfTeamSource(erasing, personId);
      /** What each of its readers gets. */
      const reads = async () => ({
        holder: await readsOf(erasing.holder),
        teamMate: await readsOf(erasing.teamMate),
      });
      /**
       * The company's export, written: whether it holds no marker. Any
       * export still being written (a probe's, which a test before started)
       * is written first, so this one is started now.
       */
      const exportHoldsNone = async (): Promise<string[]> => {
        const exported = async (): Promise<string[]> => {
          const { id } = await startBrainExport(env);
          let status = await brainExportStatus(env, { id });
          for (let ticks = 0; status?.state === "writing"; ticks += 1) {
            if (ticks === 20) {
              throw new Error(
                "An export was still being written after 20 ticks"
              );
            }
            // oxlint-disable-next-line no-await-in-loop -- a tick at a time
            await workBrain(env, new Date(), noProducers);
            // oxlint-disable-next-line no-await-in-loop -- a tick at a time
            status = await brainExportStatus(env, { id });
          }
          const files = await Promise.all(
            (status?.files ?? []).map(
              async (file) => await brainExportFile(env, { id, file })
            )
          );
          return [
            `${status?.state} with ${files.length > 0 ? "files" : "none"}`,
            ...markersIn(files, markers),
          ];
        };
        await exported();
        return await exported();
      };
      const before = await reads();
      let held = false;
      let during;
      let exportedDuring: string[] = [];
      await whileErasureHeld(async () => {
        await eraseSource(env, {
          source,
          readers: erasing.readers,
          reason: "deleted",
        });
        held = await erasureUnfinished();
        during = await reads();
        exportedDuring = await exportHoldsNone();
      });
      await workBrain(env, new Date(), noProducers);
      const after = await reads();
      const erased = unreadable;

      expect({
        // Before, each of them read it all: none of this holds by chance.
        before: Object.values(before).map(asUnreadable),
        held,
        during,
        exportedDuring,
        after,
        unfinished: await erasureUnfinished(),
      }).toStrictEqual({
        before: [[], []],
        held: true,
        during: { holder: erased, teamMate: erased },
        exportedDuring: ["done with files"],
        after: { holder: erased, teamMate: erased },
        unfinished: false,
      });
    });

    /**
     * What `pass` finds through `among` (every surface by default) as one
     * of the readers of a team's source (`teamSourceToErase`), the holder
     * or the team-mate, while its erasure through core is under way, and
     * every model prompt that carried its markers.
     */
    const foundWhileErasing = async (
      pass: string,
      who: "holder" | "teamMate",
      among?: readonly [string, Probe][]
    ) => {
      const erasing = await teamSourceToErase();
      const personId = erasing[who];
      const findings: Finding[] = [];
      let held = false;
      await whileErasureHeld(async () => {
        await eraseSource(env, {
          source: erasing.source,
          readers: erasing.readers,
          reason: "deleted",
        });
        held = await erasureUnfinished();
        findings.push(
          ...(await findingsOf(
            pass,
            {
              personId,
              reader: { person: personId, groups: [erasing.group] },
              personal: true,
              sharedWord: erasing.sharedWord,
              markers: Object.values(erasing.markers),
              hiddenVersions: everyVersionOf(erasing.source),
              hiddenInstructionFiles: [],
              instructionGroups: ["company"],
            },
            erasing.markers,
            among === undefined ? {} : { among }
          ))
        );
      });
      await workBrain(env, new Date(), noProducers);
      const carried = await Promise.all(
        Object.values(erasing.markers).map(carrying)
      );
      return { held, findings, prompted: carried.flat() };
    };

    // One of its readers through every surface, and the other through
    // every surface that reads: a test each, for its time.
    it("gives a team's source's holder nothing of it through any surface while its erasure is still under way", async () => {
      await expect(
        foundWhileErasing(
          "the holder, while its erasure is under way",
          "holder"
        )
      ).resolves.toStrictEqual({ held: true, findings: [], prompted: [] });
    });

    it("gives a team-mate nothing of the team's source through any surface that reads while its erasure is still under way", async () => {
      await expect(
        foundWhileErasing(
          "a team-mate, while its erasure is under way",
          "teamMate",
          reading
        )
      ).resolves.toStrictEqual({ held: true, findings: [], prompted: [] });
    });

    /**
     * A team's upload, removed by its uploader's Delete (GRA-1877) through
     * core's route: a version before its current one, both marked, and a
     * memory drawn from each about a customer only they name, as
     * `teamSourceToErase` makes it; its readers the uploader, a team-mate
     * and an admin of the team. `removed` removes it, as many times as
     * asked: once is the state every test below reads.
     */
    const teamUploadToRemove = async () => {
      await answeringProvider(() => {});
      const [uploader, { userId: teamMate }, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInWithRole(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const holder = uploader.userId;
      const teamId = await newTeam(holder, teamMate, admin.userId);
      const group = `team:${teamId}`;
      const sharedWord = `s${unique()}`;
      const markers = {
        "a version before the current one": markerWord(),
        "the current version": markerWord(),
        "a memory drawn from them": markerWord(),
        "a customer only they name": markerWord(),
      };
      const file = (marker: string) => ({
        name: "Minutes.vtt",
        bytes: new TextEncoder().encode(
          `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nMinutes ${sharedWord} ${marker}\n`
        ),
      });
      const { source } = await uploader.api.brainSources.upload(
        file(markers["a version before the current one"]),
        { kind: "team", teamId },
        crypto.randomUUID()
      );
      await uploader.api.brainSources.uploadVersion(
        source.id,
        file(markers["the current version"]),
        crypto.randomUUID()
      );
      const key = `${source.producer}:${source.id}`;
      const customer = markers["a customer only they name"];
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [
          {
            key: "c",
            kind: "customer",
            names: [`${sharedWord} ${customer}`],
            identifiers: [{ type: "ref", value: `ref:${customer}` }],
          },
        ],
        memories: [1, 2].map((version) => ({
          about: "c",
          type: "fact" as const,
          statement: `${sharedWord} ${markers["a memory drawn from them"]} ${version}`,
          speaker: { kind: "system" as const },
          basis: {
            kind: "source" as const,
            source: key,
            version,
            quote: sharedWord,
          },
        })),
      });
      return {
        holder,
        teamMate,
        admin: admin.userId,
        teamId,
        group,
        sharedWord,
        markers,
        source,
        key,
        customer,
        entity: drawn.entities.c ?? "",
        removed: async () => {
          await uploader.api.brainSources.deleteUpload(source.id);
        },
      };
    };

    it("answers a team's upload its uploader removed as never added to each of its readers, through core and the store", async () => {
      const removing = await teamUploadToRemove();
      const reads = async () => ({
        holder: await readsOfTeamSource(removing, removing.holder),
        teamMate: await readsOfTeamSource(removing, removing.teamMate),
        admin: await readsOfTeamSource(removing, removing.admin),
      });
      const before = await reads();
      await removing.removed();
      // A tick, as the store's own work would run: nothing comes back.
      await workBrain(env, new Date(), noProducers);
      const after = await reads();

      expect({
        // Before, each of them read it all: none of this holds by chance.
        before: Object.values(before).map(asUnreadable),
        after,
      }).toStrictEqual({
        before: [[], [], []],
        after: { holder: unreadable, teamMate: unreadable, admin: unreadable },
      });
    });

    /**
     * What `pass` finds through `among` (every surface by default) as one
     * of the readers of a removed team upload (`teamUploadToRemove`), and
     * every model prompt that carried its markers.
     */
    const foundOnceRemoved = async (
      pass: string,
      who: "holder" | "teamMate" | "admin",
      among?: readonly [string, Probe][]
    ) => {
      const removing = await teamUploadToRemove();
      await removing.removed();
      const personId = removing[who];
      const findings = await findingsOf(
        pass,
        {
          personId,
          reader: { person: personId, groups: [removing.group] },
          personal: true,
          sharedWord: removing.sharedWord,
          markers: Object.values(removing.markers),
          hiddenVersions: everyVersionOf(removing.source),
          // Its uploader may no longer reach it at all; an admin may, to
          // erase it (brain-uploads.test.ts).
          hiddenUploads: who === "admin" ? [] : [removing.source.id],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        removing.markers,
        among === undefined ? {} : { among }
      );
      const carried = await Promise.all(
        Object.values(removing.markers).map(carrying)
      );
      return { findings, prompted: carried.flat() };
    };

    it("gives a removed upload's uploader nothing of it through any surface", async () => {
      await expect(
        foundOnceRemoved("the uploader, once they removed it", "holder")
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
    });

    it("gives a team-mate and an admin of the team nothing of a removed upload through any surface that reads", async () => {
      await expect(
        foundOnceRemoved(
          "a team-mate, once it was removed",
          "teamMate",
          reading
        )
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
      await expect(
        foundOnceRemoved("an admin, once it was removed", "admin", reading)
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
    });

    it("gives an uploader who left the team nothing of their team's upload through any surface, and no way to remove it from the team", async () => {
      const shared = await teamUploadToRemove();
      await leave(shared.teamId, shared.holder);
      const findings = await findingsOf(
        "the uploader, once they left the team",
        {
          personId: shared.holder,
          reader: { person: shared.holder, groups: [] },
          personal: true,
          sharedWord: shared.sharedWord,
          markers: Object.values(shared.markers),
          hiddenVersions: everyVersionOf(shared.source),
          // Asked of, a new version and a delete among them, as an upload
          // nobody made.
          hiddenUploads: [shared.source.id],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        shared.markers
      );

      expect({
        findings,
        // Still the team's: nothing the former member asked removed it.
        teamMate: asUnreadable(
          await readsOfTeamSource(shared, shared.teamMate)
        ),
      }).toStrictEqual({ findings: [], teamMate: [] });
    });

    it("gives a person who lost a workflow nothing of their earlier run's result through any surface", async () => {
      const [{ userId: ownerId }, { userId: personId }] = await Promise.all([
        signedInWithRole(idp, "builder"),
        signedInWithRole(idp, "user"),
      ]);
      const [owner, person] = await Promise.all([
        memberOf(env.DB, ownerId),
        memberOf(env.DB, personId),
      ]);
      if (owner === undefined || person === undefined) {
        throw new Error("Not members");
      }
      const sharedWord = `s${unique()}`;
      const markers = { "what their run returned": markerWord() };
      const returned = markers["what their run returned"];
      const workflow = await publishedWorkflow(
        owner,
        definitionOf([], { value: { status: `${sharedWord} ${returned}` } })
      );
      await shareWorkflowResource(env, owner, workflow.id, {
        type: "person",
        id: personId,
        role: "user",
      });
      const { runId } = await start(person, workflow.id);
      await ended(person, workflow.id, runId);
      const source: SourceRef = { producer: "run", id: runId ?? "" };
      // In their own store, theirs to recall while they hold the workflow.
      await vi.waitFor(
        async () => {
          await drainAuditOutboxes(env);
          await relayHandOvers(env);
          await workBrain(env, new Date(), producersOf(env));
          await expect(
            textsFor(personId, returned),
            "the run was never handed over"
          ).resolves.toHaveLength(1);
        },
        { timeout: 15_000, interval: 200 }
      );

      await unshareWorkflowResource(env, owner, workflow.id, {
        type: "person",
        id: personId,
      });
      await removeLostRunSources(env);
      const findings = await findingsOf(
        "a person who lost the workflow",
        {
          personId,
          reader: { person: personId, groups: [] },
          personal: true,
          sharedWord,
          markers: Object.values(markers),
          hiddenVersions: everyVersionOf(source),
          hiddenUploads: [],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        markers
      );
      const carried = await Promise.all(Object.values(markers).map(carrying));

      expect({ findings, prompted: carried.flat() }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });
  }
);
