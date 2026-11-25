import { toHex } from "@grasp-os/shared/encoding";
import {
  interviewKinds,
  interviewLocales,
  interviewerTextMarkSchema,
} from "@grasp-os/shared/onboarding";
import type {
  InterviewKind,
  InterviewLocale,
} from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { interviewerText } from "../src/onboarding/interviewer-text.ts";
import type { InterviewerText } from "../src/onboarding/interviewer-text.ts";
import {
  everyLabMark,
  labMarks,
  marksDigest,
} from "../src/onboarding/lab-marks.ts";

// What the model that holds an interview is told (src/onboarding/), in
// five languages, with a mark that names it, as the Stephen Lab names the
// text it measures. How it can go wrong:
//
// - A language left half filled in: a placeholder said out loud, or the
//   wrong form of address.
// - A mark that doesn't name its text: two texts with one mark, or a mark
//   the lab can't work out from the text alone.
// - A word changed without its mark: a text held under the name of
//   another, so a measurement or an interview names a Stephen it never met.

interface Which {
  kind: InterviewKind;
  locale: InterviewLocale;
}

const everyText: Which[] = interviewKinds.flatMap((kind) =>
  interviewLocales.map((locale) => ({ kind, locale }))
);

const keyOf = ({ kind, locale }: Which): string => `${kind}/${locale}`;

const built = new Map(
  await Promise.all(
    everyText.map(
      async (which) =>
        [keyOf(which), await interviewerText(which.kind, which.locale)] as const
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
    "fills in every place left for the language ($kind, $locale)",
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

  it("gives him his small words in the language itself", () => {
    const his = textOf({ kind: "own", locale: "nl" });
    expect(his.text).toContain('"Helder." "Duidelijk."');
  });
});

describe("the interview", () => {
  it("is about someone's own work, with an example asked for", () => {
    const { text } = textOf({ kind: "own", locale: "en" });
    expect(text).toContain("# The interview, in order");
    expect(text).not.toContain("# The interview with a team lead");
    expect(text).toContain(
      'ask for one real example to share, and set wants to "file"'
    );
  });

  it("is with a lead about the team's work", () => {
    const { text } = textOf({ kind: "lead", locale: "en" });
    expect(text).toContain("# The interview with a team lead, in order");
    expect(text).not.toContain("# The interview, in order");
  });

  it.each(everyText)(
    "follows up, writes down and reads back ($kind, $locale)",
    (which) => {
      const { text } = textOf(which);
      expect(text).toContain("# Listening closely");
      expect(text).toContain("# What you write down");
      expect(text).toContain('set wants to "readback"');
    }
  );
});

describe("the marks' digest", () => {
  it("names every mark at once, so no text changes under a version's name", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(everyLabMark().join("\n"))
    );
    expect(everyLabMark()).toHaveLength(
      interviewKinds.length * interviewLocales.length
    );
    expect(toHex(new Uint8Array(digest)).slice(0, 12)).toBe(marksDigest);
  });
});

describe("the mark", () => {
  it.each(everyText)(
    "is the one kept for it, so no word changes without its mark and the version's name ($kind, $locale)",
    (which) => {
      expect(textOf(which).mark).toBe(labMarks[which.kind][which.locale]);
    }
  );

  it.each(everyText)(
    "is the SHA-256 of the text the model gets ($kind, $locale)",
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
    const again = await interviewerText("lead", "fr");
    expect(marks.size).toBe(everyText.length);
    expect(again.mark).toBe(textOf({ kind: "lead", locale: "fr" }).mark);
  });
});
