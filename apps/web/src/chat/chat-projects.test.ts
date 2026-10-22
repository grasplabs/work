import type { ChatSummary } from "@grasp-os/shared/chat";
import {
  projectDocumentMaxBytes,
  projectDocumentsMax,
} from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { chatsByProject, documentProblem } from "./chat-projects.ts";

const chat = (id: string, projectId: string | null): ChatSummary => ({
  id,
  title: id,
  createdAt: "2026-10-20T08:00:00.000Z",
  lastAt: "2026-10-20T08:00:00.000Z",
  running: false,
  projectId,
});

describe("a project's documents", () => {
  it("take the text files core takes, up to its size and count", () => {
    expect({
      markdown: documentProblem({ name: "Brief.md", size: 10 }, 0),
      csv: documentProblem({ name: "figures.CSV", size: 10 }, 0),
      pdf: documentProblem({ name: "report.pdf", size: 10 }, 0),
      noExtension: documentProblem({ name: "notes", size: 10 }, 0),
      atLimit: documentProblem(
        { name: "big.txt", size: projectDocumentMaxBytes },
        0
      ),
      tooLarge: documentProblem(
        { name: "big.txt", size: projectDocumentMaxBytes + 1 },
        0
      ),
      full: documentProblem({ name: "one.md", size: 1 }, projectDocumentsMax),
      lastOne: documentProblem(
        { name: "one.md", size: 1 },
        projectDocumentsMax - 1
      ),
    }).toStrictEqual({
      markdown: null,
      csv: null,
      pdf: "type",
      noExtension: "type",
      atLimit: null,
      tooLarge: "size",
      full: "count",
      lastOne: null,
    });
  });
});

describe("chats by project", () => {
  it("puts each chat under its project in list order, and the rest outside", () => {
    const { inProject, outside } = chatsByProject(
      [chat("a", "p1"), chat("b", null), chat("c", "p1"), chat("d", "gone")],
      [{ id: "p1" }, { id: "p2" }]
    );
    expect({
      p1: inProject.get("p1")?.map(({ id }) => id),
      p2: inProject.get("p2")?.map(({ id }) => id),
      outside: outside.map(({ id }) => id),
    }).toStrictEqual({ p1: ["a", "c"], p2: [], outside: ["b", "d"] });
  });
});
