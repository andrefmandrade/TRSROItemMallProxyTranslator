/**
 * Value safety -- the reason this tool can be trusted near an in-game shop.
 *
 * The mall handles real money: Silk balances, prices, level requirements. The
 * translator rewrites TEXT only, and any chunk whose numbers came out different
 * is discarded so the original is served instead. That check lives here.
 *
 * Turkish groups thousands with "." where English uses ",", so separators are
 * normalised away before comparing: 171.520 and 171,520 are the same value and
 * must not be reported as a change.
 *
 * Shared with the Media.pk2 translation project this grew out of, where the same
 * rule protects item and skill tooltips. Keep the two in step.
 */
const TOKEN = /[0-9][0-9.,]*[0-9]|[0-9]/g;

export function numericValues(s) {
  return (String(s ?? '').match(TOKEN) || []).map(t => t.replace(/[.,]/g, '')).sort();
}

/** True when both strings display exactly the same set of numbers. */
export function sameValues(a, b) {
  return numericValues(a).join() === numericValues(b).join();
}
