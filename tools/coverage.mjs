import fs from 'node:fs';
import path from 'node:path';
import { loadDictionary, createTranslator } from '../src/translate.mjs';

/**
 * Dictionary coverage against captured mall pages.
 *
 * Each original text chunk is translated on its own -- exactly what the proxy
 * does -- and when the RESULT still looks Turkish, the ORIGINAL chunk is what
 * gets reported. Reporting the partially translated text instead produces keys
 * that never match the live page, which cost a whole round of useless entries.
 */
const dir = process.argv[2] || 'captures';
// No language regex here on purpose: every heuristic produced false negatives.

const dict = loadDictionary();
const { rewrite } = createTranslator(dict);

const pending = new Map();
let pages = 0, chunks = 0, done = 0;

// Fiddler exports are .txt; the proxy's own captures are .html.
for (const name of fs.readdirSync(dir).filter(n => /\.(txt|html?)$/i.test(n))) {
  const raw = fs.readFileSync(path.join(dir, name), 'utf8');
  const body = raw.slice(raw.indexOf('\n\n') >= 0 ? raw.indexOf('\n\n') + 2 : 0);
  if (!/<html/i.test(body)) continue;
  pages++;

  const noScript = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const part of noScript.split(/(<[^>]+>)/)) {
    if (part.startsWith('<')) continue;
    const original = part.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (original.length < 2) continue;   // headers are 2-6 chars; a floor of 8 hid all of them
    chunks++;
    const after = rewrite(part).replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

    // Language heuristics have false negatives -- "Normal oklara benzer" carries
    // no Turkish-specific letter and slipped through as "translated" for three
    // rounds. So report the fact instead of the guess: whatever the dictionary
    // did not touch. Already-English item names show up too and are easy to skip.
    if (after !== original) { done++; continue; }
    pending.set(original, (pending.get(original) || 0) + 1);
  }
}

const rows = [...pending].sort((a, b) => b[1] - a[1]);
fs.writeFileSync('untranslated.json', JSON.stringify(rows.map(([text, n]) => ({ n, text })), null, 1));

// Say what was measured, not what it would be nice to conclude. "Untouched" is
// a fact; "still Turkish" was a guess, and labelling the guess as the fact is
// what produced three rounds of bogus 100% claims.
const marked = rows.filter(([t]) => /[ğşıİĞŞ]/.test(t));
console.log(`${pages} pages, ${chunks} text chunks`);
console.log(`  rewritten by the dictionary : ${done}`);
console.log(`  untouched (English included): ${chunks - done} occurrences, ${rows.length} distinct`);
console.log(`  of those, carrying Turkish letters: ${marked.length} distinct`);
for (const [t, n] of marked.slice(0, 30)) console.log(`      x${n}  ${JSON.stringify(t.slice(0, 90))}`);
console.log(`  -> untranslated.json  (ORIGINAL text, safe to use as keys)`);
