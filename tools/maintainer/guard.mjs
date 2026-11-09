// Early, actionable tool-call policy for model conversations: path confinement, host-authority command blocks, and
// untrusted-output spotlighting. Best-effort only; snapshot/protected-path checks, host-only commits, independent
// review, and release import remain authoritative.
import { lstat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { PROTECTED_PATHS } from './task.mjs';

// Git metadata stays host-managed in every variant; `.git` is a gitdir pointer file in a linked worktree.
const GIT_METADATA = '.git';
const under = (rel, prefix) => rel === prefix || rel.startsWith(`${prefix}/`);
const inside = rel => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
const protectedReason = (hit, path) => hit === GIT_METADATA ? `${path} is Git metadata; the host manages .git, leave it unchanged` : `${path} is in ${hit}, the host-trusted harness/CI policy; leave it unchanged and report needed changes as blockers`;
// The path forms the durable write/edit tools accept: '@' prefix, Unicode spaces, '~', and file:// URLs.
const toolPath = path => {
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' '), plain = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (plain === '~' || plain.startsWith('~/')) return join(homedir(), plain.slice(1));
  return plain.startsWith('file://') ? fileURLToPath(plain) : plain;
};

// Canonical absolute write target inside the worktree; throws a corrective reason otherwise.
export async function confinePath(worktree, path, protectedPaths = PROTECTED_PATHS) {
  if (typeof path !== 'string' || !path) throw Error('a file path is required');
  const root = await realpath(worktree), lexical = resolve(worktree, toolPath(path)), rest = [];
  let existing = lexical;
  for (;;) {
    try { await lstat(existing); break; } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || existing === dirname(existing)) throw error;
      rest.unshift(basename(existing)); existing = dirname(existing);
    }
  }
  if (!rest.length && (await lstat(lexical)).isSymbolicLink()) throw Error(`${path} is a symlink; write the real file inside the maintenance worktree instead`);
  const real = await realpath(existing).catch(() => { throw Error(`${path} goes through a dangling symlink; write only real paths inside the maintenance worktree`); });
  const canonical = join(real, ...rest), rel = relative(root, canonical);
  if (!inside(rel)) throw Error([relative(root, lexical), relative(resolve(worktree), lexical)].some(inside) ? `${path} resolves through a symlink outside the maintenance worktree; write only real paths inside it` : `${path} is outside the maintenance worktree; write only inside it, with paths relative to it`);
  const hit = [GIT_METADATA, ...protectedPaths].find(prefix => under(rel, prefix));
  if (hit) throw Error(protectedReason(hit, path));
  return canonical;
}

// Quote-aware command starts after ; && || | & newlines ( ) { } $( and backticks, recursing into sh/bash -c and eval
// payloads. Quoted text is data (`grep 'git push'`), except bare words (`"git" push`) and "$(...)" substitutions.
const QUOTED = /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/g;
const WRAPPED = /\b(?:(?:ba|da|z|k)?sh(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c[A-Za-z]*|eval)\s+("(?:\\[\s\S]|[^"\\])*"|'[^']*')/g;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[\t ]*\2[\t ]*(?=\n|$)/g;
const PREFIX = /^(?:[A-Za-z_]\w*=\S*(?:\s+|$)|(?:sudo|env|command|exec|nohup|time|nice|xargs|then|do|else|elif|if|while|until|!)(?:\s+-\S+)*(?:\s+|$)|timeout(?:\s+-\S+)*\s+\S+(?:\s+|$))/;
const unquote = quoted => quoted[0] === '"' ? quoted.slice(1, -1).replace(/\\([\s\S])/g, '$1') : quoted.slice(1, -1);
function shellView(command, depth = 0) {
  if (depth > 2) throw Error('shell wrappers nest too deeply; run the command directly');
  const text = command.replace(HEREDOC, block => block.slice(0, block.indexOf('\n')));
  const nested = [...text.matchAll(WRAPPED)].map(match => shellView(unquote(match[1]), depth + 1));
  const masked = text.replace(QUOTED, quoted => { const inner = unquote(quoted); return /^[\w./@%+:,=-]+$/.test(inner) || (quoted[0] === '"' && /\$\(|`/.test(inner)) ? inner : '""'; })
    .replace(/\\(?=[A-Za-z])/g, '').replace(/(^|\s)#[^\n]*/g, '$1');
  const commands = masked.split(/\|\||&&|\$\(|[;|&\n(){}`]/).map(part => { let start = part.trim(); for (let next; (next = start.replace(PREFIX, '')) !== start;) start = next; return start; }).filter(Boolean);
  return { commands: [...commands, ...nested.flatMap(view => view.commands)], texts: [masked, ...nested.flatMap(view => view.texts)] };
}
// Global options that take a separate argument must be consumed, or `git --git-dir .git push` hides its subcommand.
const GIT = /^(?:\S*\/)?git((?:\s+(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env|super-prefix|attr-source))\s+\S+|-\S+))*)\s+([a-z][\w-]*)(.*)$/s;
const CONTAINER = /^(?:\S*\/)?(?:podman|docker)(?:\s+(?:(?:-H|--(?:host|context|config|connection|url|identity|log-level|root|runroot|storage-driver))\s+\S+|-\S+))*\s+(?:(?:image|manifest)\s+)?(?:push|login)\b/;
const GH = /^(?:\S*\/)?gh(?:\s|$)/;
const FETCH_TOOL = /^(?:\S*\/)?(?:curl|wget)(?:\s|$)/;
const CREDENTIAL_FLAG = /(?:^|\s)(?:-[A-Za-z]*[unbE]|--(?:user|proxy-user|oauth2-bearer|netrc|netrc-file|netrc-optional|cookie|password|http-user|http-password|proxy-password|load-cookies|aws-sigv4|cert|key))(?=[\s=]|$)/;
const CREDENTIAL_TEXT = /(?:-H|--header)[\s=]*["']?\s*(?:authorization|proxy-authorization|cookie|private-token|[\w-]*(?:token|api-key|apikey|auth)[\w-]*)\s*:|\bhttps?:\/\/[^\s/@'"]+@|\$\{?\w*(?:token|key|secret|passw(?:or)?d|auth)\w*/i;
const REDIRECT = /(?:^|[^<])(?:\d|&)?>>?\|?\s*([^\s;&|<>()]+)/g;
function gitReason(sub, rest) {
  if (sub === 'commit') return 'git commit is host-only: the host commits the reviewed candidate; leave changes uncommitted in the worktree';
  if (sub === 'push') return 'git push is host-only: the host persists reviewed source; never push';
  if (sub === 'tag' && !/^\s*(?:$|-l\b|--list\b)/.test(rest)) return 'git tag changes are host-only: the host versions releases; read tags with git tag --list';
  if (sub === 'reset' && /(?:^|\s)--hard\b/.test(rest)) return 'git reset --hard is blocked: history stays with the host; discard edits with git restore --staged --worktree -- PATH';
  if (sub === 'rebase') return 'git rebase is blocked: history stays with the host; leave changes uncommitted';
  if (sub === 'cherry-pick') return 'git cherry-pick is blocked: apply upstream changes as uncommitted edits, e.g. git show SHA | git apply --3way';
  if (sub === 'merge' && !/^\s+--(?:abort|quit)\b/.test(rest)) return 'git merge is blocked: call tools.merge_upstream() for the pinned upstream merge (git merge --abort undoes one)';
  if (sub === 'config') return 'git config is host-managed; leave repository and user configuration unchanged';
  if (sub === 'remote' && !/^\s*(?:$|-v\b|--verbose\b|show\b|get-url\b)/.test(rest)) return 'git remotes are host-managed; only read them, e.g. git remote -v';
  return null;
}
// Corrective reason for a bash command that would bypass host authority, or null.
export function classifyCommand(command, { worktree = '/', protectedPaths = PROTECTED_PATHS } = {}) {
  let view; try { view = shellView(command); } catch (error) { return error.message; }
  const { commands, texts } = view;
  const protectedTarget = target => {
    const rel = relative(resolve(worktree), resolve(worktree, target.replace(/^\$\{?PWD\}?\//, '')));
    const hit = [GIT_METADATA, ...protectedPaths].find(prefix => under(rel, prefix));
    return hit ? `shell write to ${protectedReason(hit, target)}` : null;
  };
  for (const start of commands) {
    const git = GIT.exec(start);
    const reason = git ? gitReason(git[2], git[3])
      : CONTAINER.test(start) ? 'image publication and registry login are host-only: the host builds and publishes reviewed images; never log in or push'
        : GH.test(start) ? 'gh is blocked: propose GitHub effects with tools.propose_github; GitHub intake is already in $PUFFER_MAINT_INTAKE'
          : FETCH_TOOL.test(start) && (CREDENTIAL_FLAG.test(start) || CREDENTIAL_TEXT.test(command)) ? 'credentialed requests are blocked: never send tokens, cookies, or auth headers; use unauthenticated public reads only'
            : /^(?:\S*\/)?tee\b/.test(start) ? start.split(/\s+/).slice(1).filter(arg => !arg.startsWith('-')).map(protectedTarget).find(Boolean) ?? null : null;
    if (reason) return reason;
  }
  for (const text of texts) for (const [, target] of text.matchAll(REDIRECT)) { const reason = protectedTarget(target); if (reason) return reason; }
  return null;
}

// Commands whose output is remote or intake content: fetches, upstream refs, and the intake file.
export function fetchesRemote(command) {
  if (/\bPUFFER_MAINT_INTAKE\b|pufferpanel-intake-|\bupstream\b/.test(command)) return true;
  try { return shellView(command).commands.some(start => FETCH_TOOL.test(start) || ['fetch', 'pull', 'clone', 'ls-remote', 'archive'].includes(GIT.exec(start)?.[2])); } catch { return true; }
}

// Untrusted text between per-run markers; content cannot forge either marker because every look-alike is escaped.
const neutralise = text => text.replace(/<(\s*\/?\s*untrusted)/gi, '&lt;$1');
export const spotlight = (id, text) => `<untrusted id=${id}>\n${neutralise(text)}\n</untrusted id=${id}>`;
// JSON (intake, plans, tool JSON) stays parseable: every non-token string or key is wrapped in place, while numbers,
// booleans, and short identifier tokens (kinds, SHAs, dates, logins) stay comparable. Anything else is wrapped whole.
const TOKEN = /^[\w.:/@+#=-]{0,64}$/;
export function spotlightText(id, text) {
  let value; try { value = JSON.parse(text); } catch { return spotlight(id, text); }
  if (!value || typeof value !== 'object') return spotlight(id, text);
  const leaf = string => TOKEN.test(string) ? string : spotlight(id, string);
  const walk = node => typeof node === 'string' ? leaf(node) : Array.isArray(node) ? node.map(walk) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([key, item]) => [leaf(key), walk(item)])) : node;
  return JSON.stringify(walk(value));
}
// Structured results such as ui_snapshot: every non-token string is wrapped in place; image blocks stay intact so image() accepts them.
const isImage = node => node?.type === 'image' && typeof node.data === 'string';
const spotlightValue = (id, node) => typeof node === 'string' ? (TOKEN.test(node) ? node : spotlight(id, node)) : Array.isArray(node) ? node.map(item => spotlightValue(id, item)) : node && typeof node === 'object' && !isImage(node) ? Object.fromEntries(Object.entries(node).map(([key, item]) => [key, spotlightValue(id, item)])) : node;
const NOT_RUN = new Set(['blocked', 'invalid_arguments', 'tool_unavailable', 'abandoned']);
// Wraps only text that can reach the model: output items, a string value or the `output` field programs read, and
// thrown error text; exit codes and other structured fields stay intact.
export function spotlightResult(id, result) {
  if (result.diagnostics?.some(diagnostic => NOT_RUN.has(diagnostic.code))) return undefined;
  const wrap = text => spotlightText(id, text), value = result.structuredOutput;
  return {
    ...result,
    ...(result.output ? { output: result.output.map(item => item.type === 'text' ? { ...item, text: wrap(item.text) } : item) } : {}),
    ...(typeof value === 'string' ? { structuredOutput: wrap(value) } : typeof value?.output === 'string' ? { structuredOutput: { ...value, output: wrap(value.output) } } : value && typeof value === 'object' ? { structuredOutput: spotlightValue(id, value) } : {}),
    ...(result.diagnostics ? { diagnostics: result.diagnostics.map(diagnostic => diagnostic.code === 'tool_error' ? { ...diagnostic, message: spotlight(id, diagnostic.message) } : diagnostic) } : {}),
  };
}

// One extension per variant: a harness-repair task would select another name with `protectedPaths: []`.
export function createGuard({ worktree, name = 'pufferpanel-guard', protectedPaths = PROTECTED_PATHS, id = randomBytes(16).toString('hex') }) {
  if (!worktree) throw Error('guard worktree is required');
  const paths = Object.freeze([...protectedPaths]);
  const untrusted = async call => {
    if (['run', 'ui_snapshot', 'read_github_plans'].includes(call.name)) return true;
    if (call.name === 'bash') return fetchesRemote(String(call.arguments?.command ?? ''));
    if (call.name !== 'read') return false;
    // Anything read from outside the worktree (intake, private gate log) is external data.
    try { return !inside(relative(await realpath(worktree), await realpath(resolve(worktree, toolPath(String(call.arguments?.path)))))); } catch { return true; }
  };
  return defineExtension({ name, hooks: [hook(ToolTask, {
    // Fires for model-issued and nested (codemode script) calls; a throw blocks with its message.
    beforeTool: async call => {
      if (['write', 'edit'].includes(call.name)) return { arguments: { ...call.arguments, path: await confinePath(worktree, call.arguments?.path, paths) } };
      if (call.name !== 'bash') return undefined;
      const reason = classifyCommand(String(call.arguments?.command ?? ''), { worktree, protectedPaths: paths });
      return reason ? { block: reason } : undefined;
    },
    afterTool: async (call, result) => await untrusted(call) ? spotlightResult(id, result) : undefined,
  })] });
}
