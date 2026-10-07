import type {
  InterviewKind,
  InterviewLocale,
  Interviewer,
} from "@grasp-os/shared/onboarding";

// The marks of the texts the Stephen Lab measures (interviewer-text.ts),
// one per interviewer, kind of interview and language: the text on the
// prototype's main at 48534d4 (grasplabs/prototype, packages/grasp), after
// the lab's round of 5 October and the interview's audit of the same day.
// Core speaks only a text whose mark is here, and a test holds it to that:
// a text changes only through the lab, one change at a time, and its new
// marks come in with the change the lab kept.
export const labMarks: Record<
  Interviewer,
  Record<InterviewKind, Record<InterviewLocale, string>>
> = {
  stephen: {
    own: {
      en: "b13487518370a0ad47b9cb235a6fe21d16cfe51db3980cb0787a01e899fe9266",
      nl: "3c01d4a212ce318f328a22aeed08d3423a7f57eefe94c3f292542e392c3262fd",
      de: "240919bd4475a0fe76f2a3a138f4c3867380e8f50b91c4a1857a7cb769cba687",
      fr: "38499828ea21c1133878571551467439d2c10893e81355e0a21c7d0d6cc9f7bf",
      es: "ddde5ff9037de39a5738b35740eeced7fc46aecb881cce1481092883b0ead4aa",
    },
    lead: {
      en: "0e63aa13955b0bdc4fc2963ac0049da6fe13feea6eeb41d03e9991f12a55569c",
      nl: "95b7d91cc975aa04eb5c65f220bf60cf9ddaf8f584734227794b510dd8235779",
      de: "72e61870324ee52626bce03886db6e4feb092bd2a6c9693f8e3c84393807a092",
      fr: "04644dd34c4834844fd75a703fe9fb8070073ec56caf7e3a23438cec4371fd11",
      es: "ad6c4e6532ee54f58f99ec23972e48bcb51ad612ea1a1609753066e70e6d036f",
    },
  },
  claire: {
    own: {
      en: "0eb41874cc88974bb5d9ff03ccad9d9e2e4bb9948c59c804a96362d88a6a61bb",
      nl: "9167e33150dce860562032909d6c164297c831a11c125c706a9ab00660b71a32",
      de: "b6a8054c9b1d75eee9d6b0b7a3b92203a65468334a6eeffd10c70bdc0e8c4ab2",
      fr: "4ebf202290bc94cf19df69997866c5bb965892c6500b8eafa0d69a094fec5f48",
      es: "4d4db436a51b4c9c41a58716563a208470031aaafafc7b26a72884b7c8b3349f",
    },
    lead: {
      en: "2f8d925531468c361067fbf6b03df0b481b4387979b2f69bf0d31a49b7b68225",
      nl: "58c17e5aaba72914920637e8f35b9a507fba28a82b77ea295a046fed136c2fda",
      de: "5eee13f17de8d9b166e8da33a61548a45353525a9270215a6fd661d177f18bb1",
      fr: "4f4a5c32b6371cc29b63cfe230409e9f3ce1fb5bfb391986a8595b8abf83135f",
      es: "a76c6661f6bea7e368af2c0298af5494d6433c6b82027874d49e505e6cf604db",
    },
  },
};
