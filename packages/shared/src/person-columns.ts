// Which columns of a database name or hold a person, by their names: what
// each app's erasure inventory classifies (GRA-903, GRA-1189: core's
// person-erasure-inventory.ts, connect's and the Brain's own).

/** A column that names or holds a person, by its name in the database. */
export const personColumn =
  /(?:^|_)(?:user|person|principal|member|owner|author|actor|subject|behalf|sender|senders|recipient|recipients|decider|deciders|email|invited|inviter|speaker|participant)(?:_|s?$)|_by$/u;
