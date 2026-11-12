import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { forContext } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  newAgent,
  purged,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import {
  storedVersionTexts as versionTexts,
  storeTextUnderneath,
} from "./knowledge.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Purging personal data from Knowledge. These tests start from the ways a
// purge can fail or be abused: the text survives somewhere (an earlier
// version, a section, a title, the search index's pages, a Brain memory, memory cached
// by version); the purge record in the audit log,
// which can't be purged, carries the text it removed; a purge reaches
// documents it wasn't aimed at; someone other than the client's admins
// purges, or purges without confirming, or confirms a purge other than the
// one prepared; and a purge leaves a document that can't be read.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

describe("a purge of content", setUpTime, () => {
  it("rewrites every version of the documents named, and only those", async () => {
    const admin = await personOf("admin");
    // Another admin's collection for everyone: another person's own is
    // theirs alone.
    const owner = await personOf("admin");
    const name = `Jansen${unique()}`;
    const email = `${name.toLowerCase()}.j@acme.test`;
    const notes = await owner.api.knowledge.createCollection({
      name: "Notes",
      access: "everyone",
    });
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# Leave\nAsk ${name} (${email}) about it.`
    );
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toUpperCase()} about it.\n\n## More\nNothing else.`,
      `About ${name}`
    );
    const leave = await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toLowerCase()} about it.\n\n## More\nNothing else. See [[other.md]].`
    );
    const other = await saveOver(
      owner,
      notes.id,
      "other.md",
      `# Other\n${name} is here too.`
    );
    const memory = await admin.api.memory.collections();
    const memoryId = memory.memory ?? "";
    const company = await saveOver(
      admin,
      memoryId,
      "MEMORY.md",
      `# Company\n${name} runs payroll.`
    );
    const agent = newAgent();
    const work = await newChat(agent);
    const asAgent = actingFor(agent, admin.userId);
    const before = await forContext(env, asAgent, work, { type: "own" });

    const input: PurgeInput = {
      type: "content",
      documentIds: [leave.id, company.id],
      terms: [name, email],
      reason: "erasure_request",
    };
    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });

    const after = await forContext(env, asAgent, work, { type: "own" });
    const current = await owner.api.knowledge.getDocument(leave.id);
    const hits = await owner.api.knowledge.search(name);
    const backlinks = await owner.api.knowledge.backlinks(other.id);
    const history = await owner.api.knowledge.history(leave.id);
    const companyTexts = await versionTexts(company.id);
    expect({
      plan: {
        documents: outcomeOf?.plan.documents,
        versions: outcomeOf?.plan.versions,
        inLongerWords: outcomeOf?.plan.inLongerWords,
      },
      result: {
        ...outcomeOf?.result,
        purgeId: typeof outcomeOf?.result.purgeId,
      },
      leave: await versionTexts(leave.id),
      history: history.versions.map(({ message }) => message),
      title: current.title,
      other: await versionTexts(other.id),
      // Earlier tests saved MEMORY.md too.
      company: companyTexts.filter(
        (text) => text.includes(name) || text.includes("(removed)")
      ),
      memoryBefore: before.text.includes(name),
      memoryAfter: after.text.includes(name),
      memoryKeyChanged: after.key !== before.key,
      hits: hits.hits.map(({ documentId }) => documentId),
      backlinks: backlinks.backlinks.map(({ documentId }) => documentId),
    }).toStrictEqual({
      plan: { documents: 2, versions: 4, inLongerWords: 0 },
      result: {
        purgeId: "string",
        documents: 2,
        versions: 4,
        stillFound: 0,
      },
      leave: [
        "# Leave\nAsk (removed) ((removed)) about it.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
        // Saved again, so its sections, title and search rows are made
        // again, and anyone who saved meanwhile conflicts.
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
      ],
      history: ["Personal data removed", null, "About (removed)", null],
      title: "(removed)'s leave",
      other: [`# Other\n${name} is here too.`],
      company: [
        "# Company\n(removed) runs payroll.",
        "# Company\n(removed) runs payroll.",
      ],
      memoryBefore: true,
      memoryAfter: false,
      memoryKeyChanged: true,
      hits: [other.id],
      backlinks: [leave.id],
    });
    expect({
      events: events
        .filter(({ action }) => action.startsWith("knowledge.purge"))
        .map(({ action, provenance, detail }) => ({
          action,
          provenance: provenance.toSorted(),
          detail,
        })),
      carriesText: [name, email].some((term) =>
        JSON.stringify(events).toLowerCase().includes(term.toLowerCase())
      ),
    }).toStrictEqual({
      events: [
        {
          action: "knowledge.purge.prepared",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
            versions: 4,
            occurrences: 8,
            inLongerWords: 0,
            memories: 0,
            hostCopies: 0,
          },
        },
        {
          action: "knowledge.purged",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            purgeId: outcomeOf?.result.purgeId,
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
          },
        },
      ],
      carriesText: false,
    });
  });

  it("removes a term typed with a combining accent from text typed the same way", async () => {
    const admin = await personOf("admin");
    const decomposed = `Rene\u0301${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${decomposed} runs payroll.`
    );
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [decomposed],
      reason: "erasure_request",
    });
    expect({
      occurrences: plan.occurrences,
      stillFound: result.stillFound,
      texts: await versionTexts(document.id),
    }).toStrictEqual({
      occurrences: 1,
      stillFound: 0,
      texts: [
        "# Team\n(removed) runs payroll.",
        "# Team\n(removed) runs payroll.",
      ],
    });
  });

  it("leaves frontmatter that still reads, where a name is the title, owner or a tag", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const email = `${name.toLowerCase()}@acme.test`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "person.md",
      `---\ntitle: ${name}\nowner: ${email}\ntags: [${name}, hr]\n---\n# Profile\n${name} works in HR.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [name, email],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      title: read.title,
      owner: read.owner,
      tags: read.tags,
      text: read.version.text,
    }).toStrictEqual({
      title: "(removed)",
      owner: "(removed)",
      tags: ["(removed)", "hr"],
      text: "---\ntitle: (removed)\nowner: (removed)\ntags: [(removed), hr]\n---\n# Profile\n(removed) works in HR.",
    });
  });

  it("purges a document whose type this release doesn't know, which then saves as a type it does", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "tasks/offboard.md",
      `# Offboard\n${name} returns the laptop.`
    );
    // As an App once declared it: a `task`, which nothing declares now.
    const task = `---\ntype: task\nstatus: open\n---\n# Offboard\n${name} returns the laptop.`;
    await env.KNOWLEDGE.batch([
      ...(await storeTextUnderneath(document.id, task)),
      env.KNOWLEDGE.prepare("UPDATE documents SET type = ? WHERE id = ?").bind(
        "task",
        document.id
      ),
    ]);

    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    const saved = await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "tasks/offboard.md",
      text: "---\ntype: doc\n---\n# Offboard\nThe laptop is returned.",
      ifVersion: read.currentVersion,
    });

    expect({
      texts: await versionTexts(document.id),
      saved: { type: saved.type, version: saved.currentVersion },
    }).toStrictEqual({
      texts: [
        // The version it held, rewritten, and the version the purge saves.
        "---\ntype: task\nstatus: open\n---\n# Offboard\n(removed) returns the laptop.",
        "---\ntype: task\nstatus: open\n---\n# Offboard\n(removed) returns the laptop.",
        "---\ntype: doc\n---\n# Offboard\nThe laptop is returned.",
      ],
      saved: { type: "doc", version: 3 },
    });
  });

  it("removes a term as a whole word, in any case and next to punctuation, and counts where it is inside a longer word", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "team.md", "# Team\nTom planned it.");
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nTom planned it, tom automated it (Tom). Ask Tom, then Tomas or Ann's team.\nMail tom.visser@acme.test or Tom.Visser@ACME.test, not atom.visser@acme.test."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom", "Ann", "tom.visser@acme.test"],
      reason: "offboarding",
    });
    const purgedText =
      "# Team\n(removed) planned it, (removed) automated it ((removed)). Ask (removed), then Tomas or (removed)'s team.\nMail (removed) or (removed), not atom.visser@acme.test.";
    expect({
      versions: await versionTexts(document.id),
      // Left inside or at the start of a longer word or address, which a
      // search for part of a word still finds: "planned" in the first
      // version; "planned", "automated", "Tomas" and
      // "atom.visser@acme.test" in the second and in the one the purge
      // saves.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      // The two saved, and the one saved as the purge's.
      versions: ["# Team\n(removed) planned it.", purgedText, purgedText],
      inLongerWords: 9,
    });
  });

  it("counts the forms left in every version it leaves, the one it saves too", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nTom Tomas"
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom"],
      reason: "offboarding",
    });
    expect({
      versions: await versionTexts(document.id),
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      versions: ["# Team\n(removed) Tomas", "# Team\n(removed) Tomas"],
      inLongerWords: 2,
    });
  });

  it("treats an address or a domain as one word, never found inside a longer one, and removes it next to punctuation", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "mail.md",
      "# Mail\nNot tom.visser@acme.test.evil or evil.tom.visser@acme.test, but tom.visser@acme.test.\nOr (tom.visser@acme.test)."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["tom.visser@acme.test"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      // Both longer addresses, in the version saved and in the one the
      // purge saves.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Mail\nNot tom.visser@acme.test.evil or evil.tom.visser@acme.test, but (removed).\nOr ((removed)).",
      inLongerWords: 4,
    });
  });

  it("removes a name with a hyphen in it", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nAnne-Marie left; Anne stays."
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Anne-Marie"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe("# Team\n(removed) left; Anne stays.");
  });

  it("removes a term left joined only by a term removed next to it, and finds nothing when run again", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nTom.Ann left."
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom.", "Ann"],
      reason: "offboarding",
    };
    await purged(admin, input);
    const read = await admin.api.knowledge.getDocument(document.id);
    const again = await admin.api.knowledge.preparePurge(input);
    expect({
      text: read.version.text,
      again: {
        documents: again.documents,
        versions: again.versions,
      },
    }).toStrictEqual({
      text: "# Log\n(removed)(removed) left.",
      again: { documents: 0, versions: 0 },
    });
  });

  it("counts the forms left once the terms are removed", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nToms desk is empty."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom", "Toms"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Team\n(removed) desk is empty.",
      inLongerWords: 0,
    });
  });

  it("removes a name wrapped in invisible marks that don't join words", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // A bidi isolate pair, left-to-right and right-to-left marks, and a
    // byte order mark: text copied from chats and PDFs carries them.
    const [isolate, popIsolate, leftToRight, rightToLeft, byteOrderMark] = [
      0x20_68, 0x20_69, 0x20_0e, 0x20_0f, 0xfe_ff,
    ].map((codePoint) => String.fromCodePoint(codePoint));
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${isolate}Tom${popIsolate} left, ${leftToRight}Tom${rightToLeft} left, ${byteOrderMark}Tom left.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      `# Team\n${isolate}(removed)${popIsolate} left, ${leftToRight}(removed)${rightToLeft} left, ${byteOrderMark}(removed) left.`
    );
  });

  it("needs nothing next to a side of a term that can't join a word", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nTom left.Next day, Tom left.\nAtom left.Now\na(Tom)b and Tom张伟"
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom left.", "(Tom)", "张伟"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    // Only "Atom left." stays: there the term starts with a letter, which
    // the "A" before it joins.
    expect(read.version.text).toBe(
      "# Log\n(removed)Next day, (removed)\nAtom left.Now\na(removed)b and Tom(removed)"
    );
  });

  it("finds whole words in any script, with accents as part of the word and what ends the index's token ending it", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // "José" twice: once with its accent as one character, which only a
    // Unicode-aware boundary keeps from ending "Jos", and once as an e and
    // a combining acute. The index drops the accent from both, so both are
    // "Jose" to it, and go with that term. "Renée" is a longer word than
    // "René" and stays. A soft hyphen and a zero-width non-joiner end a
    // word, as they end the index's token.
    const decomposed = `Jose${String.fromCodePoint(0x3_01)}`;
    const softHyphen = String.fromCodePoint(0xad);
    const nonJoiner = String.fromCodePoint(0x20_0c);
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\nRené, rené and RENÉ left; Renée stays.\nJos, Jose, ${decomposed} and José left.\nTom left; Tom${softHyphen}my and Tom${nonJoiner}s go.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["René", "Jos", "Jose", "Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      `# Team\n(removed), (removed) and (removed) left; Renée stays.\n(removed), (removed), (removed) and (removed) left.\n(removed) left; (removed)${softHyphen}my and (removed)${nonJoiner}s go.`
    );
  });

  it("finds a term inside running text in scripts written without spaces", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\n我和张伟去了。我和Tom去了。\nฉันกับสมชายไปตลาด\nTomas stays."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["张伟", "สมชาย", "Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      // Only "Tomas", in the version saved and the one the purge saves:
      // the letters around the others don't make them longer.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Team\n我和(removed)去了。我和(removed)去了。\nฉันกับ(removed)ไปตลาด\nTomas stays.",
      inLongerWords: 2,
    });
  });

  it("leaves frontmatter values that hold a term inside a word, so it can purge the document", async () => {
    const admin = await personOf("admin");
    const decisions = await admin.api.knowledge.createCollection({
      name: "Decisions",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      decisions.id,
      "tooling.md",
      "---\ntype: decision\nstatus: accepted\n---\n# Tooling\nTed accepted it, as Ann planned."
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Ted", "Ann"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      "---\ntype: decision\nstatus: accepted\n---\n# Tooling\n(removed) accepted it, as (removed) planned."
    );
  });

  it("rewrites every version, however many there are", async () => {
    const admin = await personOf("admin");
    const name = `Bakker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const saved = 23;
    let documentId = "";
    for (let number = 1; number <= saved; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one version after another
      const summary = await saveOver(
        admin,
        handbook.id,
        "log.md",
        `# Log\n${name} did thing ${number}.`
      );
      documentId = summary.id;
    }
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const texts = await versionTexts(documentId);
    // Run again once finished: nothing found, nothing written.
    const again = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const textsAgain = await versionTexts(documentId);
    expect({
      planned: plan.versions,
      rewritten: result.versions,
      versions: texts.length,
      holding: texts.filter((text) => text.includes(name)).length,
      last: texts.at(-1),
      again: { ...again.result, purgeId: typeof again.result.purgeId },
      unchanged: textsAgain,
    }).toStrictEqual({
      planned: saved,
      rewritten: saved,
      versions: saved + 1,
      holding: 0,
      last: `# Log\n(removed) did thing ${saved}.`,
      again: { purgeId: "string", documents: 0, versions: 0, stillFound: 0 },
      unchanged: texts,
    });
  });

  it("purges more documents than one statement may bind values for", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // Past 25: four values each, 100 a statement at most.
    const named = 30;
    const documentIds: string[] = [];
    for (let number = 1; number <= named; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document after another
      const summary = await saveOver(
        admin,
        handbook.id,
        `page-${number}.md`,
        `# Page ${number}\n${name} wrote it.`
      );
      documentIds.push(summary.id);
    }
    const { result } = await purged(admin, {
      type: "content",
      documentIds,
      terms: [name],
      reason: "other",
    });
    const stillHolding = await Promise.all(
      documentIds.map(async (documentId) => {
        const texts = await versionTexts(documentId);
        return texts.some((text) => text.includes(name));
      })
    );

    expect({
      documents: result.documents,
      holding: stillHolding.filter(Boolean).length,
    }).toStrictEqual({ documents: named, holding: 0 });
  });

  it("saves a new version when only earlier versions held a term", async () => {
    const admin = await personOf("admin");
    const name = `Dekker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} was here.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      "# Note\nNobody here."
    );
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    });
    const { versions } = await admin.api.knowledge.history(note.id);
    expect({
      versions: result.versions,
      texts: await versionTexts(note.id),
      messages: versions.map(({ message }) => message),
    }).toStrictEqual({
      versions: 1,
      // So anyone who restored the first before it was purged conflicts.
      texts: [
        "# Note\n(removed) was here.",
        "# Note\nNobody here.",
        "# Note\nNobody here.",
      ],
      messages: ["Personal data removed", null, null],
    });
  });

  it("fails for a save made from text not yet purged, and finishes when run again", async () => {
    const admin = await personOf("admin");
    const name = `Smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} one.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      `# Note\n${name} two.`
    );
    // Knowledge as the purge's request sees it: once the document's step
    // rewrote its earlier version, before it saves the current one,
    // someone saves from the text they had open. (A save before the step
    // began is purged by it: the step reads the document as it begins.)
    let rewriting = false;
    let saved = false;
    const racing = await apiWith(admin, {
      prepare: (query) => {
        rewriting ||= query.startsWith('update "versions"');
      },
      afterBatch: async () => {
        if (rewriting && !saved) {
          saved = true;
          await saveOver(admin, handbook.id, "note.md", `# Note\n${name} 3.`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(racing.knowledge.purge(input, token));
    const afterFirst = await versionTexts(note.id);
    const again = await purged(admin, input);
    expect({
      saved,
      first,
      afterFirst: afterFirst.map((text) => text.includes(name)),
      again: again.result.versions,
      documents: again.result.documents,
      afterAgain: await versionTexts(note.id),
    }).toStrictEqual({
      saved: true,
      first: "knowledge.conflict",
      // The earlier version was rewritten; the current one, and the one
      // saved meanwhile, weren't.
      afterFirst: [false, true, true],
      // In all: the earlier version the first run rewrote, its count kept
      // with it, and the two the run again rewrote.
      again: 3,
      // One document, though two runs changed it.
      documents: 1,
      afterAgain: [
        "# Note\n(removed) one.",
        "# Note\n(removed) two.",
        "# Note\n(removed) 3.",
        "# Note\n(removed) 3.",
      ],
    });
  });

  it("refuses, before changing anything, a purge that makes an earlier version too large to store", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const log = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nQz was here."
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [log.id],
      terms: ["Qz"],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // 600 KB, within a document's 1 MB; 2 MB once each "Qz" is "(removed)".
    const huge = `# Log\n${"Qz ".repeat(200_000)}`;
    await saveOver(admin, handbook.id, "log.md", huge);
    await saveOver(admin, handbook.id, "log.md", "# Log\nNothing else.");
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(admin.api.knowledge.purge(input, token));
    });
    const texts = await versionTexts(log.id);
    expect({
      refused,
      prepared: await outcome(admin.api.knowledge.preparePurge(input)),
      purged: events.filter(({ action }) => action === "knowledge.purged")
        .length,
      first: texts[0],
      hugeKept: texts[1] === huge,
      versions: texts.length,
    }).toStrictEqual({
      refused: "knowledge.invalid",
      prepared: "knowledge.invalid",
      purged: 0,
      first: "# Log\nQz was here.",
      hugeKept: true,
      versions: 3,
    });
  });
});
