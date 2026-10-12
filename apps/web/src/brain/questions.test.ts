import { describe, expect, it } from "vite-plus/test";

import { answersText, DraftError, parseQuestions } from "./questions.ts";

// The prototype's tests of the questions Grasp asks before building.

const option = (label: string, description = "") => ({ label, description });

describe(parseQuestions, () => {
  it("keeps up to four questions, each with its own id and two to four different answers", () => {
    const { questions } = parseQuestions({
      questions: [
        {
          id: "Inbox?",
          header: "Inbox",
          question: "Which emails?",
          options: [
            option("All of them"),
            option("all of them"),
            option("Only some senders"),
          ],
          multiSelect: false,
        },
        {
          id: "inbox",
          header: "Slack",
          question: "Where in Slack?",
          options: [option("A message to me"), option("A channel")],
          multiSelect: false,
        },
        ...["a", "b", "c"].map((id) => ({
          id,
          header: id,
          question: `${id}?`,
          options: [option("Yes"), option("No")],
          multiSelect: true,
        })),
      ],
    });
    expect(questions).toHaveLength(4);
    expect(questions[0]?.id).toBe("inbox");
    // The same answer twice counts once; a second question with the same id gets its own.
    expect(questions[0]?.options.map((each) => each.label)).toStrictEqual([
      "All of them",
      "Only some senders",
    ]);
    expect(questions[1]?.id).toBe("inbox-2");
    expect(questions[2]?.multiSelect).toBeTruthy();
  });

  it("gives each question its own id, though one it gave itself is another's suffixed id", () => {
    const question = (id: string) => ({
      id,
      header: "Pick",
      question: "Which one?",
      options: [option("This"), option("That")],
    });
    const { questions } = parseQuestions({
      questions: [question("x-3"), question("x"), question("x")],
    });
    expect(questions.map(({ id }) => id)).toStrictEqual(["x-3", "x", "x-4"]);
  });

  it("needs two different answers to pick from", () => {
    expect(() =>
      parseQuestions({
        questions: [
          {
            id: "x",
            header: "X",
            question: "X?",
            options: [option("Yes"), option("yes")],
            multiSelect: false,
          },
        ],
      })
    ).toThrow(DraftError);
    expect(() => parseQuestions({ questions: [] })).toThrow(DraftError);
  });
});

describe(answersText, () => {
  it("writes one line per answered question, with several answers joined", () => {
    const { questions } = parseQuestions({
      questions: [
        {
          id: "slack",
          header: "Slack",
          question: "Where?",
          options: [option("A message to me"), option("A channel")],
          multiSelect: false,
        },
        {
          id: "after",
          header: "After approval",
          question: "Then?",
          options: [option("Send it"), option("Keep the draft")],
          multiSelect: true,
        },
        {
          id: "volume",
          header: "Volume",
          question: "How many?",
          options: [option("About 10 a day"), option("About 50 a day")],
          multiSelect: false,
        },
      ],
    });
    expect(
      answersText(questions, {
        slack: ["A message to me"],
        after: ["Send it", " Log it in Sheets "],
        volume: [],
      })
    ).toBe("Slack: A message to me\nAfter approval: Send it, Log it in Sheets");
  });
});
