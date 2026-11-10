# honest_annie

Minimal project-specific maintenance bot around Pi Durable, not a new agent platform.
GitHub Actions integration is `.github/workflows/honest-annie.yml` on fork default branch `trunk`.
Desktop scheduling templates remain optional, uninstalled, and inactive.
No klops auto-update configuration is changed.

## Flow

Daily timer → isolated persistent worktree → bounded maintenance agent → independent reviewer with an offline sandbox over frozen tree T → fixed gates → host commit → numbered image → `latest`.
No useful changes → no commit or release.
A failed fixed gate permits one maintenance-only diagnosis/repair using a bounded private log, inside the original budget and deadline.
A repair starts only with at least 75 minutes left before the run deadline; later, the gate failure stands and the report says `gateRepairSkipped: insufficient-time`.
Repairs revoke prior approval, get a fresh independent full review, and rerun every gate; PR tasks never acquire a coding turn.
A rejected draft remains in the maintenance worktree for the next daily batch.
Desktop mode never pushes Git remote refs.
CI release mode pushes only reviewed source to fork `trunk`, without force or overwriting independent advancement.
Maintenance pushes host commit C; selected PRs push original head H, never synthetic C.

Pi Durable `1.5.0`, Pi AI, Pi Schema, Chord, and the coding-agent model runtime are pinned in `package-lock.json`.
Node ≥24, Bash, Git, rootless Podman, curl, flock, timeout, and standard Linux utilities are required.
Install this module's pinned npm dependencies before running its wrapper.
Commit the harness files before the first maintenance run so its dedicated worktree has a complete baseline.
Use `run.sh`, not a bare Node invocation, for exclusive storage ownership and the whole-process deadline.
`pufferpanel-maintain.service` and `.timer` are user-systemd templates for desktop scheduling at 04:00 UTC plus up to 30 minutes jitter.
Installation and timer activation require a separate decision.
The service template assumes `%h/Workspace/pufferpanel`; edit the repository template before installation if that path differs.

## State and recovery

Default durable state: `~/.pi/agent/maintenance/pufferpanel/maintain.sqlite`.
Default dedicated branch/worktree: `pi-maintenance` / `~/.pi/agent/maintenance/pufferpanel/worktree`.
Operator worktree, branch, index, and uncommitted files are not used as the maintenance scratch area.
`PUFFER_MAINT_SOURCE` and `PUFFER_MAINT_STATE` override source repository and permanent state paths.
`PUFFER_MAINT_NODE` selects the Node executable for `run.sh`.
`PI_CODING_AGENT_DIR` selects the Pi auth/model/settings directory.
`PUFFER_MAINT_REGISTRY` overrides the publisher image name; default is `registry.bugabinga.net/pufferpanel`.
`PUFFER_MAINT_DEFER_PUBLISH=1` stops after a reviewed, gated commit in the retryable `publishing` phase, for a separately credentialed CI release job.
`PUFFER_MAINT_RESULT` writes nonsecret candidate metadata for the trusted CI bridge.
Compiler/archive scratch uses OS temporary space; permanent worktree, SQLite, run evidence, and private Podman cache are retained state.
Legacy mode has one idempotent input request ID per UTC day.
Selected tasks key requests by fingerprint; calendar image tags still permit only one distinct released tree/revision per UTC day.
SQLite checkpoints retain execution, reviewer identity, reviewed tree/hash, commit, version, and publication phase.
Pi Durable `1.4.0`+ migrates an existing desktop `maintain.sqlite` to storage schema version 2 on first open; that file cannot be opened by `1.3.0` or earlier, so downgrading the harness requires fresh desktop state.
Hosted runs always start from fresh state and are unaffected.
The exact commit message is checkpointed with the `committing` phase, and the host commits it with `--cleanup=verbatim`.
An interrupted commit is accepted only when tree, full expected parent list, exact persisted message, and cleanliness prove it is the same reviewed commit; a commit hook that edits the message fails the commit.
Runs that reached `committing` before messages were persisted keep the legacy subject-only message.
An ordinary patch has exact parent `[base]`; a resolved upstream merge has exact parents `[base, pinnedUpstreamSha]` and only when `MERGE_HEAD` was that pinned SHA.
Pending publication is reconciled before a new daily batch, even after its original model deadline.
Interrupted non-replay-safe shell tools are reported as interrupted, not blindly rerun by the durable runtime.
Expired non-publication work is stopped; the next daily batch can inspect and finish the retained draft.
One local flock owns the storage; do not run this storage from multiple processes or hosts.

## Models and limits

There is no hand-curated model list: every provider with usable credentials contributes Pi's own default model for that provider.
Candidates follow Pi's `findInitialModel` order: models matching the Pi agent `settings.json` `enabledModels` patterns first, then Pi's saved `defaultProvider`/`defaultModel`, then each authenticated provider's Pi default in Pi's provider order.
`enabledModels` uses Pi's standard patterns, including globs and `:thinking` suffixes, resolved by Pi's public `resolveModelScopeWithDiagnostics` against authenticated models; a non-array or non-string entry fails closed.
Thinking is the pattern suffix, else `defaultThinkingLevel`, else `high`, clamped to the model, so non-reasoning models run with `off`.
Candidates without known catalog prices are skipped; a zero price counts as known, as for subscription token plans.
The executor uses the first candidate; the separate reviewer conversation prefers the first candidate from a different provider, else the executor's model.
No candidate fails closed before any model request.
Providers without a Pi default model, such as custom `models.json` providers, take part only through `enabledModels` or the saved default.
Pi exports neither its per-provider default table nor `findInitialModel`, and its package `exports` allow only `.` and `./rpc-entry`.
`maintain.mjs` therefore imports `dist/core/model-resolver.js` beside the pinned package entry and refuses to load unless that module's `resolveModelScopeWithDiagnostics` is the public one and the table is a non-empty provider→id map; a test also checks every table key is a built-in pi-ai provider.
CI uses checked-in `ci-settings.json`, which is empty: Pi defaults decide, and an `enabledModels` entry there would take precedence.
CI authenticates through pi-ai's standard provider environment variables, such as `ZAI_API_KEY` or `MINIMAX_API_KEY`; no desktop auth/settings files or OAuth logins are copied.
Existing Pi OAuth/API credentials and model overrides are accessed through `ModelRuntime`, never copied into prompts or logs.
Provider errors are classified by pi-ai: errors it would retry are `transient`; other errors, such as rejected auth or exhausted quota, are `environment`; context overflow stays with Pi's compaction.
Pi's normal conversation retry policy (`settings.retry`: two retries, 2s base backoff) retries transient errors on the same model; every attempt passes the same admission.
A provider leaves the run after an `environment` error, or after a transient error once the retry policy is spent on it.
If nothing of that response was streamed yet, the same request moves to the next available entry; later requests skip the exhausted provider.
Failover never extends the original lease, `$15` cap, or deadline, and each dispatch reserves and settles against the physical model actually sent.
pi-ai `1.5.0` marks Z.AI `1308` as non-retryable, while a `1310` weekly/monthly limit arrives as HTTP 429 and is transient: it fails over only after the retry policy is spent.
Existing coding-agent extensions cannot be loaded unchanged into Pi Durable's distinct extension API.
Policies reuse Oliver's small-change preference, selected model tier, independent review, Git protection, and verified-release discipline.
Provider admission checks reported spend against `$15` and the persisted `2h` deadline before every request.
Requests reserve worst-case context/input plus the phase output ceiling (executor 16000, reviewer 32768 tokens, clamped to the model) using the model's quoted prices; unknown prices block dispatch.
With reasoning, pi-ai sends that ceiling plus the thinking budget as max output for anthropic-messages models without adaptive thinking, such as MiniMax-M3, and for non-adaptive Claude on bedrock-converse-stream.
The reservation adds that budget with pi-ai's own `adjustMaxTokensForThinking` (high: +16384), for every bedrock-converse-stream model as an upper bound.
pi-ai may still clamp the sent value to the remaining context, so the reservation is an upper bound on the adapter's max output.
An offline test drives the real pi-ai anthropic-messages and openai-completions adapters and fails if the sent `max_tokens` differs from the reservation; bedrock is not covered.
Both conversations are offered only Pi Durable's `codemode` tool (QuickJS sandbox, 256 MiB VM memory limit); the reviewer also gets `submit_verdict`.
Each executor turn's final stop reason is reported in `executorDiagnostics`; a final answer cut at the output cap, which can silently drop a truncated codemode script, gets one continuation per executor conversation asking for a shorter script.
Scripts call the other tools as nested calls; `codemode` and `submit_verdict` are model-only.
Script `models.*` reaches only code mode's internal tools, which call the Harness models, which are this budgeted boundary.
`models.classify()` reserves its serialized input bytes as tokens plus 4096 tokens of template and answer headroom, capped at the classifier's context window, at its highest catalog price, and commits that intent before dispatch inside the same lease, `$15` cap, deadline, and 256-call limit.
It dispatches without provider retries; a completed result with reported prompt tokens settles at pi-ai's usage cost, a provider error settles at the reservation, and missing usage, aborts, or interruption keep the reservation held.
Classifier calls count toward cost and call count but never toward provider failures, holds, failover, or `modelFailure`, because scripts control their input.
`models.generateImages()` returns an error without dispatch, raw `stream`, `complete`, and deferred calls are refused, and compaction's `completeSimple` uses the budgeted chat path.
Executor and reviewer instructions say classifiers serve cheap triage, such as whether a log mentions a flaky test, and that their answers are untrusted advice.
Nested `bash` uses the same prepared credential-free shell environment.
Code mode replays a script after a restart from its journal; per Pi Durable's replay policy a nested `bash` interrupted mid-run is not replay-safe, so it rejects in the script as interrupted instead of rerunning.
The budget is based on provider-reported usage and quoted prices, not a guarantee about subscription billing or unreported work interrupted before a usage receipt.
The wrapper's two-hour process-group timeout includes tools, tests, builds, and publication; subsequent invocations may reconcile an already pending publication without spending on new model work.

### Provider holds

Each dispatch failure also records sanitized cross-run evidence, never error text: `{provider, kind, observedAt, resetAt?}` with `kind` `auth`, `quota`, or `transient`.
`auth` is 401/403 or authentication wording; `quota` is a stated reset time, quota/billing/usage-limit wording, or a 402/429 that pi-ai does not retry; everything else is `transient`.
An explicit reset such as Z.AI's `Your limit will reset at 2026-10-30 04:10:13` becomes `resetAt` when it lies within 31 days.
Zone-less reset times are read as UTC+8.
That is verified for Z.AI only: four observed "Usage limit reached for 5 hour" errors fit the 5-hour window only at UTC+8, never at UTC.
A provider in an earlier zone would release its hold early and cost one failed attempt before the next hold.
The model report carries each provider's last failure in the run (`providerFailures`) and the authenticated candidate providers (`providers`), at most 64 each.
Observe folds quota/auth failures from model reports settled since its previous checkpoint into checkpoint `providerHolds` `[{provider, until, reason}]`: `until` is `resetAt`, else `observedAt` + 24h.
Expired holds drop out; a changed config signal (trusted policy, enablement, or `ANNIE_CONFIG_REVISION`) drops every hold and the known provider set, so bump `ANNIE_CONFIG_REVISION` after changing model secrets.
Observe passes active holds to the maintain job as `ANNIE_PROVIDER_HOLDS`; maintain validates them strictly and selection skips held providers, so the run starts on the next provider.
When every known candidate provider is held, observe admits no paid work, reports `providers-held`, and names when the earliest hold expires.
Provider-attributed quota/auth failures replace the shared 24-hour environment cooldown for that run; other environment failures keep it.
Per-run failover is unchanged.

### Rejection memory

The model report carries `changedFiles` (at most 20 sorted safe paths, the full path count, and a SHA-256 of every changed path) and `blockingFindings` (at most 10 ids with impacts of at most 160 redacted characters).
The area is Annie's own delta: for a pinned upstream merge, only paths differing from both base and upstream, unless the merge is the whole change.
Observe folds each review-rejected maintenance report into checkpoint `rejections`: at most 20 strictly validated `{runId, day, files, count, digest, findings}` entries with at most five findings, kept 30 days.
Observe passes them to the maintain job as `ANNIE_REJECTIONS`; maintain validates them strictly and adds them to the untrusted intake as `rejections`.
The maintenance prompt then says not to resubmit the same change unless every finding is addressed with evidence.
Two areas match on equal digests, or on Jaccard similarity of at least 0.6 when both path lists are complete; larger changes match only by digest.
A maintenance candidate whose area matches at least two rejections within 30 days is refused before review, so no reviewer is paid.
That run ends `published` without source or plans, with reason and outcome `repeat-rejected`: a normal handled no-op, not an incident.
A pure upstream merge without changed paths is neither remembered nor refused.

### Commit messages

The subject is `maintenance: DAY: HEADLINE`, cut at 72 characters, where the headline is the first line of the executor's final answer, which the prompt asks to name the main change, or `merge upstream SHA12` without one.
PR commits use `maintenance: DAY: integrate PR #N`, and harness repairs keep `fix(annie): harness repair for incident FP12`.
The body holds at most 2 KiB of the remaining summary, the reviewer's `checked` list, and advisory findings, then host facts: pinned upstream merge, PR head, incident, gate repair, and a closing host line.
Model text is redacted like reports, stripped of control, format, and bidi characters, wrapped at 72 columns behind a host indent or bullet, and never starts a line, so it cannot forge Git trailers.

## GitHub setup

Repository: `bugabinga/pufferpanel`; maintained default branch: `trunk`.
Workflow: `honest_annie`; cheap rediscovery at minutes 7/37, daily quality round at 04:17 UTC.
Schedules are best-effort, not an SLA; GitHub's single replaceable pending concurrency slot is backed by later rediscovery.
Fork scheduled workflows must be enabled; GitHub can disable schedules after 60 days without repository activity.
`HONEST_ANNIE_ENABLED` repository variable must equal `true` for any paid maintenance run.
Initial setup leaves it `false` until credentials are configured.
Manual `workflow_dispatch` defaults to `check`: offline harness tests only, no secrets, model requests, image publication, or Git writes.
After configuring credentials and initial checkpoint bootstrap, select `maintain` to admit useful work within shared allowance.
Manual `observe` or `sweep` refreshes cheap read-only discovery/checkpoint evidence without a model lease or effect retry.

Configure two environments, each restricted to deployment branch `trunk`:

- `honest-annie-model`: any secret named after a pi-ai provider credential variable enables that provider, for example `ZAI_API_KEY` or `MINIMAX_API_KEY`.
  Non-key companions pi-ai reads beside a key, such as `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`, Vertex project/location, or the Azure endpoint, are secrets of the same name.
  Providers authenticated only by ambient cloud identity, such as Bedrock IAM or Vertex application default credentials, are out of scope.
  The three model steps list every name from pi-ai's mapping plus `PROVIDER_COMPANIONS` in `report.mjs`; regenerate the block with `node tools/maintainer/report.mjs provider-env`, and a test fails when a pi upgrade changes the mapping.
- `honest-annie-release`: secrets `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, scoped to publishing `registry.bugabinga.net/pufferpanel`.

Ordinary source/PR/issue operations and model-free retry use native workflow tokens, not a PAT.
Optional `ANNIE_GH_TOKEN` belongs only to `honest-annie-release`, exposed solely when a selected management task explicitly approves `enable-issues` and to harness-fix delivery (see Harness self-repair).
Issues are enabled for incident reports; trunk remains unprotected unless separately reviewed policy changes say otherwise.
Only the release job requests `contents: write`; repository default workflow permissions can remain read-only.
Do not enable Actions permission to approve pull requests.
Required reviewers are intentionally absent for unattended operation; adding an environment approval pauses the corresponding job.
If future trunk protection requires PRs or rejects GitHub Actions pushes, switch to a reviewed PR-based flow rather than bypassing protection.
Commit display name is `honest_annie`; GitHub authentication/attribution remains the native `github-actions[bot]` identity.

The maintenance job has a read-only GitHub token; model provider credentials reach only the availability check, model step, and report collector.
Those steps name each provider credential explicitly as an environment variable that pi-ai reads natively; an unset secret is empty and counts as absent.
The whole secrets context is never dumped: GitHub flags `toJSON(secrets)` as a possibly malicious workflow and refuses to run it without manual approval.
Keep model credentials in `honest-annie-model` and repository-level secrets empty (currently none).
Ancestor process environments remain readable to same-user model shells on hosted runners, so this is policy isolation, not a credential boundary.
Model shells still receive only `PATH`, `HOME`, `TMPDIR`, and `PUFFER_MAINT_INTAKE`.
Report redaction masks values of every set variable in pi-ai's provider env-var mapping and its companions, plus `GH_TOKEN`, `ANNIE_GH_TOKEN`, and `REGISTRY_PASSWORD`.
It exports a prerequisite Git bundle, candidate metadata, and exact-tree gate receipt, not SQLite, transcripts, credential files, or Podman storage.
The fresh release runner checks parent/base/SHA/tree, clean source, unchanged `.github` and `tools/maintainer`, and candidate gate identity.
It discards the imported success marker and independently reruns every fixed gate before registry login, Git push, or image publication.
Model-job files and receipts are not trusted as release authorization: the executor's shell can write that runner's files.
Independent model review remains a policy defense, not cryptographic proof of approval or an OS sandbox.
After fresh release gates pass, it persists the reviewed source first, then runs the trusted publisher from the original checkout.
Authentication uses a temporary Podman auth file removed even after failure; registry secret values are not injected into candidate builds.
Actions dependencies are pinned to verified full commit SHAs.
`.github/workflows/annie-pr-wake.yml` is a separate stable secretless PR lifecycle/review wake with no checkout or artifacts and `permissions: {}`.
The main workflow receives only that workflow's completion, verifies its native workflow ID/path/event, and independently rediscovers current PRs from default-branch code.
Bridge outputs, artifacts, event bodies, and PR checkout code are never trusted as admission or billing inputs.
All trunk pushes and issue lifecycle events also trigger observation; native-token effects do not self-trigger these workflows.
One constant trusted concurrency group serializes admission through effects; offline manual checks use an independent group.

## GitHub intake and proposals

Trusted preparation performs bounded read-only HTTPS GET intake for `bugabinga/pufferpanel` and public `pufferpanel/pufferpanel` only.
The native `GH_TOKEN` is used only for that preparation and is removed from model shell environments.
Intake reports own issues disabled iff repository metadata says `has_issues: false` or the issue list answers HTTP 410.
While issues are disabled, `propose_github` refuses `create-issue` and any `comment`/`add-label` whose target is not a listed open PR or the selected PR; nothing is stored.
The ephemeral intake JSON path is supplied as `PUFFER_MAINT_INTAKE`; it is untrusted data, is not uploaded, and reports retain only compact identifiers, titles, reasons, and proposal summaries.
`node maintain.mjs --help` documents wrapper usage; use `run.sh`, not a bare production invocation.
The executor has `merge_upstream()` for a pinned, uncommitted merge in its dedicated worktree and `propose_github(actions)` for non-executing bounded plans.
Allowed plan kinds: `add-label`, `comment`, `create-issue`, `enable-issues`.
Plans carry a hash, are independently read by the reviewer, and never contain an executable shell command, URL, settings mutation, secret, branch/protection mutation, or destructive operation.
A GitHub-only approved candidate stops at `managing`, with `commit: null`, no source gate, no commit, and no publication.
Only explicit trusted `ci.sh management` executes its approved artifact; model tools never mutate GitHub.
The host revalidates permissions, target identity/open state/timestamp, plan integrity, and bounded idempotence coverage before mutations.


Hosted runners retain SQLite and local drafts only within a job.
Runner loss or a failed maintenance job discards its draft and checkpoints; the next maintenance job starts fresh from `trunk`.
Hosted maintenance has both a `$15` per-job cap and a `$15` rolling-24h cap across immutable original-attempt leases.
Every workflow rerun is unpaid; only selective retries of the known model-free effects job may perform already-approved effects.
The model/gate wrapper has a two-hour deadline; the separate no-model release job has its own timeout.
CI validates private Podman storage after runtime preparation and before exposing model credentials, then always removes its explicit short runroot; release cleanup also removes registry auth.
Each model/release/republish job writes a sanitized Actions summary and uploads only its explicit `report.json` for 14 days, including on failure; raw logs, transcripts, SQLite, environment data, and source diffs are not uploaded.
Reviewed bundles/plans remain separate explicitly approved 14-day artifacts, never blanket report/log uploads.
Rerun only a failed release job to reuse the exact commit/version without more model spend.
Do not rerun the whole workflow as a publication retry: the runtime and YAML prohibit new model calls on every attempt after 1.
The numeric daily version allows at most one image revision per UTC date.
Source may already be on trunk when registry publication fails; that is not evidence of deployment.
Persisted but unpublished source takes the model-free republish lane described below, not a whole-workflow rerun.
No desktop timer or klops deployment is activated by this integration.

## Selected-task CLI contract

`PUFFER_MAINT_TASK` contains JSON, not a filename.
Trusted observe/prepare constructs it before the model job; the release job receives the identical original JSON from trusted orchestration, never reconstructs B/H/U from a model-job artifact.
No API-base URL override or production test bypass exists.
Factory-only `snapshotHttp`, `intakeProvider`, `upstreamUrl`, and `ownUrl` injections support offline tests.
No task env preserves legacy maintenance CLI/desktop behavior.
Selected tasks require `PUFFER_MAINT_DEFER_PUBLISH=1`; direct desktop publication cannot bypass CI source persistence.
Use a fresh source checkout and state directory per hosted selected task.

Required exact JSON fields:

```json
{"kind":"pr","day":"2026-04-03","repo":"bugabinga/pufferpanel","ref":"refs/heads/trunk","base":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","upstreamSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","upstreamRef":"refs/heads/trunk","number":7,"head":"cccccccccccccccccccccccccccccccccccccccc","author":"trusted-author","fingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

`kind` is `maintenance`, `pr`, `management`, or `harness`; non-PR tasks omit `number`, `head`, and `author` entirely.
Only `harness` tasks carry, and must carry, `incident`: the 64-hex incident fingerprint.
`day` is a real UTC calendar date; all object IDs are lowercase 40-hex; fingerprint is lowercase 64-hex; PR numbers are positive 32-bit integers.
Unknown fields, alternate repos/target refs, malformed upstream refs, body data, and snapshot paths are rejected.
Fingerprint is a trusted opaque admission identity, not a self-authenticating authorization signature.
Rich queue/body data lives separately in private OS-temp `PUFFER_MAINT_INTAKE`, never uploaded.

Trusted ordering for source candidates:

1. Observe/prepare pins original B/H/U and selected task outside model-mutable artifacts.
2. Model runner uses the wrapper, then `bash tools/maintainer/ci.sh export`.
3. Export outputs `candidate`, `sourcecandidate`, and `management` booleans for selected tasks.
4. Release runner checks out trusted B, or original H for already-integrated PR retries, then runs `ci.sh import` and `ci.sh gate`.
5. Native `GH_TOKEN` only: `ci.sh push` verifies source persistence before writing private `source.ok`.
6. Only then expose registry credentials to `ci.sh registry-login`, followed by `ci.sh publish`.
7. If `management=true`, run `ci.sh management` after publication; it still runs when source persisted but registry login or publication failed.
8. Always collect sanitized report/receipts, then cleanup temporary registry auth/runroot.

Management is best-effort: `ci.sh management` records applied/skipped/failed receipts, prints one sanitized failed-receipt line to stderr and the step summary, and exits 0 when only receipts failed.
Receipt failures never block source persistence, image publication, release determination, or the queue.

`registry-login` refuses any authentication effect without independent exact-tree gates, matching source receipt, and matching current remote trunk.
The workflow invokes this guard after native source persistence, never direct unguarded Podman login.
With `ANNIE_REPUBLISH` set, `registry-login` calls `republish.mjs authorize` instead: fresh exact-tree gates on the detached release worktree and the release commit still reachable from current remote trunk.
PR import bundles include both approved synthetic C and actual H, then independently verify C parents `[B]`, tree(C)=tree(H)=T, ancestry, linear introduced history, and protected paths including reverted changes.
Upstream merge import requires full ordered `[B,pinned U]`, `trustedUpstreamPin=U`, and the original trusted task U; ordinary patch mode remains `[B]`.
The fresh release gate runs on C/T; publisher archives detached actual H/T and stamps OCI revision H, not C.
Already-H retry does not require an open PR, permission/check rereads, or any model work.
New PR integration rechecks current author write/maintain/admin or push permission, head/target/draft/open state, nonempty successful status/check coverage, branch metadata, and effective rules immediately before push.
Any protected branch, applicable rule, unknown response, missing check coverage, or pagination continuation blocks integration.
Pagination is deliberately bounded to one complete page of at most 100 records; larger sets fail closed, rather than silently losing coverage.
A private OS-temp mode-0700 pre-push hook replaces hooks only for that Git invocation; operator hooks are not edited.
It validates Git-advertised old OID, rejects deleted refs, rewind from observed old OID, and independent advancement; PR ancestry may advance only B≤A≤H.
Git receive-pack checks the advertised old OID atomically after advertisement; Git push is not exact-B CAS and cannot atomically assert live GitHub lifecycle or role.
No force, lease, rule bypass, or privileged push token is used.

Management-only exports contain sanitized `result.json` and a separate explicitly approved `management.json`, no bundle or source gates.
Run `ci.sh management` in a fresh trusted no-model step with the original task; it verifies the complete plan hash, repo, B/T/H identity, canonical allowlist, and approval before auth.
For source plus plans, `source.ok` must match actual release commit and tree before management executes.
Canonical independently approved plans are publication-safe operational artifacts, separately gated from reports.
Unapproved plans, raw intake, transcripts, reviewer answers, and source diffs never cross jobs.
Only allowlisted approved artifact files may cross jobs; never snapshots, transcripts, reviewer answers, SQLite, source diffs, or unchecked logs.
The hash detects modification, not a forged approval from a compromised model runner; workflow artifact provenance and independent gates remain mandatory.
Native `GH_TOKEN` handles labels/comments/create-issue; optional `ANNIE_GH_TOKEN` is supplied only to the trusted management step, used only for reviewed `enable-issues` from a selected `management` task.
Never inject admin token into model jobs or use it for source pushes.
Native installation tokens may not expose a usable repository `permissions` field, so ordinary management checks only repository identity and lets the mutation HTTP status decide, e.g. `GitHub mutation http-403`.
The admin path still requires `permissions.admin`; missing auth or unknown admin permission class fails clearly without credential values.
Labels read current desired state; posts use stable markers excluding volatile timestamps, with complete bounded lookup coverage; stale targets skip visibly.
Read/post races cannot be made atomic by GitHub comments API; timestamps are re-fetched immediately before mutation.
No automatic issue enabling or repository-setting change occurs by default.
Optional `ci.sh feedback` consumes only substantive rejected read-only reviewer findings, posts idempotent `COMMENT` review at exact current H, and rechecks lifecycle/head.
Missing or repeated reviewer verdicts never blame the PR or execute rejected proposals.
Feedback export outputs `feedback=true` only for substantive PR rejection; the trusted effects job invokes it only for that host-validated category.

Public report preserves `taskKind`, `prNumber`, `prHead`, `prAuthor`, `fingerprint`, C, `releaseCommit` H, B/T, ordered parents, trusted upstream pin, model phase costs, `budgetRemainder`, and opaque 64-hex `ledgerReservation`.
`ledgerReservation` binds settlement to its immutable prepaid lease; `budgetCap`, `absoluteDeadline`, `usageComplete`, `knownSubtotal`, and bounded call count carry host accounting evidence.
Collect with optional `--source-receipt PATH` and `--action-receipts PATH` for source/image-pending distinction and applied/skipped/failed receipts.
`--published PATH` requires matching actual release commit plus remote-proof revision/version/SHA256 digest; a missing or arbitrary marker never marks release.
Public reports exclude proposal bodies; separately selected canonical approved plans may be published as operational artifacts.

## Controller admission, accounting, and recovery

`controller.mjs` is the concrete native observer/admission CLI; `ANNIE_MODE=check|observe|sweep|maintain` selects behavior.
`check` exits before API/filesystem observation; the workflow's separate check job only runs offline tests.
Trusted controller config is `ANNIE_OUTPUT_DIR`, `GH_TOKEN`, standard GitHub run/repo/ref/event variables, `HONEST_ANNIE_ENABLED`, and initial `ANNIE_BOOTSTRAP`.
Workflow mappings use repository variables `HONEST_ANNIE_ENABLED` and optional `ANNIE_CONFIG_REVISION`.
Initial manual `observe` may explicitly select the `bootstrap` input; the workflow binds `ANNIE_BOOTSTRAP` to that exact run ID, never a sticky boolean.
Bootstrap defaults off, requires no checkpoint/lease evidence in the supported history horizon, and is visible as `bootstrap: true` in observer evidence.
A later invocation cannot reuse that run-bound grant; missing/expired checkpoints require operator recovery, not another empty-ledger bootstrap.
Lost state requires explicit operator recovery, not automatic fresh paid admission.
`ANNIE_OUTPUT_DIR` belongs in runner temporary space and contains only sanitized `checkpoint.json`, `observer.json`, and optional original `lease.json`.
Intake bodies remain ephemeral; checkpoint hashes contain no issue/PR bodies, titles, or transcripts, and reviewer findings appear only as bounded rejection-memory ids and impacts.
Issue title/body/state changes can be useful inputs; labels/comments alone never create an own-effect paid loop.
Exact own source H is acknowledged without swallowing a concurrent human source commit.
PR fingerprints bind number/H/B/protected-policy identity and exclude clock, upstream, review timestamps, and attempt IDs.
Only currently ready trusted PRs passing native role/check/rule reads are considered before pay.
A daily quality round may honestly no-op; identical handled inputs never force source churn.
The calendar slot is reserved before model execution; verified terminal no-source reports release it, while approved source keeps its immutable slot and blocks replacement work.
Management-only work never consumes that slot.
Anonymous registry HEAD must prove the numbered tag absent before new source admission; collision or unknown availability prevents pay.
Pending approved unpersisted source/management effects with a live candidate and fewer than three effects attempts take priority across midnight and suppress fresh model work.
A source record is released iff a non-expired release report proves publication digest, persisted source, and matching release commit; management receipt statuses are irrelevant.
A management-only record is terminal once any completed release report exists.
A completed unpersisted record whose candidate is missing or expired, or whose run reached attempt 3, becomes `abandoned`: non-blocking, reported, never handled, so a later batch may redo the work.

Persisted source (release commit equals trunk head, or compare reports trunk `ahead`/`identical`) is never blocking.
The observer reads the numbered tag anonymously like `publish.sh`: matching OCI revision means released; a numerically newer `latest` or a different revision on the tag means superseded; otherwise it is a republish candidate.
The release commit may carry an older `.github`/`tools/maintainer` policy; it is only build input, while every executed harness file comes from the trusted current checkout.
Unknown registry or compare answers hold only that record, reported and non-blocking, instead of failing observation.
Only attempt-1 `maintain` with `HONEST_ANNIE_ENABLED=true` emits output `republish` (`runId`, `releaseCommit`, `version`, `day`) and then admits no paid work in that run (`republishing`).
Checkpoint key `republish` tracks at most 20 `{runId, attempts, nextAt}` entries; attempts have a 30-minute cooldown and a ceiling of three, after which the record becomes `abandoned`.
The `republish` job uses `honest-annie-release` with only `contents: read`, checks out trusted `github.sha` for the harness, and gates/publishes a detached release-commit worktree under `$PUFFER_MAINT_STATE`.
`republish.mjs` subcommands: `verify` (unprotected trunk, no rules, trusted checkout policy equal to current trunk policy, release commit reachable from current remote trunk, clean worktree, version), `gate`, `authorize`, `publish`, and `report`.
Its report `honest-annie-republish-report-RUN_ID-ATTEMPT` contains only run ID, release commit, version, and publication digest or failure reason.

Lease artifact: `annie-lease-RUN_ID-1`, expected file `lease.json`.
Final model settlement: `honest-annie-model-report-RUN_ID-1`, expected file `report.json`.
Effects reports: `honest-annie-release-report-RUN_ID-ATTEMPT`; they never contribute additional model charges.
Decision checkpoint: `annie-checkpoint-RUN_ID-1`, refreshed by healthy unpaid sweeps with 14-day retention.
Approved candidate: `honest-annie-candidate-RUN_ID-1`, always reused by selective effects retries.
Artifact transport verifies immutable IDs/digests, bounded ZIP contents, and HTTPS storage redirect hosts; native API auth is never forwarded to storage.
Known complete actual cost replaces cap reservation and is held 24h from original final model-report artifact creation.
Unknown/partial/interrupted cost holds the entire cap through original creation + 2h + 24h + 5min; nonterminal execution is held more conservatively.
The provider boundary persists at most 256 request-scoped call intents, each naming its physical model, before dispatch.
Reservations use the dispatched model's highest catalog tier prices for its full context window plus the phase output ceiling.
Only a valid completed response settles, at pi-ai's normal final `usage.cost.total`: the provider-billed total when `totalFromProvider` is set, otherwise the catalog estimate for the dispatched model.
A response without prompt and output tokens is treated as missing usage; missing, invalid, aborted, or interrupted usage never settles and keeps its reservation held.
A provider error response settles at that call's full reservation, a conservative upper bound, so a recovered retry or failover keeps usage complete without refunding the failed call.
Provider client retries are disabled with `maxRetries: 0`; Pi conversation retries and failover are separate admitted dispatches inside the original run.
`usageComplete`, `knownSubtotal`, call count, cap, absolute deadline, lease hash, and optional `modelFailure` of the last call (`environment` | `transient`, null after a recovered failure) are sanitized report metadata, as are bounded `providers` and `providerFailures` (see Provider holds).
Default desktop limits remain $15/2h; hosted allowance can only tighten them.
These are configured token/pricing statistics, not authoritative provider invoices or a tamper-proof financial ledger.
Artifacts and prompts are not an OS sandbox; repository administrators deleting history or changing trusted policy cross the operational boundary.

`controller.mjs retry` uses only a known `Annie effects (model-free)` job ID, native `actions: write`, matching original/current protected-policy trees, current enablement, and current unprotected branch/rules.
It dispatches asynchronously without waiting under the trusted concurrency group, never uses generic rerun-all/rerun-failed, waits at least 30 minutes, and stops after attempt 3.
Legacy policy and superseded source are deferred without rollback or a new paid batch; exhausted or candidate-less unpersisted work is abandoned rather than blocking.
Controller GitHub reads and artifact downloads retry at most twice after about 1s/3s, only on network error, 5xx, or 429; 4xx and mutations never retry, and errors name stage and status, e.g. `artifact download failed http-503 blob`.
Every effect command independently rechecks current enablement/protected policy during hosted reruns.
`controller.mjs verify-upload` verifies the prepaid artifact before the first provider credential/model step.
`ci.sh management-check` validates the canonical plan and emits `adminAction` before any admin credential is exposed.

History discovery covers a rolling 33-day created horizon: GitHub's 30-day rerun window plus accounting/termination tail.
Filtered windows recursively shard below GitHub's 1000-result cap; each window requires complete stable pagination, with one-hour minimum windows failing closed on saturation.
Lifetime history beyond 10,000 runs does not exhaust admission coverage.
Healthy observations download recent accounting artifacts and checkpoint-carried outstanding IDs, including older nonterminal executions fetched individually.
Pending receipts preserve original lease identity, sanitized settlement, candidate metadata, and original artifact timestamps across 14-day artifact expiry.
Expired/missing candidate packs and exhausted effects retries are reported as abandoned, never as completion; receipt refresh never manufactures approval or completion.
An expired original lease on an old-created recent rerun retains unknown spend without crashing observation; an unsupported expired candidate identity is carried as an explicit blocker rather than silently forgotten.
Bounds remain 999 counted records/window, 198 current PRs, 200 handled fingerprints/outcomes, 20 outstanding receipts/flights, 32 calendar slots, 20 rejection-memory entries, and 256KiB ZIP/128KiB JSON payloads.
Admission records an in-flight task, not terminal handling; verified original-attempt job/step evidence that the model-capable step was skipped releases the flight/calendar slot without charging a lease.
Manual check mode itself remains fully offline; later native observers establish zero dispatch from job metadata, never from the event name alone.
Only valid no-op, substantive rejection, or approved work acknowledges maintenance inputs; invalid review output and transient failures remain bot retries, bounded to three attempts per fingerprint with one-hour backoff.
Exact host-classified PR source refusals (`sourceRejection`: `unsupported-history`, `protected-history`, `non-descendant`) cache until source input changes; stale qualification and transport errors do not.
Environment failures, a pi-ai non-retryable last model failure without a provider quota/auth hold or a failed preparation/provider-availability step, share a 24-hour cooldown across candidates; actual trusted policy/enablement/config-revision changes reset environment gating.
Provider quota/auth failures instead hold only that provider until its stated reset or 24h; when every known candidate provider is held, observe reports `providers-held` without a lease.
After repairing configuration, an operator may change `ANNIE_CONFIG_REVISION` and manually select `maintain`; remaining allowance, immutable leases, current source qualification, fixed gates, and source-before-auth checks still apply.
Unknown calls retain their full lease cap independently of later known retries; no refund funds a same-day replacement.
Effects recovery finds the last failed isolated effects job across at most two prior attempts, even when the latest attempt contains only check/skipped jobs.
A missing model settlement can authorize only model-free recovery from a named candidate artifact plus verified original successful export step and prior failed effects job; fresh-job identity/gates still independently recheck approval.
An exact identity-free unknown release fallback is no completion evidence, not an identity conflict; conflicting nonnull identity remains fatal.
Native GitHub auth accompanies trusted registry-login/publication policy reads; publisher children receive no GitHub/admin tokens.
Live Actions permission behavior, storage redirects, registry availability, real provider usage, and actual publication still require separately authorized evidence.
Offline fixtures do not establish those production seams.

## Verification and release

Host gates run pinned frozen frontend install/tests/lint/build, byte-check vendored Ace, full uncached Go normal/race suites, vet, actionlint, and first-party whitespace checks.
Every gate build and check reads a private export of exactly the gated tree, made by the same `puffer_export_tree` as reviewer priming, so `gate.ok` still names that tree and the gate reuses every primed layer.
A linked worktree's `.git` pointer file alone changed the `COPY . .` digest in a local probe, and an ignored `client/frontend/dist` leftover changed `COPY client .`; neither reaches an export.
Go runs in the glibc Docker test stage with built frontend embeds, not an Alpine container missing gcc/game compatibility/assets.
The successful gate receipt identifies the exact Git tree, not a reusable boolean success marker.
Only the host creates a commit after an independent `submit_verdict` with zero blocking findings and unchanged candidate identity.
The reviewer submits closed bounded findings and what it checked; a run without a verdict gets one reminder, then counts as invalid review output.
Findings map to report strings `[severity] id (file:line): impact — evidence — correction`, blocking first, each cut to 500 characters.
Bot edits to the maintenance harness or any `.github` configuration are rejected before gates and again during CI artifact import.
Numeric calendar SemVer: `2026.10.13`, for example.
The publisher builds a fresh archive of that clean commit, embeds version/SHA, checks the executable version, and verifies remote manifest/config identity.
Numbered tags are immutable; retries reuse the saved image or an already published matching version.
Registry errors other than HTTP 404 never mean an absent version.
`latest` is promoted only after the numbered version is verified, and both remote manifest digests must match.
An observed newer numeric `latest` blocks rollback.
Cross-host concurrent publishers require registry-side locking/CAS; local flock does not eliminate the remote check-to-write race.
Registry reads currently require anonymous HTTPS read access; authenticated private reads need a credential-aware transport before use.
Host Podman uses its own retained storage; publishing uses the operator's existing Podman registry auth.

## Reviewer sandbox

Before review the host exports the recorded candidate tree T through a private Git index into an OS-temp directory, never the worktree, and makes it read-only.
It then builds the fixed gate's `node` and `tests` images from that export with the gate's flags and private Podman storage, so module cache, generated frontend embeds, and frontend dependencies exist offline.
That build executes the candidate's Dockerfile, including its `go test ./...` and frontend checks, with network access but without credentials, before independent review instead of only after it.
The build's Podman client gets only session and storage variables; no provider key, GitHub token, or registry auth reaches it or the build.
It runs only after the same head, tree, diff, and protected-path check that guards review, and it approves nothing.
A failed or late build leaves `run` rejecting as unavailable; the review continues read-only, and the fixed gate rebuilds and reports the failure.
Priming starts only if the deadline still holds the 30-minute review window, a 35-minute gate reserve, and one more minute; otherwise `run` and `ui_snapshot` are unavailable with `insufficient time before the run deadline` and the review stays read-only.
Measured locally with Podman 6.1.4, on a host not otherwise idle: a cold prime of `node` and `tests` took 774 s, then the gate took 959 s with all 4 `node` and all 31 `tests` build steps from cache (3 s and 34 s), despite a planted ignored `dist` file in the worktree; Go normal 417 s, race 442 s, vet 56 s, actionlint 7 s.
Its build log stays in the private run directory as `review-prime.log`.
Management-only candidates change no source, so they skip the build and `run` rejects as unavailable.
`run({ command, timeoutSeconds?, toolchain? })` starts a disposable rootless container by image ID with `--network=none`, `--read-only`, T mounted read-only at `/src`, and a 4 GiB executable tmpfs `/tmp` holding a fresh copy in `/tmp/work`.
Toolchain `go` (default) overlays the image's generated `client/frontend/dist`; committed `web/swagger` stays as reviewed, while the gate image regenerates it.
Toolchain `node` copies `client/` and links the image's installed `node_modules`.
The container environment is only explicit toolchain variables: `PATH`, `HOME`, `TMPDIR`, and Go cache/module settings with `GOFLAGS=-mod=readonly` and `GOPROXY=off`.
`--unsetenv-all` and `--http-proxy=false` drop image, Podman, and host proxy defaults; the Podman client receives only session and storage variables, never credentials.
Limits are 8 GiB memory without extra swap, 4 CPUs, 4096 PIDs, all capabilities dropped, and `no-new-privileges`.
After priming, one trivial probe container per review proves the flag set from inside: only loopback networking, unwritable `/src` and root, and no unexpected environment variable.
If the probe fails because cgroup controllers are not delegated, or if Podman says it ignores rootless limits, it retries without `--memory`, `--cpus`, and `--pids-limit` and reports `limited`; the runner VM is then the outer limit.
An unknown `--unsetenv-all` falls back to explicit `--unsetenv` of the image's and Podman's defaults, and an unknown `--read-only-tmpfs` to Podman's default read-only tmpfs mounts; Podman 4.9 supports both flags, so these paths are not expected to fire there.
Any other probe failure makes the sandbox `unavailable`; network isolation, the read-only source, and environment isolation are never dropped.
Removal uses `--stop-timeout 0` with `podman rm --force`, so no `rm --time` support is needed.
The run report carries a sanitized `sandbox` diagnostic: `available`, `limited`, or `unavailable`, a reason of at most 200 redacted characters, the Podman version (recorded even when priming fails), the count and total seconds of `run` calls, and `visual`: `available`, `unavailable`, or `skipped` with a bounded reason, the Chromium version, and the `ui_snapshot` call count.
Calls run one at a time, default 5 minutes, at most 15, and share 30 minutes of sandbox time per review inside the run deadline.
`run` resolves `{ exitCode, output, truncated }` for every exit code, keeping the first and last 32 KiB of combined output around an omission marker.
Timeouts, Podman exit 125, and a missing exit status reject instead.
Timeout, abort, and review end remove the container with `podman rm --force` and verify it is gone; `podman run --timeout` is a backstop if the host dies.
A container that review end cannot remove is reported as `cleanupFailed: true`; it never discards a recorded verdict and fails the review only when none was recorded.
The sandbox budget lives in the process; a restarted review starts a fresh one, still bounded by the run deadline, and an interrupted `run` is never replayed.
Each call starts with a cold Go build cache, so broad builds and `-race` runs are slow; full suites stay with the fixed gates.
After the reviewer settles, the host compares head, index tree, full diff, and protected paths with the recorded candidate; any change discards the verdict as `invalid-review`.
`run.sh` exports its pinned `PUFFER_MAINT_RUNROOT`, because Podman's storage database rejects a different runroot for the same root; the sandbox refuses to start without one.
Fake-Podman tests cover flags, environment, freezing, capping, timeout and abort cleanup, and the budget; an optional real rootless smoke runs only with a local `alpine:3.22.0` and never pulls.

### Visual review

When the frozen candidate changes a path under `client/` or `web/`, priming also builds a visual image from the host-owned `visual.Containerfile`; other candidates skip it and `report.sandbox.visual` says `skipped`.
The image is the digest-pinned `node:26.12.1-alpine`, that Alpine branch's Chromium and DejaVu fonts, the candidate's own panel binary copied from the just-primed `tests` image, and the host-owned `ui-driver.mjs`.
The panel binary comes from the Alpine `builder` stage with cgo sqlite, so it is musl-dynamic: it runs in the Alpine visual image but not in the glibc `tests` image.
Chromium follows that Alpine branch's security builds instead of an exact apk pin, which would break priming on every Alpine update; the report records the installed version.
A visual build failure only makes `ui_snapshot` unavailable; `run` and the fixed gate are unaffected.
A visual probe runs the probed profile as uid 65534 and requires loopback-only networking, a read-only root, an empty environment, a starting Chromium, a running panel binary, and a readable driver.
`ui_snapshot({ routes, viewport?, login? })` is script-only and `replay: "unsafe"`; each call starts a fresh container with the `run` profile plus `--user 65534:65534`, `TZ=UTC`, `LANG=C.UTF-8`, and no host mount at all.
Inside, a throwaway tmpfs config binds the panel to `127.0.0.1:8080` with sqlite in `/tmp/panel`, the daemon and SFTP off, and a random session key.
The panel's own CLI then runs `db upgrade` and `user add --admin` with a 48-hex password generated in the container for that call only, before `pufferpanel run` and the driver start.
The driver speaks CDP over `--remote-debugging-pipe`, so Chromium opens no port, and fixes viewport (default 1280×800), UTC, en-US, light scheme, reduced motion, and a style that stops animations, transitions, and the caret.
`login: true` signs in through the real login form; an empty virtual WebAuthn authenticator makes the form's passkey attempt fail at once.
Per route it returns final URL, title, 4000 characters of visible text, 60 accessibility-tree lines for landmarks, headings, and controls, console errors and warnings, uncaught exceptions, failed requests (status ≥400 or failed loads), `offlineRequests` to other hosts that fail only because the container is offline, and a viewport PNG.
Limits are 6 routes per call, 8 calls per review, 1 MiB base64 per screenshot after one half-scale retry, 3 MiB per call, and 6 MiB of driver output; each call may take 60 s plus 25 s per route and login, from the same 30-minute budget as `run`.
Screenshots are image blocks `{ type: 'image', data, mimeType: 'image/png' }` in the structured result, so a reviewer script shows one to the model with `image(route.screenshot)`.
When the configured reviewer model's `input` lacks `image`, the result sets `imageInput: false`, omits screenshots, and says so; text signals stay, and pi-ai already replaces images with a placeholder for text-only models after a failover.
Results are spotlit like `run`: every non-token string is wrapped in untrusted markers, while image blocks stay intact for `image()`.
Chromium runs with `--no-sandbox` as uid 65534: measured locally, it refuses to start as root without that flag, and as non-root its namespace sandbox aborts at `sys_chroot` under `--cap-drop all` and `no-new-privileges`.
The offline, capability-free, read-only, non-root container is the isolation boundary instead, and it holds only the candidate's own panel.
Measured locally with Podman 6.1.4 on a cold disk-backed private store: `node` 90 s, `tests` 999 s including the Dockerfile's `go test ./...`, visual image about 60 s cold (Chromium layer about 815 MB) and 1 s cached.
A cached re-prime with the visual image took 30 to 44 s, one public route took 2 to 4 s, and login plus two routes took 25 s, all well inside the 40-minute priming and 2-hour run limits.
A local end-to-end run against this repository rendered `/auth/login`, then after login `/servers` and `/self`, with no console errors, exceptions, or failed requests; only the Gravatar avatar request failed offline.
Unverified on the hosted runner: Podman 4.9's `COPY --chmod` with a local `--from` image, subordinate-ID mapping for uid 65534, and disk headroom for the extra image of about 1 GB.

## Harness self-repair

Observe derives incidents model-free from evidence it already reads, plus failed jobs of trusted runs within 24h.
Kinds: `effects-abandoned`, `effects-held`, `observation-blocked`, `run-stuck` (over 6h), `environment-cooldown`, `providers-held` (every known provider), `job-failed`, `sandbox-unavailable`, `visual-unavailable`, `sandbox-cleanup-failed`, and `gate-harness` (actionlint failing on trunk policy).
Sandbox, visual, cleanup, and gate kinds follow the latest reviewed maintenance or PR report; harness and management runs skip the sandbox by design.
Normal outcomes are not incidents: review rejections, product gate failures, and model failures all end in the model step, honest no-ops fail nothing, and one held provider while another works is not all providers held.
The `Annie harness gate (model-free)` job judges a repair candidate, not trunk, so its failures are not incidents.
Each fingerprint hashes kind and identity: run ID and reason for per-run kinds, masked job and step names or reasons otherwise, never timestamps or counters.
Checkpoint key `incidents` holds at most 20 strictly validated `{fingerprint, kind, detail, runs, firstSeen, since, lastSeen, count, status}` entries.
A cleared entry stays seven days so its issue closes idempotently.
An incident is reported after two observations; a failed job needs two failing runs within 24h.

Job `Annie incidents (model-free)` runs with the native token, `issues: write`, and enablement.
It creates, updates, reopens after recurrence, or closes once cleared one issue per fingerprint, labelled `annie-incident`.
It finds issues by a hidden `<!-- annie-incident:FP -->` marker on a bot-authored issue through complete bounded pagination; a foreign issue with the marker is ignored.
A maintainer closing an ongoing incident is respected until it clears and recurs.
Bodies hold kind, detail, counts, times, and run links, never raw logs; failed receipts fail the job visibly.

Repairable kinds (`job-failed`, `gate-harness`, sandbox, visual, cleanup, `effects-abandoned`) admit a `harness` task before PRs and maintenance.
Its fingerprint hashes the incident, the trusted harness policy, and the attempt number, so every attempt gets its own branch.
Each checkpoint incident keeps `repair` memory `{tasks, last, runId, at, policy}`, refreshed from harness attempts in the ledger and flights, and `pr` while a harness PR for it is open.
Open PRs come from the complete open-PR list; an `annie/harness/` PR is attributed by its `annie-harness-incident` body marker or by a known attempt branch, and fork heads are ignored.
An open harness PR that cannot be attributed, or an unknown lookup of the last attempt's PR, admits no harness repair at all.
This covers the live PR #2, whose body predates the marker, only while its run is in the ledger or `repair` memory; otherwise every repair waits until Oliver closes or merges it.
No repair starts while an attempt for the incident is in flight or awaits review in an open PR; a trusted policy change alone never retries.
Another attempt needs (a) the last PR closed unmerged with the incident still present, (b) the last PR merged and either evidence from a run created after the merge or a recurrence after clearing, or (c) no PR from the last attempt and either a different admission policy or 24h, with an unknown admission policy waiting 24h.
Kinds whose evidence never moves, such as an abandoned run, therefore never retry after a merge.
At most three attempts are made per incident.
While a PR awaits review, the incident issue says `Awaiting review/merge of #N` once per PR, found again by a hidden marker.
It needs allowance, unheld providers, no pending effects, and no environment cooldown, has a $5 lease cap, and never holds a calendar image slot.
Any settled harness outcome except an environment failure is handled.
Observe then fetches the incident runs' failing jobs and steps plus two job log tails with the read-only token.
It strips timestamps, redacts every line, bounds the digest to 48 KiB, and passes it as `ANNIE_INCIDENT`.
The maintain job validates the digest against the task and adds it to the untrusted intake file as `incident`, so model reads are spotlit.
The executor gets `HARNESS_INSTRUCTIONS`, the harness guard, and no `merge_upstream` or `propose_github`.
Its prompt asks for a root-cause diagnosis and the smallest fix with tests, and forbids weakening checks, budgets, or security boundaries.
Harness tasks obey one scope rule, `harnessScopeViolation` in `scope.mjs`, described under Harness PR threat below; it replaces the protected-path check in execute, review, gate, commit, export, import, and delivery.
The fresh reviewer reads the full diff read-only, because priming product sandbox images cannot run harness tests; `run` and `ui_snapshot` are unavailable, and the harness gate executes the tests.
`harness-gate.sh WORKTREE RUN_DIR BASE` replaces the product gates for this kind: scope against the explicit base, whitespace, `npm ci --ignore-scripts` and `npm test` in an exported `tools/maintainer`, and `bash -n` on every tracked script.
The base is explicit because the release-side worktree is detached at the candidate, where `HEAD` is not the base; the scope step must also print its verdict, so a silently skipped check cannot pass.
It also parses every workflow with the trusted harness's own `yaml` package and runs actionlint v1.7.12 through `go run` with private caches.
Actionlint needs Go and network, which hosted runners have; without them the gate fails closed.
Candidate `npm ci` and `npm test` run under `env -i` with only `PATH`, `HOME`, a private `TMPDIR`, and npm cache settings, so provider keys and tokens are not inherited by the harness gate's environment; a test with sentinel values checks that.
The YAML parser is the trusted checkout's `yaml`, a locked transitive dependency of the pinned pi packages; losing it fails the gate closed.
One in-run gate repair follows the maintenance rules.

Approved candidates export `harness=true`, never `candidate=true`, so the trunk release job never sees them; `ci.sh push`, `publish`, `registry-login`, and management refuse them.
Job `Annie harness gate (model-free)` imports the bundle and reruns the harness gate on a fresh runner with `contents: read` and no secrets, because that gate executes candidate code.
Job `harness-deliver` holds `ANNIE_GH_TOKEN` and runs no candidate code; it is named `Annie effects (model-free)` so the bounded effects retry covers it.
It checks the bundle by Git plumbing (commit C, parents `[B]`, tree T) and the scope rule before any PAT use, pushes C without force to `annie/harness/` plus the first 12 hex of the task fingerprint, and opens a PR against trunk.
The same branch only recurs on an effects retry of the same task, which reuses an existing branch or PR and distinguishes open, merged, and closed-unmerged.
Before any PAT use, delivery looks for another open harness PR for the same incident, by body marker or, for older PRs, by Annie's own "ready for review: #N" announcement on the incident issue.
If one exists, delivery pushes and opens nothing and comments that the earlier PR still awaits review/merge.
It never updates the earlier PR's branch: that would change code under Oliver's review, leave its description and review findings stale, and need a force push.
The PR body links the incident with Refs, not Closes, quotes the model's diagnosis as unverified, and lists review findings, changed files, and gates.
Every outcome is commented on the incident issue: ready for review, ready on the branch but PR creation failed, or could not be delivered with the reason.
Receipts `harness-branch`, `harness-pr`, and `incident-comment` reach the release report and Actions summary.
The release report is uploaded only once the outcome is visible as a PR or comment; otherwise the record stays pending for at most three effects attempts and then raises `effects-abandoned`.

Annie never integrates these PRs.
The controller skips `annie/harness/*` heads, and `checkPR` refuses them and any PR whose files touch `tools/maintainer` or `.github`, before any paid admission.
That file screen reads one page; a full page of 100 files or a continuation fails closed rather than screening only the first page.
`verifyPRHistory` still rejects reverted introductions during paid preparation; that refusal alone ran after admission, so it never covered this before pay.
`ANNIE_GH_TOKEN` must be a fine-grained PAT for `bugabinga/pufferpanel` only, with Contents, Pull requests, Workflows, and Issues read/write.
The native token cannot push workflow changes or create PRs under current repository settings.
Missing or insufficient permissions show as failed receipts and an incident comment, never a silent drop.
PAT pushes and PRs do trigger workflows: `annie-pr-wake.yml` stays secretless, the main workflow observes the wake and never admits the PR, and the other PR workflows target `v3`.

### Harness PR threat

The harness PR comes from a same-repository branch, so GitHub runs `pull_request` workflows from the PR's own workflow definitions, with a `GITHUB_TOKEN` and without Oliver's review.
The repository's Actions default token permission is read, but a workflow's `permissions:` key overrides it, for example to `contents: write`.
Trunk is deliberately unprotected, so such a token could push to trunk before Oliver sees the PR.
Repository-level secrets stay empty and both environments deploy from trunk only; keep it so, but that limits secrets, not the token.
The rule: a harness candidate may change only `tools/maintainer/**` and `.github/workflows/honest-annie.yml`.
Every other `.github` change is refused: other workflows edited, added, or removed (including upstream `arch.yml`, `build.yml`, `formatter.yml`, `run-template-tester.yml`, `tester.yml`, and `annie-pr-wake.yml`), `actionlint.yaml`, issue templates, and anything else.
In `honest-annie.yml`, the parsed top-level `on:` must deeply equal the base's, and the top-level key set must not change, because YAML 1.1 parsers read `true:` or `yes:` as `on`.
Adding, deleting, or breaking the YAML of `honest-annie.yml` is refused too.
With triggers frozen, the branch's `honest-annie.yml` never runs: its `push` trigger names trunk only, and `workflow_run`, `issues`, `schedule`, and `workflow_dispatch` run trunk's definition.
Enforcement uses the same function at five layers: the executor guard refuses writes outside the allowed paths, and the maintain snapshot, the harness gate, CI import, and delivery (before any PAT use) apply the whole rule.

### Harness risks

The harness gate's candidate `npm ci` and `npm test` run natively as the runner user, not in the network-less Podman sandbox the product gate uses; that is a weaker posture and a known, accepted residual.
On the maintain side they share the model job's runner with its credentials; `env -i` keeps those out of their environment, but same-user processes can still read ancestor environments through `/proc`, as for model shells.
On the release side they run in a separate job with no secrets and a read-only token.
Annie cannot report or repair a harness that cannot observe, such as `check` or observe failing on every run.
A crashed observe run without a checkpoint also holds the full allowance for a day, so its repair waits.

## Trust and tests

The executor uses an operator-trusted local shell with the operator's OS permissions.
Prompts and protected-path checks are policy defenses, not an OS sandbox or credential-isolation boundary.
Use a dedicated restricted account/environment before enabling this against untrusted projects if stronger isolation is needed.
The reviewer's scripts have a confined read tool, fixed diff tool, plan reader, sandboxed `run` tool, and sandboxed `ui_snapshot` tool, with no host shell or write tool.
`guard.mjs` is a best-effort tool guard selected for the executor and reviewer conversations; snapshot, protected-path, host-commit, review, and import checks remain authoritative.
Before a `write` or `edit` it canonicalises the path and rejects targets outside the worktree, through a symlink leaving it, symlinks themselves, `.git`, and `PROTECTED_PATHS` from `task.mjs`, the same list the post-hoc checks use; the tool then runs on the checked absolute path.
Before a `bash` call it rejects, with a corrective reason, quote-aware command starts that commit, push, tag, hard-reset, rebase, cherry-pick, merge (use `merge_upstream`), change Git config or remotes, push or log in to registries, run `gh`, send credentials with curl/wget, or redirect/`tee` into protected paths, also after `;`, `&&`, `||`, `|`, `$(`, backticks, and inside `sh -c`/`eval`.
Known gaps include variables, aliases, generated scripts, interpreters such as `python -c`, `cd` before relative redirects, redirects to quoted paths with spaces, unlisted option-argument pairs before a subcommand, and copy commands; the post-hoc checks still catch their source effects.
A push those gaps let through has no post-hoc undo; the model shell's credential-free environment is the backstop there.
The shell gate in `gate.sh` keeps its own literal copy of the protected list.
PR tasks have no executor conversation; maintenance, management, harness, and gate-repair executor turns all select a guard.
Harness tasks install `pufferpanel-harness-guard` with `protectedPaths: []`; confinement, `.git` protection, and every command block stay.
Results of reviewer `run`, `ui_snapshot`, `read_github_plans`, executor reads outside the worktree (intake, private gate log), and executor `bash` that fetches, reads the intake, or names `upstream` are wrapped in `<untrusted id=…>` … `</untrusted id=…>` with a random per-process id.
Look-alike markers inside are escaped, so content cannot close the block; JSON stays parseable because only non-token strings are wrapped in place.
Scripts receive the wrapping in the `output` field or string value they would print; exit codes and other structured fields are unchanged.
Host gate/publisher copies come from the original harness directory, not the candidate checkout.
Offline tests use real SQLite and faux model turns that drive real codemode scripts and nested tools, real temporary Git worktrees/commits, and stubbed external publisher commands.
No paid maintenance run, live gate build, registry publication, system installation, or deployment is performed by those tests.
A separate live gate validation built the real node/glibc test images and passed frontend checks, Ace identity, full Go race tests, vet, and actionlint.
The uncached normal suite exposed an intermittent existing `TestServers_Restarts` failure (`server running`); the gate stopped without a release receipt, demonstrating fail-closed behavior.
Investigating that restart failure is an initial maintenance candidate, not a reason to bypass the gate.

## Research

[Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) documents SQLite recovery, request IDs, tool replay policy, extension registration, and usage accounting.
[Durable coding-agent example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/26-coding-agent.ts) supplies the built-in tools/environment pattern.
[Durable reviewer example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/28-reviewer.ts) supplies separate conversation/tool selection.
[Published package metadata](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.5.0) confirms the pinned experimental package release.
[Virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) describe Pi's retry-time model routing; Pi Durable does not route virtual models, so the provider boundary applies the same failover.
Installed operator Pi was `1.1.0`; this module does not upgrade that installation or `pi-ext` dependencies.
Experimental API changes require an explicit harness dependency update and tests, not an incidental daily self-update.
