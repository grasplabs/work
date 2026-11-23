import { describe, expect, it } from "vite-plus/test";

import { actionWords } from "./audit-words.ts";

/** What `action` reads as, in English. */
const said = (action: string): string | undefined =>
  actionWords(action)?.message;

describe("an audit entry's words", () => {
  it("say what was done to an upload into the Brain, each in its own words", () => {
    const uploadActions = [
      "brain.upload.added",
      "brain.upload.refused",
      "brain.upload.failed",
      "brain.upload.deleted",
      "brain.upload.delete_failed",
      "brain.upload.listed",
    ];
    const words = uploadActions.map((action) => said(action));
    expect({
      erased: said("brain.upload.deleted"),
      allSaid: words.every((each) => each !== undefined),
      distinct: new Set(words.slice(1)).size,
    }).toStrictEqual({
      erased: "Erased an upload from the Brain for good",
      allSaid: true,
      distinct: uploadActions.length - 1,
    });
  });

  it("say code read the Brain's skills, apart from a release installing them", () => {
    expect({
      select: said("brain.skills.select"),
      read: said("brain.skills.read"),
      installed: said("brain.skills.installed"),
    }).toStrictEqual({
      select: "Read skills from the Brain",
      read: "Read skills from the Brain",
      installed: "Installed Grasp's skills with a release",
    });
  });

  it("say what was done to a project, and to a chat filed in one, each in its own words", () => {
    const projectActions = [
      "project.created",
      "project.updated",
      "project.deleted",
      "project.item.filed",
      "project.item.unfiled",
      "project.member.added",
      "project.member.removed",
      "chat.filed",
      "chat.unfiled",
    ];
    const words = projectActions.map((action) => said(action));
    expect({
      filed: said("chat.filed"),
      allSaid: words.every((each) => each !== undefined),
      distinct: new Set(words).size,
    }).toStrictEqual({
      filed: "Added a chat to a project",
      allSaid: true,
      distinct: projectActions.length,
    });
  });

  it("say code read entities, each by its own name", () => {
    expect({
      get: said("brain.entities.get"),
      find: said("brain.entities.find"),
    }).toStrictEqual({
      get: "Read entities from the Brain",
      find: "Read entities from the Brain",
    });
  });
});
