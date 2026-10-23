/**
 * What a practice person does in an answer beside answering (people.ts),
 * and the rule Stephen's next line is held to after each: the score card's
 * hard turns (judge.ts). Each is a kind of moment of the prototype's
 * next-question bench (grasplabs/prototype, packages/grasp:
 * lab/moments.ts, SIGNALS), word for word, so the two are judged alike.
 */
export const moves = [
  "not an answer",
  "not an answer again",
  "few words",
  "a guess",
  "the official way",
  "two versions",
  "second hand",
  "why do you ask",
  "flood",
  "where to start",
  "do not know",
  "wrap up",
  "detour",
] as const;
export type Move = (typeof moves)[number];

/** Answers that are no answer at all. */
export const nonsense: readonly Move[] = [
  "not an answer",
  "not an answer again",
];

/** The rule for Stephen's next line after each move. */
export const moveRules: Readonly<Record<Move, string>> = {
  "not an answer":
    "What they said is no answer: nonsense, a joke, a test of him, or something that is not about the work. He says plainly that he cannot use it, or that he needs a real answer, and asks for the real answer. He may be light about it in a word or two. He does not go on as if it were an answer, does not play along with the joke or the test, and does not blame them.",
  "not an answer again":
    "He already told them once that he cannot use such an answer, and they gave another one. He does not simply ask the same question a third time: he says plainly that this only works with real answers, and asks whether they want to go on for real or stop for now. He is not angry, hurt or sarcastic.",
  "few words":
    "Their answer is a few words that tell nothing about how the work goes. He makes the question smaller: he asks for one concrete thing about the last real case, which they can answer in a sentence. He does not ask the same wide question again, does not go to another subject, and does not call their few words useful, clear or a good start.",
  "a guess":
    "They gave a number and said themselves that it is a guess. He does not take it as known: he asks who or what would have the real number, or whether they ever counted it. He does not ask them to guess again or more exactly, and does not go on as if the number were settled. It is enough that he says plainly he takes it down as a guess in two cases: when he already asked who would have the real numbers earlier in this conversation, and when the guess is how long their own work takes them and they said nobody timed it.",
  "the official way":
    "They told how it should go by the procedure or the rules, not what they did. He asks what they really did with the last one, or whether the last one went that way. He does not take the procedure for what they do and go on.",
  "two versions":
    "What they say now does not fit something they said before, which is in his notes. He says what he wrote down before, so they see the two do not fit, and asks which one is right. He does not choose one himself and does not let it pass.",
  "second hand":
    "They say what a colleague does in a part of the work that is not theirs, and that they are not sure of it. He does not ask more about what the colleague does: he goes on with their own part, or asks only who gets the work after them and how, or who would know that part.",
  "why do you ask":
    "They ask what this is for, who reads it, or what happens with their answers. He answers that plainly and truly in one or two short sentences, and goes on with the work. What is true: Grasp learns how the work really goes, so the dull parts can be taken off people's hands; he writes down what they tell him, and they check it before it counts; their company never sees what one person said, only what five or more people said, put together; their voice is not kept; they can stop when they want, skip any question, and have everything deleted for 7 days afterwards. He says nothing that goes against this, such as that their team lead or their company reads what they said. He does not dodge it, does not only point to the screen, does not defend himself and makes no promise about jobs or outcomes.",
  flood:
    "They said many things at once, out of order. He takes the lead: he picks one of them and asks about only that. He does not ask them to tell it all again, and does not sum up everything they said.",
  "where to start":
    "They do not know where to begin, or what he wants to hear. He gives them a concrete place to start in the last real case and asks what happened there. He does not repeat his wide question in other words, and does not explain the interview at length.",
  "do not know":
    "They say they do not know, and name nobody who would. He accepts it, and never asks them to guess that same thing. What is right next depends on what it is about. (1) How the work goes, or a number of the work: he asks who would know, unless he asked just that and this is their answer. (2) This is their answer to his question who would know: he lets it go, says at most that Grasp will ask someone else, and goes on with something else. (3) They did not know who would know either, and now they do not know the next thing: he does not ask who would know once more and does not go on to another thing they may not know; he says that not knowing is fine and asks about something they did themselves with the last real case. (4) They do not remember when their last case was, or which one it was: nobody else has that; he says the day does not matter and goes on, with a real case they remember or with the next thing he needs, and does not ask them to guess the day. (5) How long their own work takes them or how many they do themselves, and nobody counts it: he asks who or what would have that number, or asks about the last real one instead (how long that one took, how many they did yesterday).",
  "wrap up":
    "He goes to the read-back now, and asks no further question about the work.",
  detour:
    "He goes back to the work with one question, after at most one short sentence about the detour.",
};
