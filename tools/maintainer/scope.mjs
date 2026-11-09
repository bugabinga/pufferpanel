// Harness repair scope, the one rule every layer applies: guard, maintain snapshot, harness gate, CI import, and delivery.
// A harness PR is a same-repo branch, so GitHub runs its own pull_request workflow definitions with a GITHUB_TOKEN whose
// read-only repository default any workflow `permissions:` key overrides, while trunk is unprotected. Hence a repair may
// change only tools/maintainer and honest-annie.yml, and never that workflow's triggers or top-level keys.
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const execFile = promisify(callback);
export const HARNESS_WORKFLOW = '.github/workflows/honest-annie.yml';
export const HARNESS_PATHS = Object.freeze(['tools/maintainer', HARNESS_WORKFLOW]);
export const harnessPath = path => typeof path === 'string' && (path === HARNESS_WORKFLOW || path.startsWith('tools/maintainer/'));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const parse = text => { const value = YAML.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('not a mapping'); return value; };
// Reason the change set is out of scope, or null. before/after are honest-annie.yml at base and candidate (null if absent).
export function harnessScopeViolation(paths, before = null, after = null) {
  if (!Array.isArray(paths) || !paths.length) return 'harness repair changes nothing';
  const outside = paths.find(path => !harnessPath(path));
  if (outside !== undefined) return `harness repair may change only tools/maintainer/** and ${HARNESS_WORKFLOW}, not ${String(outside).slice(0, 120)}: other .github files can run with write tokens on the PR`;
  if (!paths.includes(HARNESS_WORKFLOW)) return null;
  if (typeof before !== 'string' || typeof after !== 'string') return `harness repair may not add or delete ${HARNESS_WORKFLOW}`;
  let base, candidate;
  try { base = parse(before); candidate = parse(after); } catch { return `harness repair left ${HARNESS_WORKFLOW} unparseable`; }
  // GitHub and YAML 1.1 parsers may read other keys (true, yes) as `on`, so the top-level key set is frozen too.
  if (JSON.stringify(Object.keys(base).sort()) !== JSON.stringify(Object.keys(candidate).sort())) return `harness repair may not add or remove top-level keys of ${HARNESS_WORKFLOW}`;
  if (JSON.stringify(canonical(base.on)) !== JSON.stringify(canonical(candidate.on))) return `harness repair may not change the on: triggers of ${HARNESS_WORKFLOW}`;
  return null;
}
const git = async (cwd, ...args) => (await execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
const show = (cwd, rev) => git(cwd, 'show', `${rev}:${HARNESS_WORKFLOW}`).catch(() => null);
// The rule between two committed revisions or trees.
export async function harnessScope(cwd, base, candidate) {
  const paths = (await git(cwd, 'diff', '--name-only', '--no-renames', base, candidate)).split('\n').filter(Boolean);
  return harnessScopeViolation(paths, await show(cwd, base), await show(cwd, candidate));
}
// Node realpaths the main module, so compare real paths; the gate also requires the printed verdict.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cwd, base, candidate] = process.argv.slice(2);
  harnessScope(cwd, base, candidate).then(reason => { if (reason) { console.error(reason); process.exitCode = 1; } else console.log('harness-scope-ok'); }, error => { console.error(`harness scope unavailable: ${error.message}`); process.exitCode = 1; });
}
