// Harness self-repair: model-free incident detection over trusted observation, idempotent incident issues, and delivery of a
// reviewed harness fix as a PR from its own branch. Annie never merges, pushes trunk, or integrates these PRs herself.
import { createHash } from 'node:crypto';
import { redact, text } from './report.mjs';
import { git } from './pr.mjs';
import { HARNESS_BRANCH_PREFIX, OWN, harnessBranch } from './task.mjs';
import { harnessScope } from './scope.mjs';

export const INCIDENT_LABEL = 'annie-incident';
export const MODEL_STEP = 'Maintain or review selected task';
export const HARNESS_GATE_JOB = 'Annie harness gate (model-free)';
const DAY = 86_400_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const KINDS = Object.freeze(['effects-abandoned', 'effects-held', 'observation-blocked', 'run-stuck', 'environment-cooldown', 'providers-held', 'job-failed', 'sandbox-unavailable', 'visual-unavailable', 'sandbox-cleanup-failed', 'gate-harness']);
// Kinds a harness change can plausibly fix; exhausted providers, environment cooldowns, unknown answers, blocked observation,
// and GitHub-side stalls need the operator, so they only get an issue.
export const REPAIRABLE = new Set(['job-failed', 'gate-harness', 'sandbox-unavailable', 'visual-unavailable', 'sandbox-cleanup-failed', 'effects-abandoned']);
const safe = (value, limit = 200) => redact(value).replace(/[^\x20-\x7e]/g, '?').slice(0, limit).trim();
const stable = value => safe(value).replace(/\d+/g, '#'); // Identity text never carries counters, times, or IDs.
const iso = ms => new Date(ms).toISOString();
const md = (value, limit) => text(value, limit).replace(/@/g, '@\u200b');
const item = (kind, identity, detail, runs = []) => ({ fingerprint: digest({ kind, identity }), kind, detail: safe(detail), runs: [...new Set(runs)].filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => b - a) });
const failed = conclusion => ['failure', 'timed_out', 'startup_failure'].includes(conclusion);

// Current incidents from evidence observe already holds. Normal outcomes are not incidents: review rejections, product gate
// failures, and model failures all end in the model step; honest no-ops fail nothing; a quota hold with another provider left
// is not all-providers-held. The harness gate job judges a repair candidate, not trunk.
export function detectIncidents({ now, abandoned = [], held = [], blockers = [], stuck = [], environment = null, providersHeld = null, jobs = [], reports = [] }) {
  const found = [
    ...abandoned.map(a => item('effects-abandoned', { runId: a.runId, reason: a.reason }, `run ${a.runId}: ${a.reason}`, [a.runId])),
    ...held.map(h => item('effects-held', { runId: h.runId, reason: h.reason }, `run ${h.runId}: ${h.reason}`, [h.runId])),
    ...blockers.map(b => item('observation-blocked', { runId: b.runId, reason: b.reason }, `run ${b.runId}: ${b.reason}`, [b.runId])),
    ...stuck.map(run => item('run-stuck', { runId: run.id }, `run ${run.id} still ${run.status} since ${run.created_at}`, [run.id])),
  ];
  if (environment?.nextAt > now) found.push(item('environment-cooldown', { signal: environment.signal }, `paid work paused by an environment failure until ${iso(environment.nextAt)}`, environment.runs));
  if (providersHeld) found.push(item('providers-held', { providers: [...providersHeld.providers].sort() }, `every known provider held (${providersHeld.providers.join(', ')}) until ${providersHeld.until}`));
  const failures = new Map();
  for (const { runId, conclusion, jobs: list = [] } of jobs) {
    const broken = list.filter(job => failed(job.conclusion) && job.name !== HARNESS_GATE_JOB);
    if (!list.length && conclusion === 'startup_failure') broken.push({ name: 'workflow', conclusion });
    for (const job of broken) {
      const step = job.steps?.find(entry => failed(entry.conclusion))?.name ?? job.conclusion;
      if (step === MODEL_STEP) continue;
      const key = `${stable(job.name)}\n${stable(step)}`, entry = failures.get(key) ?? { job: job.name, step, runs: [] };
      entry.runs.push(runId); failures.set(key, entry);
    }
  }
  for (const { job, step, runs } of failures.values()) found.push(item('job-failed', { job: stable(job), step: stable(step) }, `${job} failed at ${step} in ${new Set(runs).size} run(s) within 24h`, runs));
  // Latest reviewed source report decides the reviewer sandbox state; harness and management runs skip the sandbox by design.
  const latest = test => reports.filter(r => ['maintenance', 'pr'].includes(r.taskKind) && r.report?.sourceChanged === true && test(r.report)).sort((a, b) => b.runId - a.runId)[0];
  const reviewed = latest(report => report.sandbox), sandbox = reviewed?.report.sandbox;
  if (sandbox?.status === 'unavailable') found.push(item('sandbox-unavailable', { reason: stable(sandbox.reason) }, `reviewer sandbox unavailable: ${sandbox.reason ?? 'no reason'}`, [reviewed.runId]));
  else if (sandbox?.visual?.status === 'unavailable') found.push(item('visual-unavailable', { reason: stable(sandbox.visual.reason) }, `visual review unavailable: ${sandbox.visual.reason ?? 'no reason'}`, [reviewed.runId]));
  if (sandbox?.cleanupFailed === true) found.push(item('sandbox-cleanup-failed', {}, 'a reviewer sandbox container outlived its review', [reviewed.runId]));
  const gated = latest(report => Array.isArray(report.gates) && report.gates.length);
  if (gated?.report.gates.some(gate => gate?.name === 'actionlint' && gate.status === 'failed')) found.push(item('gate-harness', { gate: 'actionlint' }, 'the fixed actionlint gate failed on trunk workflow policy', [gated.runId]));
  const merged = new Map();
  for (const entry of found) { const prior = merged.get(entry.fingerprint); merged.set(entry.fingerprint, prior ? { ...prior, runs: [...new Set([...prior.runs, ...entry.runs])].sort((a, b) => b - a) } : entry); }
  return [...merged.values()];
}

// Checkpoint dedupe: count observations of an ongoing streak; a cleared incident stays seven days so its issue closes idempotently.
export function foldIncidents(previous, found, now) {
  const next = found.map(entry => {
    const prior = previous.find(old => old.fingerprint === entry.fingerprint), ongoing = prior?.status === 'open';
    // Repair memory survives clearing and recurrence; the open-PR number is recomputed by every observation.
    return { ...entry, runs: entry.runs.slice(0, 5), firstSeen: prior?.firstSeen ?? now, since: ongoing ? prior.since : now, lastSeen: now, count: ongoing ? Math.min(prior.count + 1, 1_000_000) : 1, status: 'open', ...(prior?.repair ? { repair: prior.repair } : {}) };
  });
  for (const prior of previous) if (!next.some(entry => entry.fingerprint === prior.fingerprint) && (prior.status === 'open' || now - prior.lastSeen < 7 * DAY)) { const { pr, ...rest } = prior; next.push({ ...rest, status: 'cleared' }); }
  return next.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.lastSeen - a.lastSeen).slice(0, 20);
}
// An incident earns an issue (and maybe a repair) after two observations; a failed job needs two failing runs within 24h.
export const ready = entry => entry.status === 'open' && entry.count >= 2 && (entry.kind !== 'job-failed' || entry.runs.length >= 2);
export const syncable = entries => entries.filter(entry => ready(entry) || entry.status === 'cleared' && entry.count >= 2);
export function validateIncidents(value) {
  const keys = 'count,detail,fingerprint,firstSeen,kind,lastSeen,runs,since,status', hex = /^[a-f0-9]{64}$/;
  const repairOk = r => r === undefined || r && typeof r === 'object' && Object.keys(r).sort().join() === 'at,last,policy,runId,tasks' && Array.isArray(r.tasks) && r.tasks.length >= 1 && r.tasks.length <= 5 && r.tasks.every(task => hex.test(task)) && new Set(r.tasks).size === r.tasks.length && r.tasks.includes(r.last) && Number.isSafeInteger(r.runId) && r.runId > 0 && Number.isSafeInteger(r.at) && r.at > 0 && (r.policy === null || hex.test(r.policy));
  if (!Array.isArray(value) || value.length > 20 || new Set(value.map(entry => entry?.fingerprint)).size !== value.length || value.some(entry => !entry || typeof entry !== 'object' || Object.keys(entry).filter(key => !['pr', 'repair'].includes(key)).sort().join() !== keys || !repairOk(entry.repair) || entry.pr !== undefined && (!Number.isSafeInteger(entry.pr) || entry.pr < 1) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !KINDS.includes(entry.kind) || typeof entry.detail !== 'string' || !/^[\x20-\x7e]{0,200}$/.test(entry.detail) || !Array.isArray(entry.runs) || entry.runs.length > 5 || entry.runs.some(id => !Number.isSafeInteger(id) || id < 1) || ['firstSeen', 'since', 'lastSeen'].some(key => !Number.isSafeInteger(entry[key]) || entry[key] <= 0) || entry.firstSeen > entry.since || entry.since > entry.lastSeen || !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1_000_000 || !['open', 'cleared'].includes(entry.status))) throw Error('malformed incidents');
  return value;
}

// Repair admission, at most one open proposal per incident and three attempts: never while an attempt runs or a PR awaits
// Oliver; afterwards only once the PR was (a) closed unmerged, (b) merged with evidence after the merge, or for (c) an attempt
// without a PR, once trusted policy changed or 24h passed. A policy change alone never retries over an open PR.
export const MAX_REPAIRS = 3;
export const harnessIncidentMarker = incident => `<!-- annie-harness-incident:${incident} -->`;
export function repairDecision({ entry, running = false, last = null, policy, now, evidenceAt = 0 }) {
  const repair = entry.repair, attempt = (repair?.tasks.length ?? 0) + 1;
  if (running) return { admit: false, reason: 'in-flight' };
  if (entry.pr) return { admit: false, reason: 'awaiting-review', pr: entry.pr };
  if (!repair) return { admit: true, attempt, reason: 'first' };
  if (repair.tasks.length >= MAX_REPAIRS) return { admit: false, reason: 'attempts-exhausted' };
  if (last?.state === 'open') return { admit: false, reason: 'awaiting-review', pr: last.number };
  if (last?.state === 'closed') return { admit: true, attempt, reason: 'closed-unmerged' };
  if (last?.state === 'merged') return entry.since > last.at || evidenceAt > last.at ? { admit: true, attempt, reason: 'persists-after-merge' } : { admit: false, reason: 'merged-awaiting-evidence', pr: last.number };
  if (last?.state === 'none') return repair.policy !== null && repair.policy !== policy || now - repair.at >= DAY ? { admit: true, attempt, reason: 'retry-without-pr' } : { admit: false, reason: 'no-pr-backoff' };
  return { admit: false, reason: 'unknown-last-attempt' };
}
// Merge harness attempts seen in the ledger or flights into the checkpoint memory; observed attempts carry no admission policy.
export function foldRepair(repair, attempts) {
  const ordered = [...attempts].sort((a, b) => a.runId - b.runId), newest = ordered.at(-1);
  if (!newest) return repair ?? null;
  const tasks = [...new Set([...(repair?.tasks ?? []), ...ordered.map(a => a.task)])].slice(-5);
  if (repair && newest.runId <= repair.runId) return { ...repair, tasks: tasks.includes(repair.last) ? tasks : [...tasks.slice(-4), repair.last] };
  return { tasks, last: newest.task, runId: newest.runId, at: newest.at, policy: null };
}
// Open harness PRs per incident, by body marker or a known attempt branch; an unattributable one blocks every repair.
export function openRepairs(prs, known) {
  const open = new Map(); let unknown = [];
  for (const pr of prs) {
    const ref = String(pr?.head?.ref ?? '');
    if (!ref.startsWith(HARNESS_BRANCH_PREFIX) || pr.head?.repo?.full_name && pr.head.repo.full_name !== OWN) continue;
    const incident = /<!-- annie-harness-incident:([a-f0-9]{64}) -->/.exec(typeof pr.body === 'string' ? pr.body : '')?.[1] ?? known.get(ref);
    if (!incident) unknown.push(pr.number); else if (!open.has(incident) || open.get(incident) > pr.number) open.set(incident, pr.number);
  }
  return { open, unknown };
}

// Bounded untrusted digest for a harness repair: incident facts, failing jobs/steps, redacted log tails, sanitized report fields.
export const logTail = (log, limit = 4000) => String(log ?? '').slice(-4 * limit).split(/\r?\n/).slice(String(log ?? '').length > 4 * limit ? 1 : 0).map(line => redact(line.replace(/^\d{4}-\d{2}-\d{2}T\S+Z /, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).trimEnd()).join('\n').slice(-limit);
const REPORT_KEYS = ['taskKind', 'phase', 'outcome', 'reason', 'blocker', 'sourceRejection', 'modelFailure', 'gateRepair', 'gates', 'sandbox', 'reviewDiagnostics', 'executorDiagnostics', 'findings'];
const clean = node => typeof node === 'string' ? redact(node).slice(0, 500) : Array.isArray(node) ? node.slice(0, 20).map(clean) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).slice(0, 30).map(([key, value]) => [safe(key, 64), clean(value)])) : ['number', 'boolean'].includes(typeof node) ? node : null;
export function makeDigest(entry, runs = [], report = null) {
  const value = { incident: entry.fingerprint, kind: entry.kind, detail: entry.detail, firstSeen: iso(entry.firstSeen), count: entry.count, runs: runs.slice(0, 3).map(run => ({ runId: run.runId, url: `https://github.com/${OWN}/actions/runs/${run.runId}`, ...(run.error ? { error: safe(run.error) } : {}), jobs: (run.jobs ?? []).slice(0, 10).map(job => ({ name: safe(job.name), conclusion: safe(job.conclusion, 32), steps: (job.steps ?? []).slice(0, 20).map(step => ({ name: safe(step.name), conclusion: safe(step.conclusion, 32) })), ...(typeof job.log === 'string' ? { log: logTail(job.log) } : {}) })) })), report: report ? clean(Object.fromEntries(REPORT_KEYS.filter(key => key in report).map(key => [key, report[key]]))) : null };
  if (JSON.stringify(value).length > 49_152) for (const run of value.runs) for (const job of run.jobs) delete job.log;
  if (JSON.stringify(value).length > 49_152) value.runs = [];
  return value;
}
export function parseDigest(value, task) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 65_536) throw Error('incident digest missing or oversized');
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.incident !== task.incident || !KINDS.includes(parsed.kind)) throw Error('incident digest differs from trusted task');
  return parsed;
}

// Issues: one per fingerprint, found by a hidden marker on a bot-authored labelled issue with complete bounded pagination.
const marker = fingerprint => `<!-- annie-incident:${fingerprint} -->`;
export function incidentBody(entry) {
  return [`\u2620\ufe0f Annie noticed her own machinery failing: **${md(entry.kind)}**.`, '', `Detail: ${md(entry.detail)}`, `Fingerprint: ${entry.fingerprint.slice(0, 16)}`, `First seen ${iso(entry.firstSeen)}; current streak since ${iso(entry.since)}; ${entry.count} observation(s).`,
    ...(entry.runs.length ? ['', 'Runs:', ...entry.runs.map(id => `- https://github.com/${OWN}/actions/runs/${id}`)] : []), '',
    REPAIRABLE.has(entry.kind) ? `Annie may propose a reviewed harness fix as a PR from an \`annie/harness/\u2026\` branch; only Oliver merges it.` : 'This kind needs an operator; Annie will not attempt a harness fix.',
    'Automated incident report with sanitized facts only, no raw logs. It closes itself once the incident clears.', marker(entry.fingerprint)].join('\n');
}
export async function incidentIssues(api) {
  const found = new Map();
  for (const issue of await api.pages(`/repos/${OWN}/issues?state=all&labels=${INCIDENT_LABEL}`)) {
    const [, fingerprint] = /<!-- annie-incident:([a-f0-9]{64}) -->/.exec(typeof issue?.body === 'string' ? issue.body : '') ?? [];
    if (fingerprint && !issue.pull_request && issue.user?.login === 'github-actions[bot]' && !(found.get(fingerprint)?.number < issue.number)) found.set(fingerprint, issue);
  }
  return found;
}
const write = async (api, path, method, body) => (await api.request(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).json().catch(() => ({}));
const comment = (api, number, body) => write(api, `/repos/${OWN}/issues/${number}/comments`, 'POST', { body });
async function ensureLabel(api) {
  try { await api.get(`/repos/${OWN}/labels/${INCIDENT_LABEL}`); }
  catch (error) { if (!/http-404$/.test(error.message)) throw error; await write(api, `/repos/${OWN}/labels`, 'POST', { name: INCIDENT_LABEL, color: 'b60205', description: 'Annie harness incident, automated' }); }
}
// Create, update, reopen on recurrence, or close once cleared; a maintainer closing an ongoing incident is respected.
export async function syncIncidents(api, entries) {
  const targets = syncable(entries), receipts = [];
  if (!targets.length) return receipts;
  const repo = await api.get(`/repos/${OWN}`);
  if (repo.has_issues !== true) throw Error('incident issues need GitHub issues enabled');
  const issues = await incidentIssues(api);
  let labelled = false;
  for (const entry of targets) {
    const found = issues.get(entry.fingerprint), body = incidentBody(entry);
    const receipt = { kind: entry.status === 'open' ? 'incident-issue' : 'incident-close', fingerprint: entry.fingerprint.slice(0, 16), number: found?.number ?? null, status: 'failed', reason: null };
    try {
      if (entry.status === 'cleared') {
        if (found?.state !== 'open') Object.assign(receipt, { status: 'skipped', reason: found ? 'already-closed' : 'no-issue' });
        else { await write(api, `/repos/${OWN}/issues/${found.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' }); await comment(api, found.number, 'Incident cleared: no current evidence. Closing. \u2620\ufe0f'); Object.assign(receipt, { status: 'applied', reason: 'closed' }); }
      } else if (!found) {
        if (!labelled) { await ensureLabel(api); labelled = true; }
        const created = await write(api, `/repos/${OWN}/issues`, 'POST', { title: `Annie incident: ${entry.kind} (${entry.fingerprint.slice(0, 8)})`, body, labels: [INCIDENT_LABEL] });
        Object.assign(receipt, { status: 'applied', reason: 'created', number: Number.isSafeInteger(created.number) ? created.number : null });
      } else if (found.state === 'closed') {
        if (!(Date.parse(found.closed_at) < entry.since)) Object.assign(receipt, { status: 'skipped', reason: 'closed-by-maintainer' });
        else { await write(api, `/repos/${OWN}/issues/${found.number}`, 'PATCH', { state: 'open', body }); await comment(api, found.number, 'Incident recurred after clearing. Reopening. \u2620\ufe0f'); Object.assign(receipt, { status: 'applied', reason: 'reopened' }); }
      } else if (found.body !== body) { await write(api, `/repos/${OWN}/issues/${found.number}`, 'PATCH', { body }); Object.assign(receipt, { status: 'applied', reason: 'updated' }); }
      else Object.assign(receipt, { status: 'skipped', reason: 'unchanged' });
    } catch (error) { receipt.reason = safe(error.message); }
    receipts.push(receipt);
    if (entry.status === 'open' && entry.pr && receipt.number && receipt.status !== 'failed' && receipt.reason !== 'closed-by-maintainer') receipts.push(await awaiting(api, entry, receipt.number));
  }
  return receipts;
}
// While a harness PR awaits Oliver, say so once per incident and PR, found again by marker on complete comment pages.
async function awaiting(api, entry, number) {
  const receipt = { kind: 'incident-awaiting', fingerprint: entry.fingerprint.slice(0, 16), number, status: 'failed', reason: null }, key = `<!-- annie-awaiting:${entry.fingerprint}:${entry.pr} -->`;
  try {
    if ((await api.pages(`/repos/${OWN}/issues/${number}/comments`)).some(item => typeof item?.body === 'string' && item.body.includes(key))) Object.assign(receipt, { status: 'skipped', reason: 'already-applied' });
    else { await comment(api, number, `\u2620\ufe0f Awaiting review/merge of #${entry.pr}; Annie starts no other harness repair for this incident meanwhile.\n${key}`); Object.assign(receipt, { status: 'applied', reason: `awaiting #${entry.pr}` }); }
  } catch (error) { receipt.reason = safe(error.message); }
  return receipt;
}

export function harnessPullBody({ run, task, issue, branch, changed }) {
  return [`\u2620\ufe0f Annie harness self-repair for ${issue ? `incident #${issue}` : `incident ${task.incident.slice(0, 16)} (issue lookup failed)`}, from \`${branch}\`.`,
    'Oliver reviews and merges this himself; Annie never merges, pushes trunk, or integrates harness PRs.', '',
    '### Diagnosis (model-written, unverified)', `> ${md(run.diagnosis ?? 'none recorded', 1500)}`, '',
    '### Independent review findings', ...(run.findings?.length ? run.findings.slice(0, 20).map(finding => `- ${md(finding)}`) : ['- none blocking or advisory']), '',
    '### Changed files', ...changed.slice(0, 50).map(name => `- ${md(name)}`), '',
    '### Gates', 'Maintain-side and fresh credential-free release-side harness gates passed: npm ci, npm test, bash -n, workflow YAML parse, actionlint.',
    `Base ${run.base}, tree ${run.tree}, candidate ${run.commit}, task ${task.fingerprint.slice(0, 16)}.`, `<!-- annie-harness:${task.fingerprint} -->`, harnessIncidentMarker(task.incident)].join('\n');
}
// An open PR from another harness branch for this incident: by body marker or, for PRs older than that marker, by an earlier
// delivery comment on the incident issue naming it. Lookup failures throw, so delivery fails closed before any push.
async function openTwin(native, incident, branch, issue) {
  const open = (await native.pages(`/repos/${OWN}/pulls?state=open`)).filter(pr => String(pr?.head?.ref ?? '').startsWith(HARNESS_BRANCH_PREFIX) && pr.head.ref !== branch && !(pr.head?.repo?.full_name && pr.head.repo.full_name !== OWN));
  if (!open.length) return null;
  const named = new Set();
  // Only Annie's own creation announcements name a PR; a body marking any incident decides alone.
  if (issue) for (const item of await native.pages(`/repos/${OWN}/issues/${issue}/comments`)) if (item?.user?.login === 'github-actions[bot]' && typeof item.body === 'string' && item.body.includes('<!-- annie-delivery:')) for (const [, number] of item.body.matchAll(/Harness fix ready for review: #(\d+) /g)) named.add(Number(number));
  const marked = pr => /<!-- annie-harness-incident:([a-f0-9]{64}) -->/.exec(typeof pr.body === 'string' ? pr.body : '')?.[1];
  return open.filter(pr => marked(pr) ? marked(pr) === incident : named.has(pr.number)).sort((a, b) => a.number - b.number)[0]?.number ?? null;
}
// Model-free delivery after the fresh credential-free harness gate: verify the bundle by plumbing (candidate code never runs
// here), push C to its own branch with the PAT, open a PR against trunk, and tell the incident issue either way.
export async function deliverHarness({ source, bundle, run, task, gate, native, pat, hasPat }) {
  const branch = harnessBranch(task.fingerprint), receipts = [], note = (kind, status, extra = {}) => receipts.push({ kind, status, number: null, reason: null, ...extra });
  let pushed = false, pr = null, problem = null, issue = null, twin = null;
  try { issue = (await incidentIssues(native)).get(task.incident)?.number ?? null; } catch (error) { note('incident-lookup', 'failed', { reason: safe(error.message) }); }
  try {
    if (gate !== 'success') throw Error(`fresh harness gate ${/^[a-z_]{1,20}$/.test(gate ?? '') ? gate : 'missing'}`);
    await git(source, 'bundle', 'verify', bundle);
    await git(source, 'fetch', '--no-tags', bundle, '+HEAD:refs/annie/harness-candidate');
    const commit = await git(source, 'rev-parse', 'refs/annie/harness-candidate');
    const parents = (await git(source, 'show', '-s', '--format=%P', commit)).split(' ').filter(Boolean);
    const changed = (await git(source, 'diff', '--name-only', '--no-renames', run.base, commit)).split('\n').filter(Boolean);
    if (commit !== run.commit || parents.join() !== run.base || await git(source, 'rev-parse', `${commit}^{tree}`) !== run.tree) throw Error('harness candidate identity mismatch');
    // The shared scope rule again, before any PAT use: a PR's own workflows would run with write tokens on open.
    const scope = await harnessScope(source, run.base, commit);
    if (scope) throw Error(scope);
    // One open proposal per incident: an earlier open PR stays untouched, so nothing new is pushed or opened.
    twin = await openTwin(native, task.incident, branch, issue);
    if (twin) { note('harness-pr', 'skipped', { number: twin, reason: 'awaiting-earlier-pr' }); throw Error(`#${twin} for this incident still awaits review/merge`); }
    if (!hasPat) throw Error('ANNIE_GH_TOKEN missing in honest-annie-release');
    const auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$ANNIE_GH_TOKEN"; }; f'];
    const ref = `refs/heads/${branch}`, remote = async () => (await git(source, ...auth, 'ls-remote', 'origin', ref)).split(/\s/)[0];
    const existing = await remote().catch(() => { throw Error('harness branch read failed; check ANNIE_GH_TOKEN Contents permission'); });
    if (existing && existing !== commit) throw Error('harness branch exists with other content');
    if (!existing) await git(source, ...auth, 'push', 'origin', `${commit}:${ref}`).catch(() => { throw Error('harness branch push failed; check ANNIE_GH_TOKEN Contents and Workflows write'); });
    if (await remote() !== commit) throw Error('harness branch push not verified');
    pushed = true; note('harness-branch', existing ? 'skipped' : 'applied', { reason: existing ? 'already-pushed' : null });
    const open = (await native.pages(`/repos/${OWN}/pulls?state=all&head=${encodeURIComponent(`${OWN.split('/')[0]}:${branch}`)}`)).find(item => item?.head?.ref === branch);
    // Same branch only on an effects retry of the same task: an incident recurring after a merge changes the trusted policy and
    // thus the task fingerprint and branch, so a found PR is this task's own earlier proposal.
    if (open) { pr = open; note('harness-pr', 'skipped', { number: open.number, reason: open.state === 'open' ? 'already-open' : open.merged_at ? 'already-merged' : 'closed-unmerged' }); }
    else {
      const created = await write(pat, `/repos/${OWN}/pulls`, 'POST', { title: `fix(annie): harness repair for incident ${task.incident.slice(0, 8)}`, head: branch, base: 'trunk', body: harnessPullBody({ run, task, issue, branch, changed }) }).catch(error => { throw Error(`PR creation failed (${safe(error.message, 80)}); check ANNIE_GH_TOKEN Pull requests write`); });
      if (!Number.isSafeInteger(created.number)) throw Error('PR creation returned no number');
      pr = created; note('harness-pr', 'applied', { number: created.number });
    }
  } catch (error) { problem = safe(error.message); if (!twin) note(pushed ? 'harness-pr' : 'harness-branch', 'failed', { reason: problem }); }
  const message = twin ? `Harness fix from \`${branch}\` not delivered: #${twin} for this incident still awaits review/merge, and Annie leaves it unchanged.` : pr?.state === 'closed' ? (pr.merged_at ? `Harness fix from \`${branch}\` was already merged as #${pr.number}.` : `Harness fix from \`${branch}\` was proposed as #${pr.number}, which was closed unmerged; Annie will not reopen it.`) : pr ? `Harness fix ready for review: #${pr.number} from \`${branch}\`. Only Oliver merges it.` : pushed ? `Harness fix ready on branch \`${branch}\` but PR creation failed: ${md(problem)}` : `Harness fix could not be delivered: ${md(problem)}`;
  const key = `<!-- annie-delivery:${digest({ task: task.fingerprint, message })} -->`;
  let told = false;
  if (!issue) note('incident-comment', 'failed', { reason: 'incident issue not found' });
  else try {
    if ((await native.pages(`/repos/${OWN}/issues/${issue}/comments`)).some(item => typeof item?.body === 'string' && item.body.includes(key))) note('incident-comment', 'skipped', { number: issue, reason: 'already-applied' });
    else { await comment(native, issue, `\u2620\ufe0f ${message}\n${key}`); note('incident-comment', 'applied', { number: issue }); }
    told = true;
  } catch (error) { note('incident-comment', 'failed', { number: issue, reason: safe(error.message) }); }
  // Delivered means a PR for Oliver exists or existed for this exact task; a closed-unmerged one is still this task's terminal answer.
  return { receipts, branch, delivered: Boolean(pr), communicated: Boolean(pr) || told, message: pr ? `${pr.state === 'closed' ? (pr.merged_at ? 'merged' : 'closed unmerged') : 'open'} as #${pr.number}` : problem };
}
