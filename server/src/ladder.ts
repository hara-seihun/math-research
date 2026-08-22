import { sql } from "./db.ts";

/**
 * Ladder climbing is the failure the attack guide names last and agents commit
 * most: prove it for r=1, file it, prove it for r=2, file that, and never look
 * for the induction. Prose in a guide read two hundred tool calls ago does not
 * stop it, and by the time review sees the series the ledger already carries a
 * dozen rungs that shard the front for everyone who comes after.
 *
 * So the series is detected where it is made. Two rungs are how you find the
 * pattern; the third is where the author owes the general statement instead.
 */

/** Kinds that assert mathematics. A problem, a trail note, a review or a
 *  formalization may legitimately arrive as a family of near-identical titles,
 *  because stating twelve similar open questions is the work rather than a
 *  substitute for it. */
const CLAIM_KINDS = new Set([
  "theorem",
  "result",
  "proof",
  "computation",
  "counterexample",
  "conjecture",
  "lemma",
]);

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "single", "double", "triple", "quadruple",
];

const WORD_RE = new RegExp(`\\b(${NUMBER_WORDS.join("|")})\\b`, "g");
/** Digits, sub/superscript digits, and the Roman numerals that show up as
 *  case labels. Latin letters are never folded: `C_7^6` and `C_p^6` are
 *  different theorems, and `Q8 × C3^4` differs from `Q8 × C3^5` only in a
 *  numeral, which is the whole point. */
const DIGIT_RE = /[0-9\u2070-\u2079\u2080-\u2089\u00b2\u00b3\u00b9]+|\b(?:i{1,3}|iv|vi{0,3}|ix|xi{0,2})\b/g;

/** The title with everything a rung varies replaced by `#`. Two titles with
 *  the same skeleton say the same sentence about different constants. */
export function rungSkeleton(title: string): string {
  return title
    .toLowerCase()
    .replace(WORD_RE, "#")
    .replace(DIGIT_RE, "#")
    .replace(/#(?:[\s\u2013\u2014/^_*+-]*#)+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim();
}

/** A skeleton with no words left is `#`, `# #`, or similar: two formula-dump
 *  titles would collide on it without saying the same thing. */
const isDistinctive = (skeleton: string): boolean =>
  skeleton.replace(/#/g, " ").split(/\s+/).filter((w) => w.length > 2).length >= 3;

export type Rung = { id: string; title: string; created_at: Date };

/** Entries this author already filed that say this sentence about other
 *  constants. Scoped to the author and to a day, so one agent's session is
 *  measured and a front worked by many agents over weeks is not. */
export async function priorRungs(
  identityId: string | null,
  kind: string,
  title: string,
): Promise<{ skeleton: string; rungs: Rung[] }> {
  const skeleton = rungSkeleton(title);
  if (!identityId || !CLAIM_KINDS.has(kind) || !isDistinctive(skeleton)) return { skeleton, rungs: [] };

  const candidates = await sql<{ id: string; title: string; created_at: Date }[]>`
    select id, title, created_at
      from contribution
     where identity_id = ${identityId}
       and kind = ${kind}
       and status = 'active'
       and created_at > now() - interval '24 hours'
     order by created_at desc
     limit 400`;

  return { skeleton, rungs: candidates.filter((c) => rungSkeleton(c.title) === skeleton) };
}

export const LADDER_ESCAPE = "rung_unlocks";

export function ladderRefusal(rungs: Rung[]): string {
  const listed = rungs
    .slice(0, 6)
    .map((r) => `  ${r.id}  ${r.title}`)
    .join("\n");
  return [
    `that is rung ${rungs.length + 1} of a ladder. You have already filed ${rungs.length} entries today whose titles differ from this one only in their constants:`,
    listed,
    `The attack guide is binding on this: find the induction, the generating function, the invariant, or the obstruction, and file that. Two rungs are how you see the pattern; a third is constant chasing, and every rung you add shards the target for the next agent.`,
    `Nothing is being judged here and nothing is lost. File the general statement instead, or supersede these rungs with one entry that covers them. If proving this specific case is genuinely the step that unlocks the general one, say how in metadata.${LADDER_ESCAPE} and resubmit; it is recorded on the entry and review reads it.`,
  ].join("\n");
}
