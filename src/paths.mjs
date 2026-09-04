import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDED } from './embedded.mjs';

/**
 * Where the editable files live: a `config/` folder beside the executable.
 *
 * The dictionaries are compiled into the binary so it runs on its own, but they
 * are also written out to config/dict on first start and read from there
 * afterwards. That way a translation can be fixed by editing a JSON file, with
 * no toolchain and no rebuild -- and the shipped wording stays visible instead
 * of being locked inside the exe.
 *
 * Running from source (`node tools/proxy.mjs`) uses the working directory, so
 * the repo gets its own config/ and nothing lands next to node.exe.
 */
const exe = path.basename(process.execPath).toLowerCase();

/** True when running as the packaged executable rather than through node. */
export const BUNDLED = !/^node(\.exe)?$/.test(exe);
const bundled = BUNDLED;

export const BASE = bundled ? path.dirname(process.execPath) : process.cwd();
export const CONFIG_DIR = path.join(BASE, 'config');
export const DICT_DIR = path.join(CONFIG_DIR, 'dict');
export const PROXIES_FILE = path.join(CONFIG_DIR, 'proxies.json');
export const CAPTURES_DIR = path.join(BASE, 'captures');
export const UNTRANSLATED_FILE = path.join(BASE, 'untranslated.json');

const EXAMPLE = [
  '203.0.113.10:1080',
  '203.0.113.11:1080@user:password',
  'http://203.0.113.12:8080',
];

/**
 * Seed config/ from the embedded data, adding ONLY what is not already there.
 *
 * An existing value is never touched. Someone may well have translated the mall
 * into Spanish, or reworded the English -- that work has to survive both a
 * restart and a newer executable. So a key already present in their file is left
 * exactly as it is, and only keys they do not have yet are appended. Upgrading
 * the binary then simply surfaces whatever strings are new, in their own file,
 * ready to be translated.
 */
export function ensureConfig() {
  const created = [];
  fs.mkdirSync(DICT_DIR, { recursive: true });

  for (const [name, data] of Object.entries(EMBEDDED)) {
    const file = path.join(DICT_DIR, name);
    const shown = path.join('config', 'dict', name);

    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
      created.push(shown);
      continue;
    }

    let mine;
    try {
      mine = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // Their file, their call: a broken edit is reported, not overwritten.
      created.push(`${shown}  (LEFT ALONE -- invalid JSON: ${e.message})`);
      continue;
    }

    let added = 0;
    for (const [key, value] of Object.entries(data)) {
      if (key === '_patterns') {
        const theirs = (mine._patterns ??= {});
        for (const [re, rep] of Object.entries(value)) {
          if (!(re in theirs)) { theirs[re] = rep; added++; }
        }
        continue;
      }
      if (!(key in mine)) { mine[key] = value; added++; }
    }

    if (added) {
      fs.writeFileSync(file, JSON.stringify(mine, null, 1) + '\n');
      created.push(`${shown}  (+${added} new string(s))`);
    }
  }

  if (!fs.existsSync(PROXIES_FILE)) {
    // An empty list is a working default: no routing, the mall goes out the way
    // the machine normally would.
    fs.writeFileSync(PROXIES_FILE, '[]\n');
    created.push(path.join('config', 'proxies.json'));
  }

  const example = path.join(CONFIG_DIR, 'proxies.example.json');
  if (!fs.existsSync(example)) {
    fs.writeFileSync(example, JSON.stringify(EXAMPLE, null, 2) + '\n');
    created.push(path.join('config', 'proxies.example.json'));
  }

  return created;
}
