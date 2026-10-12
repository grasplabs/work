/**
 * "Ask before building": a few questions Grasp puts to the person, each with answers to pick,
 * shown in the chat as a short form. The person can always write their own answer instead. The
 * answers go back as their next message, one line per question.
 */

export interface QuestionOption {
  /** The answer in a few words. */
  label: string;
  /** What picking it means, or an empty string. */
  description: string;
}

export interface Question {
  id: string;
  /** One or two words over the question, e.g. "Inbox". */
  header: string;
  question: string;
  options: QuestionOption[];
  /** More than one answer may be picked. */
  multiSelect: boolean;
}

export interface Questions {
  questions: Question[];
}

/** What the person picked or wrote for each question, by question id, in the message that answers them. */
export interface Answers {
  /** The tool call that asked. */
  toolCallId: string;
  picked: Record<string, string[]>;
}

export const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

export const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "One to four questions, the most important first",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "A short lowercase id, unique among these questions",
          },
          header: {
            type: "string",
            description:
              'One or two words shown over the question, e.g. "Inbox" or "Approval"',
          },
          question: {
            type: "string",
            description: "The question, ending with a question mark",
          },
          options: {
            type: "array",
            description:
              'Two to four answers to pick from. Never an "Other" answer: the person can always write their own',
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "The answer in one to five words",
                },
                description: {
                  type: "string",
                  description:
                    "What picking it means, in a few words, or an empty string",
                },
              },
              required: ["label", "description"],
              additionalProperties: false,
            },
          },
          multiSelect: {
            type: "boolean",
            description:
              "True only when more than one answer can apply at the same time",
          },
        },
        required: ["id", "header", "question", "options", "multiSelect"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

/** What a model's questions lack, in words the model can act on. */
export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

const tags = /<\/?[a-z][\w:-]*[^>]*>/giu;
const notSlug = /[^a-z0-9]+/gu;
const edgeDashes = /^-|-$/gu;
const spaces = /\s+/gu;

/** Tool-call markup a model sometimes leaks into a field is not part of anyone's words. */
const clean = (value: string): string => value.replaceAll(tags, "").trim();

const slug = (value: string): string =>
  value.toLowerCase().replaceAll(notSlug, "-").replaceAll(edgeDashes, "");

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const record = (input: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(input)) {
    throw new DraftError(`Missing ${what}`);
  }
  return input;
};

const array = (input: unknown, what: string): unknown[] => {
  if (!Array.isArray(input)) {
    throw new DraftError(`Missing ${what}`);
  }
  return input;
};

const text = (input: unknown, what: string): string => {
  const value = typeof input === "string" ? clean(input) : "";
  if (value === "") {
    throw new DraftError(`Missing ${what}`);
  }
  return value;
};

const short = (value: string, max: number): string => {
  const cleaned = clean(value).replaceAll(spaces, " ");
  return cleaned.length > max
    ? `${cleaned.slice(0, max - 1).trimEnd()}…`
    : cleaned;
};

/** A question's answers: each one once, ignoring case, and only those with a label. */
const optionsOf = (input: unknown, n: number): QuestionOption[] => {
  const labels = new Set<string>();
  return array(input, `answers to question ${n}`).flatMap(
    (rawOption): QuestionOption[] => {
      const option = isRecord(rawOption) ? rawOption : {};
      const label =
        typeof option.label === "string" ? short(option.label, 60) : "";
      if (label === "" || labels.has(label.toLowerCase())) {
        return [];
      }
      labels.add(label.toLowerCase());
      return [
        {
          label,
          description:
            typeof option.description === "string"
              ? short(option.description, 140)
              : "",
        },
      ];
    }
  );
};

/** Checks the questions: each has a header and two to four different answers, and its own id. */
export const parseQuestions = (input: unknown): Questions => {
  const root = record(input, "questions");
  const seen = new Set<string>();
  const questions = array(root.questions, "questions")
    .slice(0, MAX_QUESTIONS)
    .map((raw, index): Question => {
      const n = index + 1;
      const question = record(raw, `question ${n}`);
      const options = optionsOf(question.options, n);
      if (options.length < 2) {
        throw new DraftError(
          `Question ${n} needs two to four different answers`
        );
      }
      const given = typeof question.id === "string" ? slug(question.id) : "";
      let id = given === "" ? `question-${n}` : given;
      if (seen.has(id)) {
        id = `${id}-${n}`;
      }
      seen.add(id);
      return {
        id,
        header: short(text(question.header, `header of question ${n}`), 24),
        question: short(text(question.question, `question ${n}`), 200),
        options: options.slice(0, MAX_OPTIONS),
        multiSelect: question.multiSelect === true,
      };
    });
  if (questions.length === 0) {
    throw new DraftError("Ask at least one question");
  }
  return { questions };
};

/** The person's answers as their own message: one line per answered question, "Header: answer". */
export const answersText = (
  questions: Question[],
  picked: Record<string, string[]>
): string =>
  questions
    .flatMap((question) => {
      const answer = (picked[question.id] ?? [])
        .map((each) => each.trim())
        .filter(Boolean);
      return answer.length > 0
        ? [`${question.header}: ${answer.join(", ")}`]
        : [];
    })
    .join("\n");
