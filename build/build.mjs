import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { inject } from 'postject';

/**
 * Build the single-file executable.
 *
 * Node's SEA only accepts one CommonJS script, and this project is ESM with the
 * dictionaries imported as JSON, so esbuild bundles it down first -- that is the
 * only reason a build step exists at all. esbuild and postject are development
 * dependencies; nothing is shipped inside the executable except this project's
 * own code, the dictionaries, and Node itself.
 *
 * Running from source needs none of this: `npm start`.
 */
const OUT_DIR = 'build/out';
const BUNDLE = `${OUT_DIR}/proxy.cjs`;
const BLOB = `${OUT_DIR}/sea.blob`;
const CONFIG = `${OUT_DIR}/sea-config.json`;
const EXE = 'dist/trsro-mall-translator.exe';
// Node looks for this string inside the binary to find where the blob goes.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync('dist', { recursive: true });

console.log('bundling...');
await esbuild.build({
  entryPoints: ['tools/proxy.mjs'],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Keep it readable: someone auditing the exe can unpack the blob and follow
  // the code. Nothing here is secret, and the size cost is trivial next to Node.
  minify: false,
  logLevel: 'warning',
});
console.log(`  ${BUNDLE}  ${mb(fs.statSync(BUNDLE).size)}`);

fs.writeFileSync(CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2));

console.log('preparing the SEA blob...');
execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit' });

console.log(`copying node (${process.version})...`);
try {
  fs.copyFileSync(process.execPath, EXE);
} catch (e) {
  // Windows locks a running executable, so a build while the previous one is
  // open fails here with a raw stack trace that says nothing useful.
  if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
  console.error(`\n${EXE} is locked -- a copy of it is still running.`);
  console.error('Close that window (or stop it in Task Manager) and build again.');
  process.exit(1);
}

console.log('injecting...');
await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), { sentinelFuse: FUSE });

console.log(`\ndone: ${EXE}  ${mb(fs.statSync(EXE).size)}`);
console.log('The exe is self-contained. On first run it writes config/ beside itself.');
