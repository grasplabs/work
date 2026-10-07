import { toHex } from "@grasp-os/shared/encoding";
import {
  interviewKinds,
  interviewLocales,
  interviewers,
  interviewerTextMarkSchema,
} from "@grasp-os/shared/onboarding";
import type {
  InterviewKind,
  InterviewLocale,
  Interviewer,
} from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { asClaire } from "../src/onboarding/claire.ts";
import { interviewerText } from "../src/onboarding/interviewer-text.ts";
import type { InterviewerText } from "../src/onboarding/interviewer-text.ts";

// What the model that holds an interview is told (src/onboarding/): the
// same text the Stephen Lab measures, in five languages, for Stephen and
// for Claire, with a mark that names it. How it can go wrong:
//
// - Claire drifts from Stephen: a rule of his for how to talk missing or
//   changed in hers, so the two interviews can no longer be laid side by
//   side; or he becomes her, or she him.
// - A language left half filled in: a placeholder said out loud, or the
//   wrong form of address.
// - A mark that doesn't name its text: two texts with one mark, or a mark
//   the lab can't work out from the text alone.

interface Which {
  interviewer: Interviewer;
  kind: InterviewKind;
  locale: InterviewLocale;
}

const everyText: Which[] = interviewers.flatMap((interviewer) =>
  interviewKinds.flatMap((kind) =>
    interviewLocales.map((locale) => ({ interviewer, kind, locale }))
  )
);

const keyOf = ({ interviewer, kind, locale }: Which): string =>
  `${interviewer}/${kind}/${locale}`;

const built = new Map(
  await Promise.all(
    everyText.map(
      async (which) =>
        [
          keyOf(which),
          await interviewerText(which.interviewer, which.kind, which.locale),
        ] as const
    )
  )
);

const textOf = (which: Which): InterviewerText => {
  const text = built.get(keyOf(which));
  if (text === undefined) {
    throw new Error(`No text for ${keyOf(which)}`);
  }
  return text;
};

const rulesHead = "\n\n# How you talk\n";
const ownWayHead = "# Your own way";

/** His rules for how to talk: from their heading to the interview's parts. */
const rulesOf = (text: string): string =>
  text.slice(text.indexOf(rulesHead), text.indexOf("\n\n# The interview"));

const kindsAndLocales = interviewKinds.flatMap((kind) =>
  interviewLocales.map((locale) => ({ kind, locale }))
);

describe("Claire", () => {
  it.each(kindsAndLocales)(
    "keeps every rule of his for how to talk, word for word, with her own way after them ($kind, $locale)",
    ({ kind, locale }) => {
      const his = textOf({ interviewer: "stephen", kind, locale }).text;
      const hers = textOf({ interviewer: "claire", kind, locale }).text;
      const rules = rulesOf(his);
      expect(rules.length).toBeGreaterThan(500);
      expect(hers).toContain(rules);
      expect(hers.indexOf(ownWayHead)).toBeGreaterThan(hers.indexOf(rules));
    }
  );

  it.each(kindsAndLocales)(
    "is herself and never Stephen ($kind, $locale)",
    ({ kind, locale }) => {
      const hers = textOf({ interviewer: "claire", kind, locale }).text;
      expect(hers).toContain(
        "You are Claire, an AI interviewer who works for Grasp."
      );
      expect(hers).not.toContain("Stephen");
      // Who he is makes way for who she is: it is not said twice.
      expect(hers).not.toContain("Upbeat, curious and practical");
      expect(hers.match(/# Who you are/gu)).toHaveLength(1);
    }
  );

  it.each(kindsAndLocales)(
    "leaves him as he is ($kind, $locale)",
    ({ kind, locale }) => {
      const his = textOf({ interviewer: "stephen", kind, locale }).text;
      expect(his).toContain(
        "You are Stephen, an AI interviewer who works for Grasp."
      );
      expect(his).not.toContain("Claire");
      expect(his).not.toContain(ownWayHead);
    }
  );

  it("never praises or fills in her own examples either", () => {
    const hers = textOf({
      interviewer: "claire",
      kind: "own",
      locale: "en",
    }).text;
    const own = hers.slice(hers.indexOf(ownWayHead));
    expect(own).not.toMatch(
      /\babsolutely\b|\btotally\b|\bno worries\b|great (?:question|answer)|i (?:completely|totally|fully) understand/iu
    );
  });

  it("is still Claire when his text is laid out another way", () => {
    const odd = asClaire(
      "You are Stephen, an interviewer.\n\n## About you\nUpbeat."
    );
    expect(odd).toContain("You are Claire,");
    expect(odd).not.toContain("Stephen");
    expect(odd).toContain("Warm, quick and a little playful");
    expect(odd).toContain(ownWayHead);
  });
});

describe("the languages", () => {
  const address: Record<InterviewLocale, string> = {
    en: "Speak English.",
    nl: 'Say "je".',
    de: 'Say "Sie".',
    fr: 'Say "vous".',
    es: 'Say "tú".',
  };
  const named: Record<InterviewLocale, string> = {
    en: "English",
    nl: "Dutch",
    de: "German",
    fr: "French",
    es: "Spanish",
  };

  it.each(everyText)(
    "fills in every place left for the language ($interviewer, $kind, $locale)",
    (which) => {
      const { text } = textOf(which);
      expect(text).not.toMatch(/\{(?:language|small words)[^}]*\}/u);
      expect(text).toContain(address[which.locale]);
      expect(text).toContain(`Every word you say is ${named[which.locale]}`);
      // What is written down is read back in the interview's language.
      expect(text).toContain(
        `always in ${named[which.locale]}, whatever language`
      );
    }
  );

  it("gives each interviewer small words of their own in the language itself", () => {
    const his = textOf({ interviewer: "stephen", kind: "own", locale: "nl" });
    const hers = textOf({ interviewer: "claire", kind: "own", locale: "nl" });
    expect(his.text).toContain('"Helder." "Duidelijk."');
    expect(hers.text).toContain('"Ah, oké." "O ja."');
    expect(hers.text).toContain("say them in Dutch");
  });
});

describe("the interview", () => {
  it.each(interviewers)(
    "is about someone's own work, with an example asked for ($0)",
    (interviewer) => {
      const { text } = textOf({ interviewer, kind: "own", locale: "en" });
      expect(text).toContain("# The interview, in order");
      expect(text).not.toContain("# The interview with a team lead");
      expect(text).toContain(
        'ask for one real example to share, and set wants to "file"'
      );
    }
  );

  it.each(interviewers)(
    "is with a lead about the team's work ($0)",
    (interviewer) => {
      const { text } = textOf({ interviewer, kind: "lead", locale: "en" });
      expect(text).toContain("# The interview with a team lead, in order");
      expect(text).not.toContain("# The interview, in order");
    }
  );

  it.each(everyText)(
    "follows up, writes down and reads back ($interviewer, $kind, $locale)",
    (which) => {
      const { text } = textOf(which);
      expect(text).toContain("# Listening closely");
      expect(text).toContain("# What you write down");
      expect(text).toContain('set wants to "readback"');
    }
  );
});

describe("the mark", () => {
  it.each(everyText)(
    "is the SHA-256 of the text the model gets ($interviewer, $kind, $locale)",
    async (which) => {
      const { text, mark } = textOf(which);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text)
      );
      expect(interviewerTextMarkSchema.safeParse(mark).success).toBeTruthy();
      expect(mark).toBe(toHex(new Uint8Array(digest)));
    }
  );

  it("names one text: each has its own, and the same text the same", async () => {
    const marks = new Set(everyText.map((which) => textOf(which).mark));
    const again = await interviewerText("claire", "lead", "fr");
    expect(marks.size).toBe(everyText.length);
    expect(again.mark).toBe(
      textOf({ interviewer: "claire", kind: "lead", locale: "fr" }).mark
    );
  });
});
