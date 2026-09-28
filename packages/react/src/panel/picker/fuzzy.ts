/**
 * A small fuzzy matcher for the data picker and autocomplete: every query character must appear
 * in order; contiguous runs, word starts and early matches score higher.
 *
 * @module
 */

const WORD_BREAK = /[\s.›_\-[\]"]/;

/** Score of `query` against `text` (higher is better), or `null` when it doesn't match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) {
    const atWord = direct === 0 || WORD_BREAK.test(t.charAt(direct - 1));
    return 1000 - direct + (atWord ? 200 : 0) + q.length * 10;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    run = found === ti ? run + 1 : 0;
    const atWord = found === 0 || WORD_BREAK.test(t.charAt(found - 1));
    score += 5 + run * 4 + (atWord ? 8 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

/** The best score of `query` against any of `texts`, or `null` if none match. */
export function bestScore(query: string, texts: readonly string[]): number | null {
  let best: number | null = null;
  for (const text of texts) {
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}
