import { ensureCollection } from "@grasp-os/brain/collections";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import { onboardingDocumentsCollection } from "@grasp-os/shared/onboarding-documents";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { keepAudience } from "../src/knowledge/access.ts";
import {
  advanceExports,
  brainExportPath,
} from "../src/knowledge/brain-export.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newAgent, purged } from "./knowledge-purge.ts";
import { newTeam } from "./knowledge.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Exporting the company's Brain (GRA-1192, GRA-335's E1; the threat model
// is on GRA-335). It starts from the ways it can fail:
//
// - Someone other than the client's admins exporting the whole company:
//   a member, Grasp staff, or an admin without confirming it.
// - The export holding what isn't the company's: a Personal collection,
//   a person's own memory, or what a purge erased.
// - A download by anyone but the admin who asked, from another site, or
//   after its window; a manifest that doesn't match its files.
// - A purge while it is written leaving it with what the purge erased.

const idp = mockIdp();

const setUpTime = { timeout: 120_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Goes on with exports until `exportId` is no longer running. */
const finished = async (person: Person, exportId: string) => {
  for (let tick = 0; tick < 20; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one clock tick after another
    await advanceExports(env, new Date());
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const status = await person.api.knowledge.brainExportStatus(exportId);
    if (status.state !== "running") {
      return status;
    }
  }
  throw new Error(`Export ${exportId} is still running`);
};

/** A file of an export, downloaded as a browser does on `cookie`. */
const download = async (
  cookie: string,
  exportId: string,
  file: string,
  headers: Record<string, string> = {}
) =>
  await routed(`${brainExportPath}?id=${exportId}&file=${file}`, {
    headers: { ...headers, cookie },
  });

/** The status a download of `file` answers. */
const statusOf = async (
  cookie: string,
  exportId: string,
  file: string,
  headers: Record<string, string> = {}
): Promise<number> => {
  const response = await download(cookie, exportId, file, headers);
  return response.status;
};

const manifestSchema = z.object({
  format: z.string(),
  files: z.array(z.object({ name: z.string(), sha256: z.string() })),
});

/** The SHA-256 of `text`, in hex. */
const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("exporting the company's Brain", setUpTime, () => {
  it("is for the client's admins alone, and only once confirmed", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    expect({
      member: await outcome(member.api.knowledge.prepareBrainExport()),
      memberStart: await outcome(member.api.knowledge.startBrainExport("1.x")),
      staff: await outcome(staff.knowledge.prepareBrainExport()),
      unconfirmed: await outcome(
        admin.api.knowledge.startBrainExport("not-a-token")
      ),
    }).toStrictEqual({
      member: "role.forbidden",
      memberStart: "role.forbidden",
      staff: "role.forbidden",
      unconfirmed: "knowledge.purge_expired",
    });
  });

  it("holds the company's collections, history and shared memory, with checksums, and never a person's own or what a purge erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const ada = await signedInApi(idp, "user");
    const other = await signedInApi(idp, "admin");
    const team = await newTeam(admin, [ada]);
    const u = unique().replaceAll("-", "");
    const kept = `keptword${u}`;
    const purgedWord = `purgedword${u}`;
    const own = `ownword${u}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: `Handbook ${u}`,
      access: "everyone",
    });
    const first = await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "rules.md",
      text: `# Rules\nAsk ${kept} first.`,
      ifVersion: 0,
    });
    await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "rules.md",
      text: `# Rules\nAsk ${kept} first, then ${purgedWord}.`,
      ifVersion: 1,
    });
    await purged(admin, {
      type: "content",
      documentIds: [first.id],
      terms: [purgedWord],
      reason: "other",
    });
    // Ada's own: her Personal collection, and a record of her own.
    const agent = newAgent();
    await saveUserMemory(
      env,
      actingFor(agent, ada.userId),
      await newChat(agent),
      { type: "own" },
      { text: `# About me\nCall me ${own}.`, ifVersion: 0 }
    );
    await ada.api.knowledge.remember(
      { kind: "fact", text: `I like ${own}.` },
      { idempotencyKey: `key-${unique()}` }
    );
    // And a chat's: its members' alone.
    const chat = await newChat(agent);
    await keepAudience(env, chat, ada.userId, {
      members: [ada.userId],
      outsiders: false,
    });
    await ada.api.knowledge.memoriesPublish(
      {
        scope: "session",
        scopeId: chat.chatId,
        kind: "fact",
        text: `This chat says ${own}.`,
      },
      { idempotencyKey: `key-${unique()}` }
    );
    await ada.api.knowledge.memoriesPublish(
      {
        scope: "team",
        scopeId: team,
        kind: "fact",
        text: `The team asks ${kept}.`,
      },
      { idempotencyKey: `key-${unique()}` }
    );
    const plan = await admin.api.knowledge.prepareBrainExport();
    const { exportId } = await admin.api.knowledge.startBrainExport(plan.token);
    const status = await finished(admin, exportId);
    const manifestResponse = await download(
      admin.session,
      exportId,
      "manifest.json"
    );
    const manifest = await manifestResponse.text();
    const parsed = manifestSchema.parse(JSON.parse(manifest));
    const files = await Promise.all(
      parsed.files.map(async ({ name, sha256: expected }) => {
        const response = await download(admin.session, exportId, name);
        const text = await response.text();
        return { name, text, matches: (await sha256(text)) === expected };
      })
    );
    const all = files.map(({ text }) => text).join("");
    expect({
      state: status.state,
      manifestMatches: (await sha256(manifest)) === status.manifestSha256,
      format: parsed.format,
      checksums: files.every(({ matches }) => matches),
      names: files.map(({ name }) => name.replace(/\d+/u, "N")).toSorted(),
      holds: {
        kept: all.includes(kept),
        // Both versions of the document: its history goes with it.
        versions: all.includes(`Ask ${kept} first."`),
        shared: all.includes(`The team asks ${kept}.`),
        own: all.includes(own),
        purged: all.includes(purgedWord),
        purgeRecord: files.some(
          ({ name, text }) =>
            name === "erasures.jsonl" && text.includes('"type":"purge"')
        ),
      },
      byOther: await statusOf(other.session, exportId, "manifest.json"),
      byMember: await statusOf(ada.session, exportId, "manifest.json"),
      fromElsewhere: await statusOf(admin.session, exportId, "manifest.json", {
        "sec-fetch-site": "cross-site",
      }),
    }).toStrictEqual({
      state: "complete",
      manifestMatches: true,
      format: "grasp-brain-export",
      checksums: true,
      names: [
        "collections.jsonl",
        "documents-N.jsonl",
        "erasures.jsonl",
        "host-collection-teams.jsonl",
        "host-grants.jsonl",
        "memories.jsonl",
      ],
      holds: {
        kept: true,
        versions: true,
        shared: true,
        own: false,
        purged: false,
        purgeRecord: true,
      },
      byOther: 404,
      byMember: 403,
      fromElsewhere: 403,
    });
  });

  it("deletes an export a purge ran during, and lets nobody download it", async () => {
    const admin = await signedInApi(idp, "admin");
    const u = unique().replaceAll("-", "");
    const handbook = await admin.api.knowledge.createCollection({
      name: `Handbook ${u}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "people.md",
      text: `# People\nWrite to during${u}.`,
      ifVersion: 0,
    });
    const plan = await admin.api.knowledge.prepareBrainExport();
    const { exportId } = await admin.api.knowledge.startBrainExport(plan.token);
    // While it is written: before the clock wrote its manifest.
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [`during${u}`],
      reason: "other",
    });
    const status = await finished(admin, exportId);
    expect({
      state: status.state,
      reason: status.reason,
      files: status.files.length,
      download: await statusOf(admin.session, exportId, "manifest.json"),
      left: await env.BRAIN_OBJECTS.head(`exports/${exportId}/manifest.json`),
    }).toStrictEqual({
      state: "failed",
      reason: "knowledge.export_purged",
      files: 0,
      download: 404,
      left: null,
    });
  });

  it("deletes a complete export a purge ran after, before anyone downloads what it erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const u = unique().replaceAll("-", "");
    const handbook = await admin.api.knowledge.createCollection({
      name: `Handbook ${u}`,
      access: "everyone",
    });
    const document = await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "people.md",
      text: `# People\nWrite to after${u}.`,
      ifVersion: 0,
    });
    const plan = await admin.api.knowledge.prepareBrainExport();
    const { exportId } = await admin.api.knowledge.startBrainExport(plan.token);
    const done = await finished(admin, exportId);
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [`after${u}`],
      reason: "other",
    });
    const downloaded = await statusOf(admin.session, exportId, "manifest.json");
    const status = await admin.api.knowledge.brainExportStatus(exportId);
    expect({
      before: done.state,
      download: downloaded,
      state: status.state,
      reason: status.reason,
      left: await env.BRAIN_OBJECTS.head(`exports/${exportId}/manifest.json`),
    }).toStrictEqual({
      before: "complete",
      download: 404,
      state: "failed",
      reason: "knowledge.export_purged",
      left: null,
    });
  });

  it("never holds the onboarding's documents, shows an export to its admin alone, and writes one at a time", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const word = `onboardingword${unique().replaceAll("-", "")}`;
    // As the onboarding keeps a shared document: in a collection of its
    // own, which the export leaves out (core's `OnExport.excluded`).
    const brain = brainOf(env);
    await ensureCollection(
      brain,
      {
        id: collectionIdSchema.parse(onboardingDocumentsCollection),
        name: "Onboarding documents",
        description: "",
        owner: admin.userId,
        access: "admins",
        sensitive: true,
        source: "upload",
        createdAt: new Date(),
      },
      { type: "system" }
    );
    await admin.api.knowledge.saveDocument({
      collectionId: onboardingDocumentsCollection,
      path: `claims-${unique()}.md`,
      text: `# Claims\nTyped into ${word}.`,
      ifVersion: 0,
    });
    const first = await admin.api.knowledge.prepareBrainExport();
    const { exportId } = await admin.api.knowledge.startBrainExport(
      first.token
    );
    const second = await admin.api.knowledge.prepareBrainExport();
    const another = await outcome(
      admin.api.knowledge.startBrainExport(second.token)
    );
    const byOther = await outcome(
      other.api.knowledge.brainExportStatus(exportId)
    );
    const done = await finished(admin, exportId);
    const texts = await Promise.all(
      done.files.map(async ({ name }) => {
        const response = await download(admin.session, exportId, name);
        return await response.text();
      })
    );
    expect({
      another,
      byOther,
      state: done.state,
      holds: texts.join("").includes(word),
    }).toStrictEqual({
      another: "knowledge.conflict",
      byOther: "knowledge.not_found",
      state: "complete",
      holds: false,
    });
  });
});
