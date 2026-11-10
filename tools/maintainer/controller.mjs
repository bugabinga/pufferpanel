import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_BRANCH_PREFIX, HARNESS_CAP, OWN, REF, activeRejections, harnessBranch, isSha, providerId, validChanged, validFindings, validateHolds, validateRejections, validateTask, versionFor } from './task.mjs';
import { checkPR, protectedPolicy } from './pr.mjs';
import { MAX_REPAIRS, REPAIRABLE, detectIncidents, foldIncidents, foldRepair, makeDigest, openRepairs, ready, repairDecision, syncIncidents, syncable, validateIncidents } from './incident.mjs';

export const POLICY_PATH = '.github/workflows/honest-annie.yml';
export const WAKE_PATH = '.github/workflows/annie-pr-wake.yml';
const HOUR = 3_600_000, DAY = 24 * HOUR, MARGIN = 5 * 60_000;
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error(reason); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : fail('invalid ledger timestamp');
const allowedEvents = ['schedule', 'push', 'issues', 'workflow_dispatch', 'workflow_run'];
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(Date.parse(value)).toISOString() === value;
const providerList = value => Array.isArray(value) && value.length <= 64 && value.every(providerId) && new Set(value).size === value.length;
const failureList = value => Array.isArray(value) && value.length <= 64 && value.every(item => item && Object.keys(item).every(key => ['provider', 'kind', 'observedAt', 'resetAt'].includes(key)) && providerId(item.provider) && ['quota', 'auth', 'transient'].includes(item.kind) && iso(item.observedAt) && (item.resetAt === undefined || iso(item.resetAt) && Date.parse(item.resetAt) > Date.parse(item.observedAt) && Date.parse(item.resetAt) <= Date.parse(item.observedAt) + 31 * DAY));
export function prFingerprint({ number, head, base, policy }) { return digest({ number, head, base, policy }); }
// Once per incident and trusted policy: a merged harness change (new policy) earns a recurring incident one more attempt.
export const harnessFingerprint = (incident, policy, attempt = 1) => digest({ kind: 'harness', incident, policy, attempt });
// Rejection memory: each review-rejected maintenance run's changed-file area and first five blocking findings, deduplicated
// by run, kept 30 days, at most the 20 newest.
export function foldRejections(previous, records, now) {
  const remembered = new Map(previous.map(entry => [entry.runId, entry]));
  for (const { run, lease, settlement } of records) {
    if (lease?.task.kind !== 'maintenance' || settlement?.phase !== 'rejected' || settlement.reason !== 'review-rejected' || !settlement.changedFiles) continue;
    const { files, count, digest: area } = settlement.changedFiles;
    remembered.set(run.id, { runId: run.id, day: lease.task.day, files, count, digest: area, findings: (settlement.blockingFindings ?? []).slice(0, 5) });
  }
  return activeRejections([...remembered.values()].sort((a, b) => a.runId - b.runId), now).slice(-20);
}
export function makeLease({ run, repoId, workflowId, task, cap, now = Date.now() }) {
  if (run.run_attempt !== 1 || !integer(run.id) || !integer(repoId) || !integer(workflowId) || !isSha(run.head_sha) || !allowedEvents.includes(run.event)) fail('ineligible paid execution');
  const createdAt = time(run.created_at), deadline = createdAt + 2 * HOUR;
  if (createdAt > now || now >= deadline - 90_000 || !Number.isFinite(cap) || cap <= 0 || cap > (task.kind === 'harness' ? HARNESS_CAP : 15)) fail('paid horizon or allowance exhausted');
  const lease = { schema: 1, type: 'lease', runId: run.id, attempt: 1, repoId, workflowId, headSha: run.head_sha, event: run.event, createdAt: run.created_at, deadline, cap, task: validateTask(task) };
  return { ...lease, hash: digest(lease) };
}
export function verifyLease(lease, { env, task }) {
  const keys = ['schema', 'type', 'runId', 'attempt', 'repoId', 'workflowId', 'headSha', 'event', 'createdAt', 'deadline', 'cap', 'task', 'hash'];
  if (!lease || typeof lease !== 'object' || Object.keys(lease).sort().join(',') !== keys.sort().join(',') || !integer(lease.runId) || !integer(lease.repoId) || !integer(lease.workflowId) || !allowedEvents.includes(lease.event)) fail('invalid prepaid lease schema');
  const { hash, ...body } = lease ?? {};
  if (body.schema !== 1 || body.type !== 'lease' || hash !== digest(body) || body.attempt !== 1 || String(body.runId) !== env.GITHUB_RUN_ID || env.GITHUB_RUN_ATTEMPT !== '1' || body.headSha !== env.GITHUB_SHA || body.repoId !== Number(env.GITHUB_REPOSITORY_ID) || body.deadline !== time(body.createdAt) + 2 * HOUR || body.cap <= 0 || body.cap > (body.task?.kind === 'harness' ? HARNESS_CAP : 15) || !Number.isFinite(body.cap) || digest(body.task) !== digest(validateTask(task))) fail('invalid prepaid lease binding');
  return lease;
}
export function rollingAllowance(entries, now = Date.now()) {
  let held = 0;
  for (const { lease, settlement, settledAt, terminal = true, unknown = false, updatedAt, deadline = 0 } of entries) {
    if (unknown) { if (!terminal || Math.max(time(updatedAt), deadline) + DAY + MARGIN > now) held += 15; continue; }
    if (!lease || lease.cap <= 0 || lease.cap > 15 || !Number.isFinite(lease.cap)) fail('invalid accounting lease');
    const actual = ['gating', 'committing', 'publishing', 'published', 'rejected', 'failed', 'managing'].includes(settlement?.phase) && settlement?.ledgerReservation === lease.hash && settlement?.usageComplete === true && settlement?.reportedUsage?.status === 'known' && Number.isFinite(settlement.reportedUsage.cost) && settlement.reportedUsage.cost >= 0 ? settlement.reportedUsage.cost : null;
    if (actual !== null && terminal) { if (time(settledAt) + DAY > now) held += actual; }
    else if (!terminal || lease.deadline + DAY + MARGIN > now) held += lease.cap;
  }
  return Math.max(0, 15 - held);
}

export class GitHub {
  constructor(token, fetchImpl = fetch, delays = [1000, 3000]) { this.token = token; this.fetch = fetchImpl; this.delays = delays; }
  // Bounded read retry: network error, 5xx, or 429 only; 4xx and mutations are never retried. Null means network failure.
  async send(url, init, delays = this.delays) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (res && res.status < 500 && res.status !== 429 || attempt >= delays.length) return res;
      await new Promise(done => setTimeout(done, delays[attempt]));
    }
  }
  async request(path, options = {}) {
    if (!path.startsWith('/repos/') || path.split('?')[0].split('/').includes('..')) fail('invalid API path'); // Segment check: compare uses A...B.
    const res = await this.send(`https://api.github.com${path}`, { ...options, redirect: 'manual', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie-controller', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers } }, (options.method ?? 'GET') === 'GET' ? this.delays : []);
    if (!res) fail('GitHub controller network-error');
    if (!res.ok) fail(`GitHub controller http-${res.status}`);
    return res;
  }
  async get(path) { return (await this.request(path)).json(); }
  async pages(path, key = null) {
    const values = [], ids = new Set(); let expectedTotal = null;
    const workflowHistory = /\/actions\/workflows\/\d+\/runs(?:\?|$)/.test(path);
    const filteredHistory = workflowHistory && /[?&](actor|branch|check_suite_id|created|event|head_sha|status)=/.test(path);
    const maxPages = workflowHistory && !filteredHistory ? 100 : 10;
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const body = await res.json(), items = key ? body[key] : body;
      if (!Array.isArray(items) || items.length > 100 || key && (!Number.isSafeInteger(body.total_count) || body.total_count >= maxPages * 100 || expectedTotal !== null && body.total_count !== expectedTotal)) fail('incomplete API pagination');
      if (key) {
        expectedTotal = body.total_count;
        for (const item of items) { if (!integer(item.id) || ids.has(item.id)) fail('duplicate or invalid paginated identity'); ids.add(item.id); }
      }
      values.push(...items);
      const next = /rel="next"/.test(res.headers.get('link') ?? '');
      if (!next) { if (key && values.length !== body.total_count) fail('incomplete API count'); return values; }
    }
    fail('API pagination bound reached');
  }
  // API request whose body lives behind a storage redirect; native auth is never forwarded to storage.
  async stored(path, stage) {
    const res = await this.send(`https://api.github.com/repos/${OWN}${path}`, { redirect: 'manual', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' } });
    if (!res) fail(`${stage} failed network-error api`);
    if (res.status !== 302 && !res.ok) fail(`${stage} failed http-${res.status} api`);
    if (res.status !== 302) return res;
    const url = new URL(res.headers.get('location'));
    if (url.protocol !== 'https:' || url.username || url.password || !(/(^|\.)blob\.core\.windows\.net$/.test(url.hostname) || /(^|\.)githubusercontent\.com$/.test(url.hostname) || /(^|\.)actions\.github\.com$/.test(url.hostname))) fail(`untrusted ${stage.split(' ')[0]} redirect`);
    const body = await this.send(url.href, { redirect: 'error' }); // Deliberately NO Authorization.
    if (!body) fail(`${stage} failed network-error blob`);
    if (!body.ok) fail(`${stage} failed http-${body.status} blob`);
    return body;
  }
  async artifact(meta, filename) {
    if (!integer(meta?.id) || meta.expired || !/^sha256:[a-f0-9]{64}$/.test(meta.digest ?? '') || !Number.isInteger(meta.size_in_bytes) || meta.size_in_bytes < 1 || meta.size_in_bytes > 262144) fail('unavailable ledger artifact');
    const archive = await this.stored(`/actions/artifacts/${meta.id}/zip`, 'artifact download');
    const bytes = await boundedBody(archive, 262144);
    if (`sha256:${digest(bytes)}` !== meta.digest) fail('artifact digest mismatch');
    return unzipJSON(bytes, filename);
  }
  // Last 64 KiB of a job log, streamed with a 16 MiB ceiling; callers redact and bound it further.
  async jobLog(id) {
    if (!integer(id)) fail('invalid job identity');
    const res = await this.stored(`/actions/jobs/${id}/logs`, 'job log download');
    let tail = Buffer.alloc(0), size = 0;
    for await (const chunk of res.body) { size += chunk.length; if (size > 16 * 1024 * 1024) fail('job log too large'); tail = Buffer.concat([tail, chunk]).subarray(-65536); }
    return tail.toString('utf8');
  }
}
async function boundedBody(res, max) {
  const chunks = []; let size = 0;
  for await (const chunk of res.body) { size += chunk.length; if (size > max) fail('artifact download too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
// Parse, never extract; one expected regular JSON file, bounded compressed and decompressed sizes.
export function unzipJSON(bytes, filename) {
  if (bytes.length > 262144 || bytes.length < 22) fail('invalid ZIP size');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) fail('invalid ZIP directory');
  const start = bytes.readUInt32LE(end + 16), directorySize = bytes.readUInt32LE(end + 12);
  if (start + directorySize !== end || start + 46 > end || bytes.readUInt32LE(start) !== 0x02014b50) fail('invalid ZIP central entry');
  const flags = bytes.readUInt16LE(start + 8), method = bytes.readUInt16LE(start + 10), compressed = bytes.readUInt32LE(start + 20), size = bytes.readUInt32LE(start + 24), names = bytes.readUInt16LE(start + 28), extra = bytes.readUInt16LE(start + 30), comment = bytes.readUInt16LE(start + 32), offset = bytes.readUInt32LE(start + 42);
  const name = bytes.subarray(start + 46, start + 46 + names).toString('utf8');
  if (name !== filename || name.includes('/') || flags & ~0x808 || ![0, 8].includes(method) || size > 131072 || compressed > 262144 || start + 46 + names + extra + comment !== end || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || (bytes.readUInt32LE(start + 38) >>> 16 & 0xf000) === 0xa000) fail('unsafe ZIP entry');
  const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), data = offset + 30 + localNameLength + localExtra;
  if (offset !== 0 || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== filename || data + compressed > start) fail('ZIP local identity mismatch');
  const descriptor = start - data - compressed;
  if (!(flags & 8) && descriptor !== 0 || flags & 8 && ![12, 16].includes(descriptor)) fail('unexpected ZIP payload');
  if (flags & 8) {
    const at = data + compressed + (descriptor === 16 ? 4 : 0);
    if (descriptor === 16 && bytes.readUInt32LE(data + compressed) !== 0x08074b50 || bytes.readUInt32LE(at + 4) !== compressed || bytes.readUInt32LE(at + 8) !== size) fail('invalid ZIP descriptor');
  }
  const packed = bytes.subarray(data, data + compressed), body = method === 8 ? inflateRawSync(packed, { maxOutputLength: 131072 }) : packed;
  if (body.length !== size) fail('ZIP size mismatch');
  return JSON.parse(body.toString('utf8'));
}
export function trustedRun(run, repo, workflow) {
  return run.repository?.id === repo.id && run.head_repository?.id === repo.id && run.workflow_id === workflow.id && run.path === POLICY_PATH && run.head_branch === 'trunk' && isSha(run.head_sha) && allowedEvents.includes(run.event);
}
export async function verifyWake(api, event, repo) {
  const id = event.workflow_run?.id;
  if (!integer(id)) fail('missing PR wake execution');
  const [workflow, run] = await Promise.all([api.get(`/repos/${OWN}/actions/workflows/annie-pr-wake.yml`), api.get(`/repos/${OWN}/actions/runs/${id}`)]);
  if (workflow.path !== WAKE_PATH || run.workflow_id !== workflow.id || run.repository?.id !== repo.id || run.path !== WAKE_PATH || !['pull_request', 'pull_request_review'].includes(run.event) || run.status !== 'completed') fail('foreign PR wake refused');
}
export const noCompletionEvidence = report => report?.fingerprint == null && report?.ledgerReservation == null && report?.reportedUsage?.status === 'unknown' && report?.commit == null && report?.releaseCommit == null && report?.publicationDigest == null && report?.managementApproved !== true && report?.usageComplete !== true && ['base', 'tree', 'prHead', 'prNumber'].every(key => report?.[key] == null) && (report?.sourceIdentity == null || Object.values(report.sourceIdentity).every(value => value == null || Array.isArray(value) && value.length === 0)) && (report?.day == null || report?.phase === 'starting' && /^\d{4}-\d{2}-\d{2}$/.test(report.day) && report?.sourceChanged !== true && report?.kind !== 'source' && report?.kind !== 'github-management' && report?.managementApproved !== true);
function singleton(artifacts, name) { const found = artifacts.filter(item => item.name === name); if (found.length > 1) fail('duplicate ledger artifact'); return found[0]; }
export function provenZeroDispatch(run, jobs) {
  if (run.status !== 'completed' || !Array.isArray(jobs)) return false;
  // A first attempt GitHub never started (approval-gated or invalid workflow) has no jobs and cannot have dispatched a model.
  if (!jobs.length && run.run_attempt === 1 && ['action_required', 'startup_failure'].includes(run.conclusion)) return true;
  const maintain = jobs.find(job => job.name === 'maintain');
  if (maintain?.conclusion === 'skipped') return true;
  const model = maintain?.steps?.find(step => step.name === 'Maintain or review selected task');
  if (model) return model.conclusion === 'skipped';
  return !maintain && jobs.some(job => job.name === 'check' && ['failure', 'timed_out'].includes(job.conclusion));
}
export async function observeLedger(api, repo, workflow, now, currentId) {
  // GitHub permits reruns for 30 days after creation; include accounting/termination tail.
  const history = async (start, end) => {
    const path = `/repos/${OWN}/actions/workflows/${workflow.id}/runs?created=${encodeURIComponent(new Date(start).toISOString() + '..' + new Date(end).toISOString())}`;
    try { return await api.pages(path, 'workflow_runs'); }
    catch (error) {
      if (!/pagination|API count/.test(error.message) || end - start <= HOUR) throw error;
      const middle = Math.floor((start + end) / 2);
      return [...await history(start, middle), ...await history(middle + 1, end)];
    }
  };
  const runs = (await history(now - 33 * DAY, now)).sort((a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id);
  if (new Set(runs.map(run => run.id)).size !== runs.length) fail('overlapping history identity');
  const entries = [], records = [], outstanding = [], blockers = []; let checkpoint = null; let hadCheckpoint = false; let hadPaidArtifacts = false;
  for (const run of runs) {
    if (run.id === currentId) continue;
    if (!trustedRun(run, repo, workflow)) {
      if (run.status !== 'completed') outstanding.push(run.id);
      if (run.status !== 'completed' || time(run.updated_at) + DAY + 2 * HOUR + MARGIN > now) entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR });
      continue;
    }
    if (checkpoint && time(run.updated_at) + DAY + 2 * HOUR + MARGIN < now && !checkpoint.value.pendingRuns?.includes(run.id) && !checkpoint.value.flights?.some(flight => flight.runId === run.id)) continue;
    const artifacts = await api.pages(`/repos/${OWN}/actions/runs/${run.id}/artifacts`, 'artifacts');
    const cp = singleton(artifacts, `annie-checkpoint-${run.id}-1`);
    if (cp) hadCheckpoint = true;
    let decision = null;
    if (cp && !cp.expired) {
      const value = await api.artifact(cp, 'checkpoint.json');
      const keys = ['schema', 'runId', 'repoId', 'handled', 'slots', 'paid', 'queue', 'pendingRuns', 'lastMaintenance', 'upstream', 'inputBase', 'flights', 'outcomes', 'environment', 'receipts', 'blocked', 'republish', 'providers', 'providerHolds', 'incidents', 'rejections'];
      if (!value || Object.keys(value).some(key => !keys.includes(key)) || ['queue', 'lastMaintenance'].some(key => value[key] !== undefined && !/^[a-f0-9]{64}$/.test(value[key])) || ['upstream', 'inputBase'].some(key => value[key] !== undefined && !isSha(value[key])) || value.paid !== undefined && typeof value.paid !== 'boolean') fail('malformed decision checkpoint fields');
      if (value.pendingRuns !== undefined && (!Array.isArray(value.pendingRuns) || value.pendingRuns.length > 20 || value.pendingRuns.some(id => !integer(id)))) fail('malformed pending checkpoint');
      if (value.schema !== 1 || value.runId !== run.id || value.repoId !== repo.id || !Array.isArray(value.handled) || value.handled.length > 200 || value.handled.some(v => !/^[a-f0-9]{64}$/.test(v)) || !Array.isArray(value.slots) || value.slots.length > 32 || value.slots.some(v => !/^\d{4}-\d{2}-\d{2}$/.test(v))) fail('malformed decision checkpoint');
      if (value.flights !== undefined && (!Array.isArray(value.flights) || value.flights.length > 20 || value.flights.some(f => !integer(f.runId) || !/^[a-f0-9]{64}$/.test(f.queue) || !validateTask(f.task)))) fail('malformed flights');
      if (value.outcomes !== undefined && (!Array.isArray(value.outcomes) || value.outcomes.length > 200 || value.outcomes.some(o => !/^[a-f0-9]{64}$/.test(o.fingerprint) || !integer(o.runId) || !integer(o.attempts) || !Number.isFinite(o.nextAt) || !['environment', 'zero-dispatch', 'transient'].includes(o.kind)))) fail('malformed outcomes');
      if (value.environment != null && (!/^[a-f0-9]{64}$/.test(value.environment.signal) || !Number.isFinite(value.environment.nextAt))) fail('malformed environment cooldown');
      if (value.providers !== undefined && (!value.providers || Object.keys(value.providers).sort().join() !== 'available,signal' || !/^[a-f0-9]{64}$/.test(value.providers.signal) || !providerList(value.providers.available))) fail('malformed provider scope');
      if (value.providerHolds !== undefined) validateHolds(value.providerHolds);
      if (value.incidents !== undefined) validateIncidents(value.incidents);
      if (value.rejections !== undefined) validateRejections(value.rejections);
      if (value.blocked !== undefined && (!Array.isArray(value.blocked) || value.blocked.length > 20 || value.blocked.some(b => !integer(b.runId) || !['expired-candidate-identity', 'admission-unreconciled'].includes(b.reason)))) fail('malformed blocked receipts');
      if (value.republish !== undefined && (!Array.isArray(value.republish) || value.republish.length > 20 || value.republish.some(r => !r || Object.keys(r).sort().join(',') !== 'attempts,nextAt,runId' || !integer(r.runId) || !integer(r.attempts) || r.attempts > 3 || !Number.isFinite(r.nextAt)) || new Set(value.republish.map(r => r.runId)).size !== value.republish.length)) fail('malformed republish attempts');
      if (value.receipts !== undefined && (!Array.isArray(value.receipts) || value.receipts.length > 20 || value.receipts.some(r => !integer(r.runId) || r.runId !== r.lease?.runId))) fail('malformed pending receipts');
      decision = value;
      if (!checkpoint || time(cp.created_at) > checkpoint.at || time(cp.created_at) === checkpoint.at && value.runId > checkpoint.value.runId) {
        checkpoint = { at: time(cp.created_at), value };
        for (const id of new Set([...(value.pendingRuns ?? []), ...(value.flights ?? []).map(flight => flight.runId)])) if (id !== currentId && !runs.some(run => run.id === id)) {
          const carried = await api.get(`/repos/${OWN}/actions/runs/${id}`);
          if (carried.id !== id) fail('carried run identity mismatch');
          runs.push(carried);
        }
      }
    }
    const carriedBlocker = checkpoint?.value.blocked?.find(b => b.runId === run.id);
    if (carriedBlocker?.reason === 'expired-candidate-identity') { blockers.push(carriedBlocker); outstanding.push(run.id); entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR }); continue; }
    const receipt = checkpoint?.value.receipts?.find(r => r.runId === run.id);
    const leaseMeta = singleton(artifacts, `annie-lease-${run.id}-1`) ?? (receipt?.leaseMeta ? { ...receipt.leaseMeta, expired: true } : null), reportMeta = singleton(artifacts, `honest-annie-model-report-${run.id}-1`) ?? (receipt?.reportMeta ? { ...receipt.reportMeta, expired: true } : null);
    if (receipt?.candidate && !singleton(artifacts, `honest-annie-candidate-${run.id}-1`)) artifacts.push({ ...receipt.candidate, expired: true });
    const flight = checkpoint?.value.flights?.find(f => f.runId === run.id);
    if (flight && !leaseMeta && !reportMeta) {
      let jobs = [];
      if (run.status === 'completed') jobs = await api.pages(`/repos/${OWN}/actions/runs/${run.id}/attempts/1/jobs`, 'jobs');
      const skipped = run.status === 'completed' && provenZeroDispatch(run, jobs);
      const holdUntil = Math.max(time(run.updated_at), time(run.created_at) + 2 * HOUR) + DAY + MARGIN;
      if (skipped && now >= holdUntil) {
        const environmentFailure = jobs.some(job => job.name === 'maintain' && job.steps?.some(step => step.conclusion === 'failure' && /preflight|Podman|npm ci|container tools|prepaid|provider|key configuration/i.test(step.name)));
        records.push({ run, zeroDispatch: true, environmentFailure, task: flight.task, artifacts });
      } else {
        if (!skipped) blockers.push({ runId: run.id, reason: 'admission-unreconciled' });
        if (run.status !== 'completed') outstanding.push(run.id);
        entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR });
      }
      continue;
    }
    if (carriedBlocker) { blockers.push(carriedBlocker); outstanding.push(run.id); entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR }); continue; }
    if (run.status === 'completed') {
      const jobs = await api.pages(`/repos/${OWN}/actions/runs/${run.id}/attempts/1/jobs`, 'jobs');
      if (provenZeroDispatch(run, jobs)) {
        const environmentFailure = jobs.some(job => job.name === 'maintain' && job.steps?.some(step => step.conclusion === 'failure' && /preflight|Podman|npm ci|container tools|prepaid|provider|key configuration/i.test(step.name)));
        records.push({ run, zeroDispatch: true, environmentFailure, task: checkpoint?.value.flights?.find(f => f.runId === run.id)?.task, artifacts }); continue;
      }
    }
    if (leaseMeta || reportMeta) hadPaidArtifacts = true;
    let lease = null, settlement = null;
    if (leaseMeta?.expired && time(run.updated_at) + DAY + 2 * HOUR + MARGIN < now && !checkpoint?.value.pendingRuns?.includes(run.id)) continue;
    if (leaseMeta?.expired && !receipt) {
      entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR });
      if (run.status !== 'completed') outstanding.push(run.id);
      if (singleton(artifacts, `honest-annie-candidate-${run.id}-1`)) { blockers.push({ runId: run.id, reason: 'expired-candidate-identity' }); outstanding.push(run.id); }
      continue;
    }
    if (leaseMeta) {
      lease = leaseMeta.expired && receipt ? receipt.lease : await api.artifact(leaseMeta, 'lease.json');
      verifyLease(lease, { env: { GITHUB_RUN_ID: String(run.id), GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: run.head_sha, GITHUB_REPOSITORY_ID: String(repo.id) }, task: lease.task });
      if (lease.workflowId !== workflow.id || lease.createdAt !== run.created_at || lease.event !== run.event || time(leaseMeta.created_at) < time(run.created_at) || time(leaseMeta.created_at) > lease.deadline) fail('lease provenance mismatch');
      if (reportMeta) {
        settlement = reportMeta.expired && receipt ? receipt.settlement : await api.artifact(reportMeta, 'report.json');
        if (!settlement && receipt) settlement = { ledgerReservation: null, fingerprint: null, reportedUsage: { status: 'unknown' } };
        if (noCompletionEvidence(settlement)) settlement = null;
        else {
          if (settlement.ledgerReservation !== lease.hash || settlement.fingerprint !== lease.task.fingerprint || time(reportMeta.created_at) < time(leaseMeta.created_at)) fail('settlement provenance mismatch');
          if (settlement.taskKind !== lease.task.kind || settlement.day !== lease.task.day || settlement.base !== lease.task.base || typeof settlement.managementApproved !== 'boolean' || !['admitted', 'executing', 'reviewing', 'gating', 'committing', 'publishing', 'published', 'rejected', 'failed', 'managing'].includes(settlement.phase) || settlement.commit !== null && !isSha(settlement.commit) || settlement.releaseCommit !== null && !isSha(settlement.releaseCommit) || Boolean(settlement.commit) !== Boolean(settlement.releaseCommit) || !['known', 'unknown'].includes(settlement.reportedUsage?.status) || settlement.usageComplete !== null && typeof settlement.usageComplete !== 'boolean' || settlement.reportedUsage.status === 'known' && (!Number.isFinite(settlement.reportedUsage.cost) || settlement.reportedUsage.cost < 0)) fail('malformed settlement schema');
          if (settlement.sourceIdentity && ['base', 'commit', 'releaseCommit'].some(key => settlement[key] !== settlement.sourceIdentity[key])) fail('inconsistent settlement source identity');
          if (settlement.providers !== undefined && !providerList(settlement.providers) || settlement.providerFailures !== undefined && !failureList(settlement.providerFailures)) fail('malformed settlement provider evidence');
          if (settlement.changedFiles != null && !validChanged(settlement.changedFiles) || settlement.blockingFindings !== undefined && !validFindings(settlement.blockingFindings, 10)) fail('malformed settlement rejection evidence');
        }
      }
      if (run.run_attempt > 1) {
        const jobs = await api.pages(`/repos/${OWN}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
        const paidRerun = jobs.some(job => job.name === 'maintain' && job.conclusion !== 'skipped');
        if (paidRerun) entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR });
      }
      entries.push({ lease, settlement, settledAt: reportMeta?.created_at, terminal: run.status === 'completed' });
      records.push({ run, lease, settlement, artifacts, leaseMeta, reportMeta });
    } else if (reportMeta || decision?.paid === true || !decision && (run.status !== 'completed' || time(run.updated_at) + DAY + 2 * HOUR + MARGIN > now)) {
      // Legacy, missing, deleted, or unfamiliar executions cannot silently refund spend.
      if (run.status !== 'completed') outstanding.push(run.id);
      entries.push({ unknown: true, terminal: run.status === 'completed', updatedAt: run.updated_at, deadline: time(run.created_at) + 2 * HOUR });
    }
  }
  return { allowance: rollingAllowance(entries, now), checkpoint, records, runs, outstanding, blockers, hadCheckpoint, hadPaidArtifacts };
}
export function chooseTask({ prs, base, upstreamSha, upstreamRef, policy, day, checkpoint, usefulUpstream = false, queueChanged = false, daily = false, repairs = [] }) {
  const handled = new Set(checkpoint.handled), common = { day, repo: OWN, ref: REF, base, upstreamSha, upstreamRef };
  // Broken machinery wastes every other batch: an admissible harness repair (repairDecision) goes first.
  for (const { incident, attempt } of repairs) {
    const fingerprint = harnessFingerprint(incident, policy, attempt);
    if (!handled.has(fingerprint)) return validateTask({ ...common, kind: 'harness', incident, fingerprint });
  }
  for (const pr of prs) {
    const fingerprint = prFingerprint({ number: pr.number, head: pr.head.sha, base, policy });
    if (!handled.has(fingerprint)) return validateTask({ ...common, kind: 'pr', number: pr.number, head: pr.head.sha, author: pr.user.login, fingerprint });
  }
  const kind = queueChanged && !usefulUpstream && !daily ? 'management' : 'maintenance';
  const fingerprint = digest({ kind, base, upstreamSha, policy, queue: checkpoint.queue, ...(daily ? { day } : {}) });
  if ((usefulUpstream || queueChanged || daily) && !handled.has(fingerprint)) return validateTask({ ...common, kind, fingerprint });
  return null;
}
const REGISTRY = 'https://registry.bugabinga.net/v2/pufferpanel', MANIFEST = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
// Anonymous publish.sh-equivalent read: manifest, config blob, OCI revision/version labels; null only on HTTP 404.
export async function registryImage(fetchImpl, tag) {
  const read = (path, accept) => fetchImpl(`${REGISTRY}/${path}`, { redirect: 'error', headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(10000) });
  const manifest = await read(`manifests/${tag}`, MANIFEST);
  if (manifest.status === 404) return null;
  const config = manifest.ok ? (await manifest.json())?.config?.digest : null;
  if (!/^sha256:[a-f0-9]{64}$/.test(config ?? '')) fail('registry manifest unknown');
  const blob = await read(`blobs/${config}`);
  const labels = blob.ok ? (await blob.json())?.config?.Labels : null;
  if (!labels || typeof labels !== 'object') fail('registry config unknown');
  return { revision: labels['org.opencontainers.image.revision'] ?? null, version: labels['org.opencontainers.image.version'] ?? null };
}
const newer = (a, b) => { const [x, y] = [a, b].map(v => /^\d+\.\d+\.\d+$/.test(v ?? '') ? v.split('.').map(Number) : null); return Boolean(x && y) && (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0; };
export async function publicationAvailable(fetchImpl, day) {
  const version = versionFor(day);
  const res = await fetchImpl(`${REGISTRY}/manifests/${version}`, { method: 'HEAD', redirect: 'error', headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return true;
  if (res.ok) return false;
  fail('anonymous publication availability unknown');
}
// Untrusted repair input fetched read-only by trusted observe: failing jobs/steps, two redacted log tails, sanitized report fields.
async function harnessDigest(api, incident, records) {
  const runs = [], settled = value => ['success', 'skipped', null, undefined].includes(value); let logs = 0;
  for (const runId of incident.runs.slice(0, 3)) {
    try {
      const jobs = (await api.pages(`/repos/${OWN}/actions/runs/${runId}/jobs`, 'jobs')).filter(job => !settled(job.conclusion)).slice(0, 10);
      for (const job of jobs) {
        job.steps = (job.steps ?? []).filter(step => !settled(step.conclusion));
        if (logs < 2 && integer(job.id)) { logs++; job.log = await api.jobLog(job.id).catch(error => `log unavailable: ${error.message}`); }
      }
      runs.push({ runId, jobs });
    } catch (error) { runs.push({ runId, error: error.message }); }
  }
  return makeDigest(incident, runs, records.find(record => incident.runs.includes(record.run.id) && record.settlement)?.settlement ?? null);
}
const outputs = env => async (name, value) => { if (env.GITHUB_OUTPUT) await writeFile(env.GITHUB_OUTPUT, `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`, { flag: 'a' }); };
export async function controller({ env = process.env, fetchImpl = fetch, now = Date.now(), delays } = {}) {
  const mode = env.ANNIE_MODE ?? 'check';
  if (mode === 'check') return { state: 'offline-unpaid' }; // No reads, observations, leases, retries, or effects.
  if (!['observe', 'sweep', 'maintain'].includes(mode) || env.GITHUB_REPOSITORY !== OWN || env.GITHUB_REF !== REF) fail('untrusted controller invocation');
  const api = new GitHub(env.GH_TOKEN, fetchImpl, delays), repo = await api.get(`/repos/${OWN}`);
  if (repo.id !== Number(env.GITHUB_REPOSITORY_ID) || repo.default_branch !== 'trunk') fail('repository identity mismatch');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (env.GITHUB_EVENT_NAME === 'workflow_run') await verifyWake(api, event, repo);
  const workflow = await api.get(`/repos/${OWN}/actions/workflows/honest-annie.yml`);
  if (workflow.path !== POLICY_PATH) fail('workflow identity mismatch');
  const run = await api.get(`/repos/${OWN}/actions/runs/${env.GITHUB_RUN_ID}`);
  if (!trustedRun(run, repo, workflow) || run.head_sha !== env.GITHUB_SHA) fail('untrusted controller run');
  const ledger = await observeLedger(api, repo, workflow, now, run.id);
  const checkpoint = ledger.checkpoint?.value ?? (env.ANNIE_BOOTSTRAP === env.GITHUB_RUN_ID && !ledger.hadCheckpoint && !ledger.hadPaidArtifacts ? { schema: 1, handled: [], slots: [] } : fail('decision checkpoint missing: explicit bootstrap or recovery required'));
  const [branch, upstream, prs, issues] = await Promise.all([
    api.get(`/repos/${OWN}/branches/trunk`), api.get('/repos/pufferpanel/pufferpanel'), api.pages(`/repos/${OWN}/pulls?state=open`), repo.has_issues ? api.pages(`/repos/${OWN}/issues?state=open`) : [],
  ]);
  if (prs.length > 198) fail('current PR decision checkpoint capacity exceeded');
  const upstreamRef = `refs/heads/${upstream.default_branch}`;
  const pin = await api.get(`/repos/pufferpanel/pufferpanel/git/ref/heads/${encodeURIComponent(upstream.default_branch)}`);
  if (!isSha(branch.commit?.sha) || !isSha(pin.object?.sha)) fail('source pins unavailable');
  const read = path => api.get(`/repos/${OWN}${path}`);
  const policy = digest(await protectedPolicy(read, run.head_sha));
  if (branch.commit.sha !== run.head_sha && digest(await protectedPolicy(read, branch.commit.sha)) !== policy) fail('trunk policy moved since trusted checkout');
  const day = new Date(now).toISOString().slice(0, 10);
  const queue = digest(issues.filter(i => !i.pull_request && i.user?.type !== 'Bot' && i.user?.login !== 'honest_annie').map(i => ({ number: i.number, title: i.title, bodyHash: digest(i.body ?? ''), state: i.state })).sort((a,b) => a.number-b.number));
  const queueChanged = checkpoint.queue !== undefined && checkpoint.queue !== queue;
  const eligible = [];
  for (const pr of prs) {
    // Never self-integrate: harness repair branches are Oliver's to merge; checkPR refuses them and protected files again.
    if (pr.draft || pr.user?.type === 'Bot' || String(pr.head?.ref ?? '').startsWith(HARNESS_BRANCH_PREFIX)) continue;
    const task = { kind: 'pr', day, repo: OWN, ref: REF, base: branch.commit.sha, upstreamSha: pin.object.sha, upstreamRef, number: pr.number, head: pr.head?.sha, author: pr.user?.login, fingerprint: prFingerprint({ number: pr.number, head: pr.head?.sha, base: branch.commit.sha, policy }) };
    try { validateTask(task); await checkPR(task, { fetchImpl, token: env.GH_TOKEN }); eligible.push(pr); } catch { /* Waiting/foreign PRs are visible but never paid. */ }
  }
  for (const record of ledger.records) record.effectIdentity = record.settlement ?? (!record.zeroDispatch && record.lease.task.kind === 'pr' && singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`) ? { commit: record.lease.task.head, releaseCommit: record.lease.task.head, managementApproved: false, phase: 'publishing' } : null);
  const active = ledger.records.filter(r => (r.effectIdentity?.commit || r.effectIdentity?.managementApproved) && !['failed', 'rejected'].includes(r.effectIdentity.phase));
  const waiting = ledger.records.filter(record => !record.zeroDispatch && !record.effectIdentity && singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`));
  const superseded = [], republishable = [], held = [], abandoned = [];
  for (const record of active) {
    const reports = record.artifacts.filter(a => a.name.startsWith(`honest-annie-release-report-${record.run.id}-`));
    let released = false;
    for (const meta of reports) {
      if (meta.expired) continue; // Refreshed pending receipt survives retention, never invents completion.
      const report = await api.artifact(meta, 'report.json');
      if (noCompletionEvidence(report)) continue;
      if (report.fingerprint !== record.lease.task.fingerprint || report.ledgerReservation !== record.lease.hash || ['base', 'day'].some(key => report[key] != null && report[key] !== record.lease.task[key]) || report.releaseCommit != null && report.releaseCommit !== record.effectIdentity.releaseCommit) fail('release report identity mismatch');
      // Management receipts are best-effort; they never gate release or the queue.
      // Harness candidates are delivered as a PR, never released: any completed effects report is terminal.
      if (!record.effectIdentity.commit || record.lease.task.kind === 'harness' || /^sha256:[a-f0-9]{64}$/.test(report.publicationDigest ?? '') && report.sourcePersisted === true && report.releaseCommit === record.effectIdentity.releaseCommit) released = true;
    }
    if (released) continue;
    if (record.lease.task.kind === 'harness') { waiting.push(record); continue; }
    const source = record.effectIdentity.releaseCommit;
    let onTrunk = source === branch.commit.sha, unknown = false;
    if (source && !onTrunk && record.lease.task.base !== branch.commit.sha) {
      try { const { status } = await api.get(`/repos/${OWN}/compare/${source}...${branch.commit.sha}`); onTrunk = ['ahead', 'identical'].includes(status); unknown = !['ahead', 'behind', 'identical', 'diverged'].includes(status); }
      catch (error) { unknown = !/http-404$/.test(error.message); } // GitHub does not know never-pushed source.
    }
    const entry = checkpoint.republish?.find(r => r.runId === record.run.id) ?? null;
    if (unknown) { held.push({ runId: record.run.id, source, reason: 'compare-unknown', entry }); continue; }
    if (onTrunk) {
      // Persisted source never blocks: registry evidence decides released, superseded, or model-free republish.
      const version = versionFor(record.lease.task.day);
      try {
        const image = await registryImage(fetchImpl, version);
        const latest = await registryImage(fetchImpl, 'latest'), higher = Boolean(latest) && newer(latest.version, version);
        // Released only once latest was promoted too; a version-only push resumes through publish.sh's idempotent path.
        if (image?.revision === source && latest && !newer(version, latest.version)) continue;
        if (image?.revision !== source && (image || higher)) { superseded.push({ runId: record.run.id, source, reason: higher ? 'newer-latest' : 'version-collision' }); continue; }
      } catch { held.push({ runId: record.run.id, source, reason: 'registry-unknown', entry }); continue; }
      if (entry?.attempts >= 3) abandoned.push({ runId: record.run.id, source, reason: 'republish-exhausted', entry });
      else republishable.push({ record, source, version, entry });
      continue;
    }
    let compatible = record.lease.task.base === branch.commit.sha;
    if (!compatible && record.lease.task.kind === 'pr') {
      try {
        const [sinceBase, untilHead] = await Promise.all([api.get(`/repos/${OWN}/compare/${record.lease.task.base}...${branch.commit.sha}`), api.get(`/repos/${OWN}/compare/${branch.commit.sha}...${record.effectIdentity.releaseCommit}`)]);
        compatible = ['ahead', 'identical'].includes(sinceBase.status) && ['ahead', 'identical'].includes(untilHead.status);
        if (![sinceBase.status, untilHead.status].every(status => ['ahead', 'behind', 'identical', 'diverged'].includes(status))) compatible = true;
      } catch { compatible = true; } // Unknown ancestry never authorizes buying replacement work.
    }
    if (compatible) waiting.push(record);
    else superseded.push({ runId: record.run.id, source: source ?? null, reason: 'trunk-advanced' });
  }
  // Unpersisted work cannot block forever; its fingerprint stays unhandled so a later batch may redo it.
  const pending = waiting.filter(record => {
    const candidate = singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`);
    const reason = record.run.status !== 'completed' ? null : !candidate ? 'candidate-missing' : candidate.expired ? 'candidate-expired' : record.run.run_attempt >= 3 ? 'effects-retry-exhausted' : null;
    if (reason) abandoned.push({ runId: record.run.id, source: record.effectIdentity?.releaseCommit ?? null, reason });
    return !reason;
  });
  const fresh = { ...checkpoint, schema: 1, runId: run.id, repoId: repo.id, queue: checkpoint.queue ?? queue, paid: false, pendingRuns: [...new Set([...ledger.outstanding, ...pending.map(record => record.run.id), ...republishable.map(r => r.record.run.id), ...held.map(r => r.runId), ...ledger.records.filter(r => !r.zeroDispatch && (r.run.status !== 'completed' || !r.settlement && r.lease.deadline + DAY + MARGIN > now)).map(r => r.run.id)])] };
  fresh.blocked = ledger.blockers;
  if (fresh.pendingRuns.length > 20) fail('outstanding execution capacity exceeded');
  // Retain only current PR fingerprints plus last maintenance metadata; healthy sweeps refresh retention.
  const current = new Set(prs.map(pr => prFingerprint({ number: pr.number, head: pr.head?.sha, base: branch.commit.sha, policy })));
  const repairTasks = new Set((checkpoint.incidents ?? []).flatMap(incident => incident.repair?.tasks ?? []));
  fresh.handled = checkpoint.handled.filter(value => current.has(value) || value === checkpoint.lastMaintenance || repairTasks.has(value)).slice(-199);
  fresh.flights = (checkpoint.flights ?? []).filter(f => !ledger.records.some(r => r.run.id === f.runId && (r.zeroDispatch || r.run.status === 'completed')));
  fresh.outcomes = [...checkpoint.outcomes ?? []];
  const configSignal = digest({ policy, enabled: env.HONEST_ANNIE_ENABLED, repair: env.ANNIE_CONFIG_REVISION ?? '' });
  fresh.environment = checkpoint.environment?.signal === configSignal ? checkpoint.environment : null;
  // Provider holds: quota/auth failures from model reports settled since the previous checkpoint, until the stated reset or 24h.
  // A changed config signal (policy, enablement, ANNIE_CONFIG_REVISION) drops every hold and the known provider set.
  const sameProviders = !checkpoint.providers || checkpoint.providers.signal === configSignal;
  fresh.providers = sameProviders && checkpoint.providers ? checkpoint.providers : { signal: configSignal, available: [] };
  const holds = new Map((sameProviders ? checkpoint.providerHolds ?? [] : []).map(hold => [hold.provider, hold]));
  if (sameProviders) for (const record of ledger.records.filter(r => r.settlement && r.run.id >= (checkpoint.runId ?? 0)).sort((a, b) => a.run.id - b.run.id)) {
    if (record.settlement.providers?.length) fresh.providers = { signal: configSignal, available: record.settlement.providers };
    for (const failure of record.settlement.providerFailures ?? []) {
      const until = failure.resetAt ? Date.parse(failure.resetAt) : Date.parse(failure.observedAt) + DAY;
      if (failure.kind !== 'transient' && !(holds.get(failure.provider)?.until >= until)) holds.set(failure.provider, { provider: failure.provider, until, reason: failure.kind });
    }
  }
  fresh.providerHolds = [...holds.values()].filter(hold => hold.until > now).slice(0, 64);
  fresh.rejections = foldRejections(checkpoint.rejections ?? [], ledger.records, now);
  const heldProviders = new Set(fresh.providerHolds.map(hold => hold.provider));
  const providersHeld = fresh.providers.available.length > 0 && fresh.providers.available.every(provider => heldProviders.has(provider));
  const holdsExpireAt = providersHeld ? new Date(Math.min(...fresh.providerHolds.filter(hold => fresh.providers.available.includes(hold.provider)).map(hold => hold.until))).toISOString() : null;
  for (const record of ledger.records) {
    const selected = record.lease?.task ?? record.task;
    if (!selected || record.run.status !== 'completed') continue;
    const result = record.settlement;
    // A harness repair is admitted once per incident and policy: any settled outcome except an environment failure ends it.
    const terminal = result && (selected.kind === 'pr' && ['unsupported-history', 'protected-history', 'non-descendant'].includes(result.sourceRejection) || result.phase === 'published' || result.managementApproved || result.phase === 'rejected' && result.reason === 'review-rejected' || selected.kind === 'harness' && ['publishing', 'rejected', 'failed'].includes(result.phase) && result.modelFailure !== 'environment');
    if (terminal) {
      if (!fresh.handled.includes(selected.fingerprint)) fresh.handled.push(selected.fingerprint);
      if (['maintenance', 'management'].includes(selected.kind)) { fresh.lastMaintenance = selected.fingerprint; fresh.upstream = selected.upstreamSha; fresh.inputBase = selected.base; fresh.queue = checkpoint.flights?.find(f => f.runId === record.run.id)?.queue ?? fresh.queue; }
    } else {
      const existing = fresh.outcomes.find(o => o.fingerprint === selected.fingerprint);
      if (existing?.runId >= record.run.id) continue;
      // modelFailure carries pi-ai's retry classification; failed preparation steps are environmental too.
      // Provider-attributed quota/auth failures become provider holds instead of the shared cooldown.
      const environment = result?.modelFailure === 'environment' && !result.providerFailures?.some(failure => failure.kind !== 'transient') || record.environmentFailure;
      const outcome = { fingerprint: selected.fingerprint, runId: record.run.id, attempts: (existing?.attempts ?? 0) + 1, nextAt: time(record.run.updated_at) + (environment ? DAY : HOUR), kind: environment ? 'environment' : record.zeroDispatch ? 'zero-dispatch' : 'transient' };
      fresh.outcomes = fresh.outcomes.filter(o => o.fingerprint !== selected.fingerprint); fresh.outcomes.push(outcome);
      if (environment) fresh.environment = { signal: configSignal, nextAt: outcome.nextAt };
    }
  }
  fresh.outcomes = fresh.outcomes.slice(-200);
  fresh.receipts = ledger.records.filter(record => fresh.pendingRuns.includes(record.run.id) && record.lease).map(record => ({ runId: record.run.id, lease: record.lease, leaseMeta: record.leaseMeta, reportMeta: record.reportMeta ?? null, candidate: singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`) ?? null, settlement: record.settlement ? Object.fromEntries(['ledgerReservation', 'fingerprint', 'taskKind', 'day', 'base', 'managementApproved', 'phase', 'commit', 'releaseCommit', 'usageComplete', 'reportedUsage'].map(key => [key, record.settlement[key]])) : null }));
  // Harness repairs never hold a calendar image slot.
  const noSourceDays = new Set(ledger.records.filter(record => record.run.status === 'completed' && record.settlement && !record.settlement.commit && !['management', 'harness'].includes(record.lease.task.kind)).map(record => record.lease.task.day));
  const reservedSourceDays = new Set(ledger.records.filter(record => !record.zeroDispatch && record.lease.task.kind !== 'harness' && (record.settlement?.commit || !record.settlement)).map(record => record.lease.task.day));
  const zeroDays = new Set(ledger.records.filter(r => r.zeroDispatch && r.task && r.task.kind !== 'harness').map(r => r.task.day));
  fresh.slots = checkpoint.slots.filter(value => value >= new Date(now - 31 * DAY).toISOString().slice(0, 10) && ((!noSourceDays.has(value) && !zeroDays.has(value)) || reservedSourceDays.has(value)));
  const ownAcknowledged = ledger.records.some(record => record.settlement?.releaseCommit === branch.commit.sha && record.lease?.task.kind !== 'harness');
  // Incidents: trusted model-free evidence this observation already holds, plus failed jobs of trusted runs within 24h.
  const jobs = [];
  for (const failedRun of ledger.runs.filter(r => r.id !== run.id && trustedRun(r, repo, workflow) && r.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion) && time(r.updated_at) > now - DAY).slice(0, 30)) jobs.push({ runId: failedRun.id, conclusion: failedRun.conclusion, jobs: await api.pages(`/repos/${OWN}/actions/runs/${failedRun.id}/jobs`, 'jobs') });
  const heldUntil = providersHeld ? holdsExpireAt : null;
  fresh.incidents = foldIncidents(checkpoint.incidents ?? [], detectIncidents({
    now, abandoned, held, blockers: ledger.blockers, jobs,
    stuck: ledger.runs.filter(r => r.id !== run.id && trustedRun(r, repo, workflow) && r.status !== 'completed' && time(r.created_at) < now - 6 * HOUR),
    environment: fresh.environment ? { ...fresh.environment, runs: fresh.outcomes.filter(o => o.kind === 'environment').map(o => o.runId) } : null,
    providersHeld: providersHeld ? { providers: fresh.providers.available, until: heldUntil } : null,
    reports: ledger.records.filter(r => r.settlement && r.lease).map(r => ({ runId: r.run.id, taskKind: r.lease.task.kind, report: r.settlement })),
  }), now);
  // Harness repair admission: one open proposal per incident and bounded retries (repairDecision); unknown PR state admits none.
  const createdAt = id => { const found = ledger.runs.find(r => r.id === id); return found ? time(found.created_at) : now; };
  const attempts = [...ledger.records.filter(r => !r.zeroDispatch && r.lease?.task.kind === 'harness').map(r => ({ incident: r.lease.task.incident, task: r.lease.task.fingerprint, runId: r.run.id, at: time(r.run.created_at), running: r.run.status !== 'completed' || pending.includes(r) })),
    ...fresh.flights.filter(f => f.task.kind === 'harness').map(f => ({ incident: f.task.incident, task: f.task.fingerprint, runId: f.runId, at: createdAt(f.runId), running: true }))];
  for (const incident of fresh.incidents) { const repair = foldRepair(incident.repair, attempts.filter(a => a.incident === incident.fingerprint)); if (repair) incident.repair = repair; }
  const known = new Map([...fresh.incidents.flatMap(incident => (incident.repair?.tasks ?? []).map(fp => [harnessBranch(fp), incident.fingerprint])), ...attempts.map(a => [harnessBranch(a.task), a.incident])]);
  const { open: openPRs, unknown: unattributed } = openRepairs(prs, known);
  for (const incident of fresh.incidents) { delete incident.pr; if (incident.status === 'open' && openPRs.has(incident.fingerprint)) incident.pr = openPRs.get(incident.fingerprint); }
  let repairs = [], lookupFailed = false; const waits = [];
  for (const incident of fresh.incidents.filter(entry => ready(entry) && REPAIRABLE.has(entry.kind))) {
    const running = attempts.some(a => a.incident === incident.fingerprint && a.running), repair = incident.repair;
    let last = null;
    if (repair && !running && !incident.pr && repair.tasks.length < MAX_REPAIRS) {
      const branchName = harnessBranch(repair.last);
      try {
        const found = (await api.pages(`/repos/${OWN}/pulls?state=all&head=${encodeURIComponent(`${OWN.split('/')[0]}:${branchName}`)}`)).find(pr => pr?.head?.ref === branchName);
        last = !found ? { state: 'none' } : found.state === 'open' ? { state: 'open', number: found.number } : found.merged_at ? { state: 'merged', number: found.number, at: time(found.merged_at) } : { state: 'closed', number: found.number };
      } catch { lookupFailed = true; waits.push({ incident: incident.fingerprint, reason: 'harness-pr-lookup-unknown' }); continue; }
    }
    const evidenceAt = Math.max(0, ...incident.runs.map(id => ledger.runs.find(r => r.id === id)).filter(Boolean).map(r => time(r.created_at)));
    const decision = repairDecision({ entry: incident, running, last, policy, now, evidenceAt });
    if (decision.admit) repairs.push({ incident: incident.fingerprint, attempt: decision.attempt });
    else waits.push({ incident: incident.fingerprint, reason: decision.reason, ...(decision.pr ? { pr: decision.pr } : {}) });
  }
  // Fail closed: an open harness PR nobody can attribute, or an unknown PR lookup, admits no harness repair at all.
  if (unattributed.length || lookupFailed) { if (unattributed.length) waits.push({ incident: null, reason: `unattributed open harness PR #${unattributed.join(', #')}` }); repairs = []; }
  const humanSourceChanged = checkpoint.inputBase !== undefined && checkpoint.inputBase !== branch.commit.sha && !ownAcknowledged;
  const task = chooseTask({ prs: eligible, base: branch.commit.sha, upstreamSha: pin.object.sha, upstreamRef, policy, day, checkpoint: { ...fresh, handled: [...fresh.handled, ...fresh.flights.map(f => f.task.fingerprint), ...fresh.outcomes.filter(o => (o.kind !== 'environment' || checkpoint.environment?.signal === configSignal) && (o.attempts >= 3 || o.nextAt > now)).map(o => o.fingerprint)], queue }, usefulUpstream: humanSourceChanged || checkpoint.upstream !== undefined && checkpoint.upstream !== pin.object.sha, queueChanged, daily: env.GITHUB_EVENT_NAME === 'schedule' && event.schedule === '17 4 * * *', repairs });
  fresh.upstream ??= pin.object.sha;
  fresh.inputBase = ownAcknowledged || fresh.inputBase === undefined ? branch.commit.sha : fresh.inputBase;
  // Model-free republish of persisted source: attempt-1 maintain only, 30-minute cooldown, at most three attempts.
  fresh.republish = [...republishable, ...held, ...abandoned].map(r => r.entry).filter(Boolean);
  const next = mode === 'maintain' && env.HONEST_ANNIE_ENABLED === 'true' && env.GITHUB_RUN_ATTEMPT === '1' ? republishable.find(r => !(r.entry?.nextAt > now)) : null;
  const republish = next ? { runId: next.record.run.id, releaseCommit: next.source, version: next.version, day: next.record.lease.task.day } : null;
  if (next) fresh.republish = [...fresh.republish.filter(r => r.runId !== republish.runId), { runId: republish.runId, attempts: (next.entry?.attempts ?? 0) + 1, nextAt: now + 30 * 60_000 }];
  fresh.republish = fresh.republish.slice(-20);
  let state = republish ? 'republishing' : pending.length || ledger.blockers.length ? 'effects-pending' : task ? 'useful-input' : 'no-op';
  let lease = null;
  if (mode === 'maintain' && task && !republish && !pending.length && !ledger.blockers.length && !(fresh.environment?.nextAt > now) && env.HONEST_ANNIE_ENABLED === 'true' && env.GITHUB_RUN_ATTEMPT === '1' && ledger.allowance > 0) {
    if (providersHeld) state = 'providers-held';
    else if (['maintenance', 'pr'].includes(task.kind) && (fresh.slots.includes(day) || branch.protected !== false || !await publicationAvailable(fetchImpl, day))) state = 'source-slot-unavailable';
    else {
      const rules = await api.pages(`/repos/${OWN}/rules/branches/trunk`);
      if (rules.length) state = 'protected-policy';
      else {
        lease = makeLease({ run, repoId: repo.id, workflowId: workflow.id, task, cap: task.kind === 'harness' ? Math.min(ledger.allowance, HARNESS_CAP) : ledger.allowance, now });
        fresh.paid = true;
        fresh.flights.push({ runId: run.id, task, queue });
        if (['maintenance', 'pr'].includes(task.kind)) fresh.slots.push(day);
        if (task.kind === 'harness') { const incident = fresh.incidents.find(entry => entry.fingerprint === task.incident); incident.repair = { tasks: [...(incident.repair?.tasks ?? []), task.fingerprint].slice(-5), last: task.fingerprint, runId: run.id, at: now, policy }; }
        state = 'admitted';
      }
    }
  }
  const dir = resolve(env.ANNIE_OUTPUT_DIR ?? fail('ANNIE_OUTPUT_DIR required'));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'checkpoint.json'), JSON.stringify(fresh));
  if (lease) await writeFile(join(dir, 'lease.json'), JSON.stringify(lease));
  let retry = null;
  if (mode === 'maintain' && env.HONEST_ANNIE_ENABLED === 'true' && pending.length) {
    const record = pending[0];
    if (record.run.run_attempt < 3 && now - time(record.run.updated_at) >= 30 * 60_000 && record.run.status === 'completed' && singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`)) {
      for (let attempt = record.run.run_attempt; attempt >= 1 && !retry; attempt--) {
        const jobs = await api.pages(`/repos/${OWN}/actions/runs/${record.run.id}/attempts/${attempt}/jobs`, 'jobs');
        const job = jobs.find(job => job.name === 'Annie effects (model-free)' && ['failure', 'cancelled', 'timed_out'].includes(job.conclusion));
        const candidate = singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`);
        const producerJobs = !record.settlement && job ? (attempt === 1 ? jobs : await api.pages(`/repos/${OWN}/actions/runs/${record.run.id}/attempts/1/jobs`, 'jobs')) : [];
        const approvedProducer = record.settlement || producerJobs.some(producer => producer.name === 'maintain' && producer.steps?.some(step => step.name === 'Export only approved candidates or valid rejection feedback' && step.conclusion === 'success'));
        if (job && candidate && !candidate.expired && approvedProducer) retry = { runId: record.run.id, jobId: job.id, originalSha: record.run.head_sha, attempt: record.run.run_attempt, jobAttempt: attempt };
      }
    }
  }
  const output = outputs(env);
  await output('retry', retry ? JSON.stringify(retry) : ''); await output('republish', republish ? JSON.stringify(republish) : '');
  await output('paid', Boolean(lease)); await output('task', lease ? JSON.stringify(task) : ''); await output('lease', lease ? JSON.stringify(lease) : ''); await output('state', state); await output('holds', JSON.stringify(fresh.providerHolds)); await output('rejections', JSON.stringify(fresh.rejections));
  const issueWork = syncable(fresh.incidents), repairing = lease && task.kind === 'harness' ? fresh.incidents.find(incident => incident.fingerprint === task.incident) : null;
  await output('incidents', issueWork.length ? JSON.stringify(issueWork) : ''); await output('incident', repairing ? JSON.stringify(await harnessDigest(api, repairing, ledger.records)) : '');
  const summary = { state, mode, providerHolds: fresh.providerHolds.map(hold => ({ ...hold, until: new Date(hold.until).toISOString() })), holdsExpireAt, effectsRetry: retry, observationBlockers: ledger.blockers, allowance: ledger.allowance, readyPRs: eligible.length, pendingEffects: pending.map(r => ({ runId: r.run.id, source: r.settlement?.releaseCommit ?? null, blocker: !singleton(r.artifacts, `honest-annie-candidate-${r.run.id}-1`) ? 'candidate-missing' : singleton(r.artifacts, `honest-annie-candidate-${r.run.id}-1`).expired ? 'candidate-expired' : r.run.run_attempt >= 3 ? 'effects-retry-exhausted' : null })),  supersededEffects: superseded, republish, republishEffects: republishable.map(r => ({ runId: r.record.run.id, source: r.source, version: r.version, attempts: r.entry?.attempts ?? 0 })), heldEffects: held.map(({ runId, source, reason }) => ({ runId, source, reason })), abandonedEffects: abandoned.map(({ runId, source, reason }) => ({ runId, source, reason })), issuesDisabled: repo.has_issues === false, paid: Boolean(lease), bootstrap: !ledger.checkpoint, incidents: fresh.incidents.map(i => ({ fingerprint: i.fingerprint, kind: i.kind, detail: i.detail, count: i.count, status: i.status, ready: ready(i) })), harnessRepair: repairing ? { incident: repairing.fingerprint, kind: repairing.kind, attempt: repairing.repair.tasks.length } : null, harnessWaits: waits };
  await writeFile(join(dir, 'observer.json'), JSON.stringify(summary));
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## ☠️ Annie: ${state}\n\nSurveillance is cheap. Blind spending is how you fund a disaster.\n\nMode: ${mode}; allowance: $${ledger.allowance}; ready PRs: ${eligible.length}; pending effects: ${pending.length}; republish: ${republish ? republish.version : 'none'}; held: ${held.length}; abandoned: ${abandoned.length}; provider holds: ${fresh.providerHolds.map(hold => `${hold.provider} ${hold.reason}`).join(', ') || 'none'}${holdsExpireAt ? `, all providers held until ${holdsExpireAt}` : ''}.\n${abandoned.map(a => `\n- abandoned run ${a.runId} (${a.source?.slice(0, 12) ?? 'no source'}): ${a.reason}`).join('')}\nIncidents: ${fresh.incidents.filter(i => i.status === 'open').length} open, ${fresh.incidents.filter(ready).length} reported${issueWork.length ? ', issue sync requested' : ''}${repairing ? `; harness self-repair attempt ${repairing.repair.tasks.length} admitted for ${repairing.kind} ${repairing.fingerprint.slice(0, 12)}, delivered only as a PR for Oliver` : ''}${waits.length ? `; harness repairs waiting: ${waits.map(w => `${w.incident?.slice(0, 12) ?? 'all'} ${w.reason}${w.pr ? ` #${w.pr}` : ''}`).join(', ')}` : ''}.\n${fresh.incidents.filter(ready).map(i => `\n- incident ${i.kind}: ${i.detail.replace(/[^A-Za-z0-9 :;,.()#/_+-]/g, '_')} (${i.count} observations)`).join('')}\n`, { flag: 'a' });
  return summary;
}
export async function verifyUploadedLease({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const lease = verifyLease(JSON.parse(await readFile(env.PUFFER_MAINT_LEASE, 'utf8')), { env, task: JSON.parse(env.PUFFER_MAINT_TASK) });
  if (now >= lease.deadline - 90_000) fail('lease expired before dispatch');
  const api = new GitHub(env.GH_TOKEN, fetchImpl);
  const artifacts = await api.pages(`/repos/${OWN}/actions/runs/${lease.runId}/artifacts`, 'artifacts');
  const meta = singleton(artifacts, `annie-lease-${lease.runId}-1`);
  const uploadedDigest = env.ANNIE_LEASE_ARTIFACT_DIGEST?.startsWith('sha256:') ? env.ANNIE_LEASE_ARTIFACT_DIGEST : `sha256:${env.ANNIE_LEASE_ARTIFACT_DIGEST}`;
  if (!meta || String(meta.id) !== env.ANNIE_LEASE_ARTIFACT_ID || meta.digest !== uploadedDigest || time(meta.created_at) < time(lease.createdAt) || time(meta.created_at) > lease.deadline) fail('prepaid lease upload unverified');
  const payload = await api.artifact(meta, 'lease.json');
  if (digest(payload) !== digest(lease)) fail('uploaded lease differs from original');
  return { state: 'prepaid-lease-verified', hash: lease.hash };
}
export async function retryEffects({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (env.HONEST_ANNIE_ENABLED !== 'true' || env.GITHUB_REPOSITORY !== OWN || env.GITHUB_REF !== REF) fail('effects retry disabled');
  const plan = JSON.parse(env.ANNIE_RETRY);
  if (!integer(plan.runId) || !integer(plan.jobId) || !isSha(plan.originalSha) || ![1, 2].includes(plan.attempt) || ![1, 2].includes(plan.jobAttempt ?? plan.attempt) || (plan.jobAttempt ?? plan.attempt) > plan.attempt) fail('invalid effects retry');
  const api = new GitHub(env.GH_TOKEN, fetchImpl);
  const [repo, workflow, run, branch, rules, current, original, jobs] = await Promise.all([
    api.get(`/repos/${OWN}`), api.get(`/repos/${OWN}/actions/workflows/honest-annie.yml`), api.get(`/repos/${OWN}/actions/runs/${plan.runId}`), api.get(`/repos/${OWN}/branches/trunk`), api.pages(`/repos/${OWN}/rules/branches/trunk`), protectedPolicy(path => api.get(`/repos/${OWN}${path}`), env.GITHUB_SHA), protectedPolicy(path => api.get(`/repos/${OWN}${path}`), plan.originalSha), api.pages(`/repos/${OWN}/actions/runs/${plan.runId}/attempts/${plan.jobAttempt ?? plan.attempt}/jobs`, 'jobs'),
  ]);
  if (repo.id !== Number(env.GITHUB_REPOSITORY_ID) || workflow.path !== POLICY_PATH || !trustedRun(run, repo, workflow) || run.head_sha !== plan.originalSha || run.status !== 'completed' || run.run_attempt !== plan.attempt || now - time(run.updated_at) < 30 * 60_000 || branch.protected !== false || rules.length || current !== original) fail('effects retry policy changed/legacy/ineligible');
  const job = jobs.find(job => job.id === plan.jobId);
  if (job?.name !== 'Annie effects (model-free)' || !['failure', 'cancelled', 'timed_out'].includes(job.conclusion)) fail('not an isolated effects job');
  await api.request(`/repos/${OWN}/actions/jobs/${plan.jobId}/rerun`, { method: 'POST' });
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## ☠️ Annie: model-free retry dispatched\n\nOriginal run: ${plan.runId}; effects job: ${plan.jobId}; no model lease.\n`, { flag: 'a' });
  return { state: 'effects-retry-dispatched', runId: plan.runId, jobId: plan.jobId };
}
// Model-free incident issues with the native token (issues: write) from trusted observe output; failures fail the job visibly.
export async function incidentEffects({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.HONEST_ANNIE_ENABLED !== 'true' || env.GITHUB_REPOSITORY !== OWN || env.GITHUB_REF !== REF) fail('incident effects disabled');
  const receipts = await syncIncidents(new GitHub(env.GH_TOKEN, fetchImpl), validateIncidents(JSON.parse(env.ANNIE_INCIDENTS || '[]')));
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## ☠️ Annie: incident issues\n\n${receipts.map(r => `- ${r.kind} ${r.fingerprint}${r.number ? ` #${r.number}` : ''}: ${r.status}${r.reason ? ` (${String(r.reason).replace(/[^A-Za-z0-9 :;,.()#/_-]/g, '_')})` : ''}`).join('\n') || 'nothing to do'}\n`, { flag: 'a' });
  if (receipts.some(r => r.status === 'failed')) fail('incident issue effects failed');
  return { state: 'incidents-synced', receipts };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) (process.argv[2] === 'incidents' ? incidentEffects() : process.argv[2] === 'retry' ? retryEffects() : process.argv[2] === 'verify-upload' ? verifyUploadedLease() : controller()).then(value => console.log(JSON.stringify(value))).catch(async error => {
  const reason = /^[A-Za-z0-9 :;,.()/_-]{1,180}$/.test(error.message ?? '') ? error.message : 'controller observation unavailable';
  console.error(reason); process.exitCode = 1;
  if (process.env.ANNIE_OUTPUT_DIR) {
    await mkdir(process.env.ANNIE_OUTPUT_DIR, { recursive: true, mode: 0o700 });
    await writeFile(join(process.env.ANNIE_OUTPUT_DIR, 'observer.json'), JSON.stringify({ state: 'blocked', paid: false, reason }));
  }
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## ☠️ Annie: blocked, unpaid\n\nEven I cannot bully missing evidence into existence.\n${reason}.\n`, { flag: 'a' });
});
