import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWN, REF, isSha, validateTask } from './task.mjs';
import { checkPR, protectedPolicy } from './pr.mjs';

export const POLICY_PATH = '.github/workflows/honest-annie.yml';
export const WAKE_PATH = '.github/workflows/annie-pr-wake.yml';
const HOUR = 3_600_000, DAY = 24 * HOUR, MARGIN = 5 * 60_000;
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error(reason); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : fail('invalid ledger timestamp');
const allowedEvents = ['schedule', 'push', 'issues', 'workflow_dispatch', 'workflow_run'];
export function prFingerprint({ number, head, base, policy }) { return digest({ number, head, base, policy }); }
export function makeLease({ run, repoId, workflowId, task, cap, now = Date.now() }) {
  if (run.run_attempt !== 1 || !integer(run.id) || !integer(repoId) || !integer(workflowId) || !isSha(run.head_sha) || !allowedEvents.includes(run.event)) fail('ineligible paid execution');
  const createdAt = time(run.created_at), deadline = createdAt + 2 * HOUR;
  if (createdAt > now || now >= deadline - 90_000 || !Number.isFinite(cap) || cap <= 0 || cap > 15) fail('paid horizon or allowance exhausted');
  const lease = { schema: 1, type: 'lease', runId: run.id, attempt: 1, repoId, workflowId, headSha: run.head_sha, event: run.event, createdAt: run.created_at, deadline, cap, task: validateTask(task) };
  return { ...lease, hash: digest(lease) };
}
export function verifyLease(lease, { env, task }) {
  const keys = ['schema', 'type', 'runId', 'attempt', 'repoId', 'workflowId', 'headSha', 'event', 'createdAt', 'deadline', 'cap', 'task', 'hash'];
  if (!lease || typeof lease !== 'object' || Object.keys(lease).sort().join(',') !== keys.sort().join(',') || !integer(lease.runId) || !integer(lease.repoId) || !integer(lease.workflowId) || !allowedEvents.includes(lease.event)) fail('invalid prepaid lease schema');
  const { hash, ...body } = lease ?? {};
  if (body.schema !== 1 || body.type !== 'lease' || hash !== digest(body) || body.attempt !== 1 || String(body.runId) !== env.GITHUB_RUN_ID || env.GITHUB_RUN_ATTEMPT !== '1' || body.headSha !== env.GITHUB_SHA || body.repoId !== Number(env.GITHUB_REPOSITORY_ID) || body.deadline !== time(body.createdAt) + 2 * HOUR || body.cap <= 0 || body.cap > 15 || !Number.isFinite(body.cap) || digest(body.task) !== digest(validateTask(task))) fail('invalid prepaid lease binding');
  return lease;
}
export function rollingAllowance(entries, now = Date.now()) {
  let held = 0;
  for (const { lease, settlement, settledAt, terminal = true, unknown = false, updatedAt, deadline = 0 } of entries) {
    if (unknown) { if (!terminal || Math.max(time(updatedAt), deadline) + DAY + MARGIN > now) held += 15; continue; }
    if (!lease || lease.cap <= 0 || lease.cap > 15 || !Number.isFinite(lease.cap)) fail('invalid accounting lease');
    const actual = settlement?.ledgerReservation === lease.hash && settlement?.usageComplete === true && settlement?.reportedUsage?.status === 'known' && Number.isFinite(settlement.reportedUsage.cost) && settlement.reportedUsage.cost >= 0 ? settlement.reportedUsage.cost : null;
    if (actual !== null && terminal) { if (time(settledAt) + DAY > now) held += actual; }
    else if (!terminal || lease.deadline + DAY + MARGIN > now) held += lease.cap;
  }
  return Math.max(0, 15 - held);
}

export class GitHub {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async request(path, options = {}) {
    if (!path.startsWith('/repos/') || path.split('?')[0].includes('..')) fail('invalid API path');
    const res = await this.fetch(`https://api.github.com${path}`, { ...options, redirect: 'manual', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'honest-annie-controller', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers }, signal: AbortSignal.timeout(15_000) });
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
  async artifact(meta, filename) {
    if (!integer(meta?.id) || meta.expired || !/^sha256:[a-f0-9]{64}$/.test(meta.digest ?? '') || !Number.isInteger(meta.size_in_bytes) || meta.size_in_bytes < 1 || meta.size_in_bytes > 262144) fail('unavailable ledger artifact');
    const res = await this.fetch(`https://api.github.com/repos/${OWN}/actions/artifacts/${meta.id}/zip`, { redirect: 'manual', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    let archive = res;
    if (res.status === 302) {
      const url = new URL(res.headers.get('location'));
      if (url.protocol !== 'https:' || url.username || url.password || !(/(^|\.)blob\.core\.windows\.net$/.test(url.hostname) || /(^|\.)githubusercontent\.com$/.test(url.hostname) || /(^|\.)actions\.github\.com$/.test(url.hostname))) fail('untrusted artifact redirect');
      archive = await this.fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(15000) }); // Deliberately NO Authorization.
    }
    if (!archive.ok) fail('artifact download failed');
    const bytes = await boundedBody(archive, 262144);
    if (`sha256:${digest(bytes)}` !== meta.digest) fail('artifact digest mismatch');
    return unzipJSON(bytes, filename);
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
      const keys = ['schema', 'runId', 'repoId', 'handled', 'slots', 'paid', 'queue', 'pendingRuns', 'lastMaintenance', 'upstream', 'inputBase', 'flights', 'outcomes', 'environment', 'receipts', 'blocked'];
      if (!value || Object.keys(value).some(key => !keys.includes(key)) || ['queue', 'lastMaintenance'].some(key => value[key] !== undefined && !/^[a-f0-9]{64}$/.test(value[key])) || ['upstream', 'inputBase'].some(key => value[key] !== undefined && !isSha(value[key])) || value.paid !== undefined && typeof value.paid !== 'boolean') fail('malformed decision checkpoint fields');
      if (value.pendingRuns !== undefined && (!Array.isArray(value.pendingRuns) || value.pendingRuns.length > 20 || value.pendingRuns.some(id => !integer(id)))) fail('malformed pending checkpoint');
      if (value.schema !== 1 || value.runId !== run.id || value.repoId !== repo.id || !Array.isArray(value.handled) || value.handled.length > 200 || value.handled.some(v => !/^[a-f0-9]{64}$/.test(v)) || !Array.isArray(value.slots) || value.slots.length > 32 || value.slots.some(v => !/^\d{4}-\d{2}-\d{2}$/.test(v))) fail('malformed decision checkpoint');
      if (value.flights !== undefined && (!Array.isArray(value.flights) || value.flights.length > 20 || value.flights.some(f => !integer(f.runId) || !/^[a-f0-9]{64}$/.test(f.queue) || !validateTask(f.task)))) fail('malformed flights');
      if (value.outcomes !== undefined && (!Array.isArray(value.outcomes) || value.outcomes.length > 200 || value.outcomes.some(o => !/^[a-f0-9]{64}$/.test(o.fingerprint) || !integer(o.runId) || !integer(o.attempts) || !Number.isFinite(o.nextAt) || !['environment', 'zero-dispatch', 'transient'].includes(o.kind)))) fail('malformed outcomes');
      if (value.environment != null && (!/^[a-f0-9]{64}$/.test(value.environment.signal) || !Number.isFinite(value.environment.nextAt))) fail('malformed environment cooldown');
      if (value.blocked !== undefined && (!Array.isArray(value.blocked) || value.blocked.length > 20 || value.blocked.some(b => !integer(b.runId) || !['expired-candidate-identity', 'admission-unreconciled'].includes(b.reason)))) fail('malformed blocked receipts');
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
export function chooseTask({ prs, base, upstreamSha, upstreamRef, policy, day, checkpoint, usefulUpstream = false, queueChanged = false, daily = false }) {
  const handled = new Set(checkpoint.handled), common = { day, repo: OWN, ref: REF, base, upstreamSha, upstreamRef };
  for (const pr of prs) {
    const fingerprint = prFingerprint({ number: pr.number, head: pr.head.sha, base, policy });
    if (!handled.has(fingerprint)) return validateTask({ ...common, kind: 'pr', number: pr.number, head: pr.head.sha, author: pr.user.login, fingerprint });
  }
  const kind = queueChanged && !usefulUpstream && !daily ? 'management' : 'maintenance';
  const fingerprint = digest({ kind, base, upstreamSha, policy, queue: checkpoint.queue, ...(daily ? { day } : {}) });
  if ((usefulUpstream || queueChanged || daily) && !handled.has(fingerprint)) return validateTask({ ...common, kind, fingerprint });
  return null;
}
export async function publicationAvailable(fetchImpl, day) {
  const version = day.split('-').map(Number).join('.');
  const res = await fetchImpl(`https://registry.bugabinga.net/v2/pufferpanel/manifests/${version}`, { method: 'HEAD', redirect: 'error', headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return true;
  if (res.ok) return false;
  fail('anonymous publication availability unknown');
}
async function output(name, value) { if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`, { flag: 'a' }); }
export async function controller({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const mode = env.ANNIE_MODE ?? 'check';
  if (mode === 'check') return { state: 'offline-unpaid' }; // No reads, observations, leases, retries, or effects.
  if (!['observe', 'sweep', 'maintain'].includes(mode) || env.GITHUB_REPOSITORY !== OWN || env.GITHUB_REF !== REF) fail('untrusted controller invocation');
  const api = new GitHub(env.GH_TOKEN, fetchImpl), repo = await api.get(`/repos/${OWN}`);
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
    if (pr.draft || pr.user?.type === 'Bot') continue;
    const task = { kind: 'pr', day, repo: OWN, ref: REF, base: branch.commit.sha, upstreamSha: pin.object.sha, upstreamRef, number: pr.number, head: pr.head?.sha, author: pr.user?.login, fingerprint: prFingerprint({ number: pr.number, head: pr.head?.sha, base: branch.commit.sha, policy }) };
    try { validateTask(task); await checkPR(task, { fetchImpl, token: env.GH_TOKEN }); eligible.push(pr); } catch { /* Waiting/foreign PRs are visible but never paid. */ }
  }
  for (const record of ledger.records) record.effectIdentity = record.settlement ?? (!record.zeroDispatch && record.lease.task.kind === 'pr' && singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`) ? { commit: record.lease.task.head, releaseCommit: record.lease.task.head, managementApproved: false, phase: 'publishing' } : null);
  const active = ledger.records.filter(r => (r.effectIdentity?.commit || r.effectIdentity?.managementApproved) && !['failed', 'rejected'].includes(r.effectIdentity.phase));
  const pending = ledger.records.filter(record => !record.zeroDispatch && !record.effectIdentity && singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`));
  const superseded = [];
  for (const record of active) {
    const reports = record.artifacts.filter(a => a.name.startsWith(`honest-annie-release-report-${record.run.id}-`));
    let released = false;
    for (const meta of reports) {
      if (meta.expired) continue; // Refreshed pending receipt survives retention, never invents completion.
      const report = await api.artifact(meta, 'report.json');
      if (noCompletionEvidence(report)) continue;
      if (report.fingerprint !== record.lease.task.fingerprint || report.ledgerReservation !== record.lease.hash || ['base', 'day'].some(key => report[key] != null && report[key] !== record.lease.task[key]) || report.releaseCommit != null && report.releaseCommit !== record.effectIdentity.releaseCommit) fail('release report identity mismatch');
      const managementDone = !record.effectIdentity.managementApproved || report.actionReceipts?.length && report.actionReceipts.every(r => ['applied', 'skipped'].includes(r.status));
      if (managementDone && (!record.effectIdentity.commit || /^sha256:[a-f0-9]{64}$/.test(report.publicationDigest ?? '') && report.sourcePersisted === true && report.releaseCommit === record.effectIdentity.releaseCommit)) released = true;
    }
    if (!released) {
      let compatible = record.effectIdentity.releaseCommit === branch.commit.sha || record.lease.task.base === branch.commit.sha;
      if (!compatible && record.lease.task.kind === 'pr') {
        try {
          const [sinceBase, untilHead] = await Promise.all([api.get(`/repos/${OWN}/compare/${record.lease.task.base}...${branch.commit.sha}`), api.get(`/repos/${OWN}/compare/${branch.commit.sha}...${record.effectIdentity.releaseCommit}`)]);
          compatible = ['ahead', 'identical'].includes(sinceBase.status) && ['ahead', 'identical'].includes(untilHead.status);
          if (![sinceBase.status, untilHead.status].every(status => ['ahead', 'behind', 'identical', 'diverged'].includes(status))) compatible = true;
        } catch { compatible = true; } // Unknown ancestry never authorizes buying replacement work.
      }
      if (compatible) pending.push(record);
      else superseded.push({ runId: record.run.id, source: record.effectIdentity.releaseCommit ?? null });
    }
  }
  const fresh = { ...checkpoint, schema: 1, runId: run.id, repoId: repo.id, queue: checkpoint.queue ?? queue, paid: false, pendingRuns: [...new Set([...ledger.outstanding, ...pending.map(record => record.run.id), ...ledger.records.filter(r => !r.zeroDispatch && (r.run.status !== 'completed' || !r.settlement && r.lease.deadline + DAY + MARGIN > now)).map(r => r.run.id)])] };
  fresh.blocked = ledger.blockers;
  if (fresh.pendingRuns.length > 20) fail('outstanding execution capacity exceeded');
  // Retain only current PR fingerprints plus last maintenance metadata; healthy sweeps refresh retention.
  const current = new Set(prs.map(pr => prFingerprint({ number: pr.number, head: pr.head?.sha, base: branch.commit.sha, policy })));
  fresh.handled = checkpoint.handled.filter(value => current.has(value) || value === checkpoint.lastMaintenance).slice(-199);
  fresh.flights = (checkpoint.flights ?? []).filter(f => !ledger.records.some(r => r.run.id === f.runId && (r.zeroDispatch || r.run.status === 'completed')));
  fresh.outcomes = [...checkpoint.outcomes ?? []];
  const configSignal = digest({ policy, enabled: env.HONEST_ANNIE_ENABLED, repair: env.ANNIE_CONFIG_REVISION ?? '' });
  fresh.environment = checkpoint.environment?.signal === configSignal ? checkpoint.environment : null;
  for (const record of ledger.records) {
    const selected = record.lease?.task ?? record.task;
    if (!selected || record.run.status !== 'completed') continue;
    const result = record.settlement;
    const terminal = result && (selected.kind === 'pr' && ['unsupported-history', 'protected-history', 'non-descendant'].includes(result.sourceRejection) || result.phase === 'published' || result.managementApproved || result.phase === 'rejected' && result.reason === 'review-rejected');
    if (terminal) {
      if (!fresh.handled.includes(selected.fingerprint)) fresh.handled.push(selected.fingerprint);
      if (selected.kind !== 'pr') { fresh.lastMaintenance = selected.fingerprint; fresh.upstream = selected.upstreamSha; fresh.inputBase = selected.base; fresh.queue = checkpoint.flights?.find(f => f.runId === record.run.id)?.queue ?? fresh.queue; }
    } else {
      const existing = fresh.outcomes.find(o => o.fingerprint === selected.fingerprint);
      if (existing?.runId >= record.run.id) continue;
      const reason = result?.reason ?? '';
      const environment = result?.modelFailure === 'environment' || record.environmentFailure || /401|403|invalid.?key|missing.*(tool|config)|configuration|podman/i.test(reason);
      const outcome = { fingerprint: selected.fingerprint, runId: record.run.id, attempts: (existing?.attempts ?? 0) + 1, nextAt: time(record.run.updated_at) + (environment ? DAY : HOUR), kind: environment ? 'environment' : record.zeroDispatch ? 'zero-dispatch' : 'transient' };
      fresh.outcomes = fresh.outcomes.filter(o => o.fingerprint !== selected.fingerprint); fresh.outcomes.push(outcome);
      if (environment) fresh.environment = { signal: configSignal, nextAt: outcome.nextAt };
    }
  }
  fresh.outcomes = fresh.outcomes.slice(-200);
  fresh.receipts = ledger.records.filter(record => fresh.pendingRuns.includes(record.run.id) && record.lease).map(record => ({ runId: record.run.id, lease: record.lease, leaseMeta: record.leaseMeta, reportMeta: record.reportMeta ?? null, candidate: singleton(record.artifacts, `honest-annie-candidate-${record.run.id}-1`) ?? null, settlement: record.settlement ? Object.fromEntries(['ledgerReservation', 'fingerprint', 'taskKind', 'day', 'base', 'managementApproved', 'phase', 'commit', 'releaseCommit', 'usageComplete', 'reportedUsage'].map(key => [key, record.settlement[key]])) : null }));
  const noSourceDays = new Set(ledger.records.filter(record => record.run.status === 'completed' && record.settlement && !record.settlement.commit && record.lease.task.kind !== 'management').map(record => record.lease.task.day));
  const reservedSourceDays = new Set(ledger.records.filter(record => !record.zeroDispatch && (record.settlement?.commit || !record.settlement)).map(record => record.lease.task.day));
  const zeroDays = new Set(ledger.records.filter(r => r.zeroDispatch && r.task).map(r => r.task.day));
  fresh.slots = checkpoint.slots.filter(value => value >= new Date(now - 31 * DAY).toISOString().slice(0, 10) && ((!noSourceDays.has(value) && !zeroDays.has(value)) || reservedSourceDays.has(value)));
  const ownAcknowledged = ledger.records.some(record => record.settlement?.releaseCommit === branch.commit.sha);
  const humanSourceChanged = checkpoint.inputBase !== undefined && checkpoint.inputBase !== branch.commit.sha && !ownAcknowledged;
  const task = chooseTask({ prs: eligible, base: branch.commit.sha, upstreamSha: pin.object.sha, upstreamRef, policy, day, checkpoint: { ...fresh, handled: [...fresh.handled, ...fresh.flights.map(f => f.task.fingerprint), ...fresh.outcomes.filter(o => (o.kind !== 'environment' || checkpoint.environment?.signal === configSignal) && (o.attempts >= 3 || o.nextAt > now)).map(o => o.fingerprint)], queue }, usefulUpstream: humanSourceChanged || checkpoint.upstream !== undefined && checkpoint.upstream !== pin.object.sha, queueChanged, daily: env.GITHUB_EVENT_NAME === 'schedule' && event.schedule === '17 4 * * *' });
  fresh.upstream ??= pin.object.sha;
  fresh.inputBase = ownAcknowledged || fresh.inputBase === undefined ? branch.commit.sha : fresh.inputBase;
  let state = pending.length || ledger.blockers.length ? 'effects-pending' : task ? 'useful-input' : 'no-op';
  let lease = null;
  if (mode === 'maintain' && task && !pending.length && !ledger.blockers.length && !(fresh.environment?.nextAt > now) && env.HONEST_ANNIE_ENABLED === 'true' && env.GITHUB_RUN_ATTEMPT === '1' && ledger.allowance > 0) {
    if (task.kind !== 'management' && (fresh.slots.includes(day) || branch.protected !== false || !await publicationAvailable(fetchImpl, day))) state = 'source-slot-unavailable';
    else {
      const rules = await api.pages(`/repos/${OWN}/rules/branches/trunk`);
      if (rules.length) state = 'protected-policy';
      else {
        lease = makeLease({ run, repoId: repo.id, workflowId: workflow.id, task, cap: ledger.allowance, now });
        fresh.paid = true;
        fresh.flights.push({ runId: run.id, task, queue });
        if (task.kind !== 'management') fresh.slots.push(day);
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
  await output('retry', retry ? JSON.stringify(retry) : '');
  await output('paid', Boolean(lease)); await output('task', lease ? JSON.stringify(task) : ''); await output('lease', lease ? JSON.stringify(lease) : ''); await output('state', state);
  const summary = { state, mode, effectsRetry: retry, observationBlockers: ledger.blockers, allowance: ledger.allowance, readyPRs: eligible.length, pendingEffects: pending.map(r => ({ runId: r.run.id, source: r.settlement?.releaseCommit ?? null, blocker: !singleton(r.artifacts, `honest-annie-candidate-${r.run.id}-1`) ? 'candidate-missing' : singleton(r.artifacts, `honest-annie-candidate-${r.run.id}-1`).expired ? 'candidate-expired' : r.run.run_attempt >= 3 ? 'effects-retry-exhausted' : null })),  supersededEffects: superseded, issuesDisabled: repo.has_issues === false, paid: Boolean(lease), bootstrap: !ledger.checkpoint };
  await writeFile(join(dir, 'observer.json'), JSON.stringify(summary));
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## 🌻 Annie: ${state}\n\nMode: ${mode}; allowance: $${ledger.allowance}; ready PRs: ${eligible.length}; pending effects: ${pending.length}.\n`, { flag: 'a' });
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
  if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `## 🌻 Annie: model-free retry dispatched\n\nOriginal run: ${plan.runId}; effects job: ${plan.jobId}; no model lease.\n`, { flag: 'a' });
  return { state: 'effects-retry-dispatched', runId: plan.runId, jobId: plan.jobId };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) (process.argv[2] === 'retry' ? retryEffects() : process.argv[2] === 'verify-upload' ? verifyUploadedLease() : controller()).then(value => console.log(JSON.stringify(value))).catch(async error => {
  const reason = /^[A-Za-z0-9 :;,.()/_-]{1,180}$/.test(error.message ?? '') ? error.message : 'controller observation unavailable';
  console.error(reason); process.exitCode = 1;
  if (process.env.ANNIE_OUTPUT_DIR) {
    await mkdir(process.env.ANNIE_OUTPUT_DIR, { recursive: true, mode: 0o700 });
    await writeFile(join(process.env.ANNIE_OUTPUT_DIR, 'observer.json'), JSON.stringify({ state: 'blocked', paid: false, reason }));
  }
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## 🌻 Annie: blocked, unpaid\n\n${reason}.\n`, { flag: 'a' });
});
