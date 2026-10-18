import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const text = (value, limit = 500) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\`*_{}[\]()<>#+!|]/g, '\\$&').slice(0, limit).trim();
const secretValues = env => ['ZAI_API_KEY', 'GH_TOKEN', 'ANNIE_GH_TOKEN', 'REGISTRY_PASSWORD'].map(key => env[key]).filter(value => typeof value === 'string' && value.length >= 4);
export function redact(value, env = process.env) {
  let result = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
  for (const secret of secretValues(env)) {
    const variants = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')];
    for (const variant of variants) if (variant.length >= 4) result = result.split(variant).join('[redacted]');
  }
  return result
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[\w-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi, 'Bearer [redacted]').slice(0, 2_000);
}
const findings = (value, env) => Array.isArray(value) ? value.slice(0, 20).map(item => redact(item, env).slice(0, 500)).filter(Boolean) : [];
const safePhase = (value, env = process.env) => typeof value === 'string' && /^[a-z-]{2,32}$/.test(value) && redact(value, env) === value ? value : 'unknown';
const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
const sha = (value, length = 40, env = process.env) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) && redact(value, env) === value ? value : null;
const source = (run, env) => {
  const id = (value, length = 40) => sha(value, length, env);
  return { base: id(run?.base), head: id(run?.head), tree: id(run?.tree), commit: id(run?.commit), releaseCommit: id(run?.releaseCommit ?? run?.commit), trustedUpstreamPin: id(run?.trustedUpstreamPin), upstreamSha: id(run?.upstreamSha), upstreamRef: typeof run?.upstreamRef === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(run.upstreamRef) && redact(run.upstreamRef, env) === run.upstreamRef ? run.upstreamRef : null, expectedParents: Array.isArray(run?.expectedParents) && run.expectedParents.length <= 2 && run.expectedParents.every(value => id(value)) ? run.expectedParents : [], diffHash: id(run?.diffHash, 64) };
};
export function outcomeFor(run, interrupted = false) {
  if (interrupted) return 'unknown/interrupted';
  if (!run) return 'unknown/interrupted';
  if (run.phase === 'published') return run.commit ? 'released' : 'noop';
  if (run.phase === 'managing' && run.actionReceipts?.some(receipt => receipt.status === 'failed')) return run.actionReceipts.some(receipt => receipt.status === 'applied') ? 'partial' : 'failed';
  if (run.phase === 'managing' && run.actionReceipts?.length && run.actionReceipts.every(receipt => ['applied', 'skipped'].includes(receipt.status))) return 'managed';
  if (run.phase === 'rejected') return ['invalid-review', 'invalid-review-output'].includes(run.review?.reason ?? run.reason) ? 'invalid-review' : 'rejected';
  if (run.reason && run.phase === 'gating') return 'gate-failed';
  if (run.phase === 'failed') return 'failed';
  if (['publishing', 'committing', 'managing'].includes(run.phase)) return 'pending';
  return 'unknown/interrupted';
}
export function reportFor(run, { env = process.env, interrupted = false, gateEvents = null } = {}) {
  if (run?.sourceIdentity) run = { ...run, ...run.sourceIdentity, spent: run.spend, reportedUsage: run.reportedUsage?.status === 'known' ? run.reportedUsage.cost : null };
  const identity = source(run, env);
  const modelPending = interrupted || ['admitted', 'executing', 'reviewing'].includes(run?.phase);
  const phaseCosts = Object.fromEntries(Object.entries(run?.modelPhaseCost ?? {}).filter(([phase]) => /^[a-z-]{2,32}$/.test(phase) && redact(phase, env) === phase).map(([phase, value]) => [phase, { cost: safeNumber(value?.cost), status: ['known', 'unknown', 'not-run'].includes(value?.status) ? value.status : 'unknown' }]));
  const reason = run?.reason ?? run?.review?.reason ?? (run?.phase === 'rejected' ? 'review-rejected' : run?.phase === 'failed' ? 'maintenance-failed' : null);
  const report = {
    taskKind: ['pr', 'maintenance', 'management'].includes(run?.taskKind) ? run.taskKind : 'maintenance',
    fingerprint: sha(run?.fingerprint, 64, env),
    prNumber: Number.isInteger(run?.prNumber) && run.prNumber > 0 ? run.prNumber : null,
    prHead: sha(run?.prHead, 40, env),
    prAuthor: /^[A-Za-z0-9-]{1,39}$/.test(run?.prAuthor ?? '') && redact(run.prAuthor, env) === run.prAuthor ? run.prAuthor : null,
    releaseCommit: identity.releaseCommit,
    managementApproved: run?.managementApproved === true,
    githubState: !run?.actionReceipts?.length ? run?.managementApproved ? 'pending' : 'not-applicable' : run.actionReceipts.some(receipt => receipt.status === 'failed') ? run.actionReceipts.some(receipt => receipt.status === 'applied') ? 'partial' : 'failed' : run.actionReceipts.every(receipt => receipt.status === 'skipped') ? 'skipped' : 'applied',
    managementPlanHash: sha(run?.managementPlanHash, 64, env),
    sourcePersisted: run?.sourcePersisted === true,
    publicationDigest: typeof run?.publicationDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(run.publicationDigest) && redact(run.publicationDigest, env) === run.publicationDigest ? run.publicationDigest : null,
    publicationState: !identity.commit ? 'not-applicable' : run?.phase === 'published' ? 'image-published' : run?.sourcePersisted ? 'image-pending' : 'source-pending',
    blocker: run?.blocker ? redact(run.blocker, env).slice(0, 300) : null,
    githubDiagnostics: run?.githubDiagnostics ? { issuesDisabled: run.githubDiagnostics.issuesDisabled === true, truncated: run.githubDiagnostics.truncated === true, authorRole: /^permission-(write|maintain|admin|push)$/.test(run.githubDiagnostics.authorRole ?? '') ? run.githubDiagnostics.authorRole : null, checks: run.githubDiagnostics.checks === 'satisfied' ? 'satisfied' : 'unknown', policy: run.githubDiagnostics.policy === 'unprotected' ? 'unprotected' : 'unknown' } : null,
    sourceRejection: ['unsupported-history', 'protected-history', 'non-descendant'].includes(run?.sourceRejection) ? run.sourceRejection : null,
    modelFailure: ['environment', 'transient'].includes(run?.modelFailure) ? run.modelFailure : null,
    usageComplete: modelPending ? false : typeof run?.usageComplete === 'boolean' ? run.usageComplete : null,
    knownSubtotal: safeNumber(run?.knownSubtotal),
    modelCalls: Number.isInteger(run?.modelCalls) && run.modelCalls >= 0 && run.modelCalls <= 256 ? run.modelCalls : null,
    budgetCap: safeNumber(run?.budgetCap),
    absoluteDeadline: safeNumber(run?.absoluteDeadline),
    budgetRemainder: safeNumber(run?.budgetRemainder),
    ledgerReservation: sha(run?.ledgerReservation, 64, env),
    actionReceipts: Array.isArray(run?.actionReceipts) ? run.actionReceipts.slice(0, 10).map(r => ({ kind: safePhase(r.kind), number: Number.isInteger(r.number) ? r.number : null, status: ['applied', 'skipped', 'failed'].includes(r.status) ? r.status : 'failed', reason: r.reason ? redact(r.reason, env).slice(0, 200) : null })) : [],
    day: typeof run?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(run.day) && redact(run.day, env) === run.day ? run.day : null,
    phase: safePhase(run?.phase, env),
    spend: safeNumber(run?.spent),
    version: typeof run?.version === 'string' ? redact(run.version, env).slice(0, 64) : null,
    commit: identity.commit,
    base: identity.base,
    tree: identity.tree,
    outcome: outcomeFor(run, interrupted),
    reason: reason ? redact(reason, env).slice(0, 500) : null,
    findings: findings(run?.review?.findings ?? run?.findings, env),
    reviewDiagnostics: Array.isArray(run?.reviewDiagnostics) ? run.reviewDiagnostics.slice(0, 2).map(entry => ({ stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(entry?.stopReason) ? entry.stopReason : 'unknown', textLength: Number.isSafeInteger(entry?.textLength) && entry.textLength >= 0 ? entry.textLength : null, verdict: ['approved', 'review-rejected', 'invalid-review', 'contradictory-review', 'incomplete-review'].includes(entry?.verdict) ? entry.verdict : 'unknown' })) : [],
    timeline: Array.isArray(run?.timeline) ? run.timeline.slice(0, 30).map(entry => ({ phase: safePhase(entry?.phase), at: safeNumber(entry?.at) })) : [],
    modelPhaseCost: phaseCosts,
    reportedUsage: modelPending || run?.usageComplete === false || safeNumber(run?.reportedUsage) === null ? { status: 'unknown' } : { status: 'known', cost: safeNumber(run.reportedUsage) },
    sourceIdentity: identity,
    kind: run?.management && !run?.sourceChanged || run?.kind === 'github-management' ? 'github-management' : run?.sourceChanged ? 'source' : 'noop',
    sourceChanged: Boolean(run?.sourceChanged),
    proposedActionSummary: Array.isArray(run?.proposedActions) ? run.proposedActions.slice(0, 20).map(action => ({ kind: safePhase(action?.kind), number: Number.isInteger(action?.number) ? action.number : null, title: action?.title ? redact(action.title, env).slice(0, 500) : null, labels: Array.isArray(action?.labels) ? action.labels.slice(0, 10).map(label => redact(label, env).slice(0, 80)) : null })) : [],
  };
  if (gateEvents && typeof gateEvents === 'object') report.gates = Array.isArray(gateEvents) ? gateEvents.slice(0, 20).map(entry => ({ name: redact(entry?.name ?? 'gate', env).slice(0, 100), durationMs: safeNumber(entry?.durationMs), status: entry?.exitCode === 0 ? 'passed' : Number.isInteger(entry?.exitCode) ? 'failed' : safePhase(entry?.status) })) : undefined;
  return report;
}
const writes = new Map();
export async function writeReport(path, report) {
  if (!path) return;
  const target = resolve(path);
  const pending = (writes.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(report)}\n`, { mode: 0o600 }); await rename(temporary, target);
  });
  writes.set(target, pending);
  try { await pending; } finally { if (writes.get(target) === pending) writes.delete(target); }
}
export async function readReport(path) {
  try { return reportFor(JSON.parse(await readFile(path, 'utf8'))); }
  catch { return reportFor(null, { interrupted: true }); }
}
function markdown(report) {
  const aside = ({ released: 'Another corpse reanimated. You are welcome.', noop: 'No useful change. I do not breed commits for sport.', rejected: 'Rejected. Confidence is not a test suite.', 'invalid-review': 'The reviewer misplaced its brain. This is a bot failure, not your PR.', 'gate-failed': 'The tests found the body. How inconvenient.', pending: 'Pending. Apparently causality still requires waiting.', failed: 'Failed. Optimism has been escorted off the premises.', partial: 'Some work survived. Celebrate quietly.', managed: 'The paperwork is done. Try not to break it immediately.' })[report.outcome] ?? 'Unknown. I refuse to put lipstick on missing evidence.';
  const badge = report.outcome === 'partial' ? '⚠️ partial GitHub effects, no image release' : report.outcome === 'managed' ? '🌼 GitHub management applied, no image release' : report.outcome === 'released' ? '🌱 released' : report.outcome === 'noop' ? '🌼 no-op, not released' : report.outcome === 'invalid-review' ? '⚠️ invalid review output' : report.outcome === 'rejected' ? '🛑 rejected' : report.outcome === 'gate-failed' ? '🧪 gate failed' : report.outcome === 'pending' ? '⏳ pending' : report.outcome === 'failed' ? '🛑 failed' : '❔ interrupted';
  const hashes = `B=${report.base ?? '?'} | T=${report.tree ?? '?'} | gated C=${report.commit ?? '?'} | source=${report.releaseCommit ?? '?'}`;
  const usage = report.reportedUsage.status === 'known' ? `$${report.reportedUsage.cost}` : 'unknown, non-billing guarantee unavailable';
  const details = report.findings.length ? `\n### Review findings\n${report.findings.map(item => `- ${text(item)}`).join('\n')}\n` : '';
  const gates = report.gates?.length ? `\n### Gates\n${report.gates.map(gate => `- ${text(gate.name)}: ${text(gate.status)} (${gate.durationMs ?? '?'} ms)`).join('\n')}\n` : '';
  const proposals = report.proposedActionSummary?.length ? `\n### Proposed GitHub actions\n${report.proposedActionSummary.map(action => `- ${text(action.kind)}${action.number ? ` #${action.number}` : ''}${action.title ? `: ${text(action.title)}` : ''}`).join('\n')}\n` : '';
  const receipts = report.actionReceipts?.length ? `\n### GitHub receipts\n${report.actionReceipts.map(action => `- ${text(action.kind)}${action.number ? ` #${action.number}` : ''}: ${text(action.status)}${action.reason ? ` (${text(action.reason)})` : ''}`).join('\n')}\n` : '';
  const blocker = report.blocker ? `\nBlocker: ${text(report.blocker)}\n` : '';
  return `## ☠️ Annie's incident ledger: ${badge}\n\n${aside}\n\nOutcome: **${text(report.outcome)}**  \nReason: ${text(report.reason ?? 'none recorded')}  \nKind: ${text(report.kind)}  \nGitHub: ${text(report.githubState)}  \nSource changed: ${report.sourceChanged ? 'yes' : 'no'}  \nSource: ${text(hashes, 500)}  \nModel usage: ${text(usage)}  \nImage digest: ${report.publicationDigest ?? 'not verified'}\n${blocker}${details}${gates}${proposals}${receipts}`;
}
export async function collect({ reportPath, gateEventsPath, publishedPath, sourceReceiptPath, actionReceiptsPath, reportDir, summaryPath }) {
  if (!reportDir) throw Error('explicit --reportdir is required');
  let gates = null;
  if (gateEventsPath) try { gates = (await readFile(gateEventsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { gates = null; }
  let raw = null; try { raw = JSON.parse(await readFile(reportPath, 'utf8')); } catch { /* fallback below */ }
  if (raw) { raw.sourcePersisted = false; raw.publicationDigest = null; }
  if (raw && sourceReceiptPath) try {
    const proof = JSON.parse(await readFile(sourceReceiptPath, 'utf8'));
    if (proof.actualSource === (raw.releaseCommit ?? raw.commit) && proof.tree === raw.tree) raw.sourcePersisted = true;
  } catch { /* source receipt absent or invalid */ }
  if (raw && actionReceiptsPath) try { raw.actionReceipts = JSON.parse(await readFile(actionReceiptsPath, 'utf8')); } catch { /* receipts absent */ }
  if (raw?.phase === 'published' && raw.commit) raw = { ...raw, phase: 'publishing' };
  if (raw && publishedPath) try {
    const receipt = (await readFile(publishedPath, 'utf8')).trim();
    const proof = Object.fromEntries((await readFile(join(dirname(publishedPath), 'remote-proof'), 'utf8')).trim().split(/\r?\n/).map(line => line.split('=')));
    if (sha(receipt) && receipt === (raw.releaseCommit ?? raw.sourceIdentity?.releaseCommit ?? raw.commit) && proof.revision === receipt && proof.version === raw.version && /^sha256:[a-f0-9]{64}$/.test(proof.digest)) raw = { ...raw, phase: 'published', publicationDigest: proof.digest };
  } catch { /* publication not verified */ }
  const report = reportFor(raw, { interrupted: !raw, gateEvents: gates });
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await writeReport(join(reportDir, 'report.json'), report);
  if (summaryPath) await writeFile(summaryPath, markdown(report), { mode: 0o600 });
  return report;
}
function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
async function main() {
  const command = process.argv[2];
  if (!['render', 'collect'].includes(command)) throw Error('usage: report.mjs render|collect --report PATH --reportdir PATH [--gate-events PATH] [--summary PATH]');
  await collect({ reportPath: arg('--report') ?? process.argv[3], gateEventsPath: arg('--gate-events'), publishedPath: arg('--published'), sourceReceiptPath: arg('--source-receipt'), actionReceiptsPath: arg('--action-receipts'), reportDir: arg('--reportdir'), summaryPath: arg('--summary') ?? process.env.GITHUB_STEP_SUMMARY });
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(() => { process.exitCode = 1; });
