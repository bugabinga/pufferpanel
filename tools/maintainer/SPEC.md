# Annie maintainer contract

## Purpose

Maintain Oliver's PufferPanel fork and its GitHub work queue, not manufacture daily code churn.
Preserve fork-specific behavior while integrating useful upstream work, supported updates, reproducible fixes, tests, documentation, and measured improvements.

## Authority

The operator authorizes automatic integration of non-draft PRs from authors with current repository write, maintain, or admin permission.
Unknown authors and insufficient or unverifiable permissions fail closed.
Recheck author permission, PR head, target, checks, and applicable repository rules immediately before integration.
Never force-push, bypass protections, silently replace reviewed source, or automatically integrate changes to the trusted maintainer harness or GitHub workflow policy.
Do not change repository visibility, delete the repository, expose credentials, or perform production administration.
Normal GitHub access uses the short-lived workflow token.
Optional ANNIE_GH_TOKEN belongs only to trusted release/management and harness-delivery steps; model tools and candidate code never receive it.
Repository-administration capability is not permission to perform arbitrary destructive actions.

## Work and triggers

Daily maintenance inspects upstream and the available issue/PR queue before selecting one coherent batch.
A half-hourly cheap sweep discovers ready PRs, changed upstream state, and interrupted publication without automatically spending on every tick.
Trunk pushes, PR lifecycle/review events, and manual dispatch provide additional observation opportunities.
Untrusted PR events never expose maintenance or publishing secrets.
Prevent self-trigger loops, repeated work on unchanged candidates, and repeated spending on deterministic environment failures.
Frequent invocations share bounded admission/accounting; unknown or interrupted usage reserves budget conservatively.
Manual check mode stays offline and unpaid.

## Integration and publication

Maintain a pinned base, candidate identity, reviewed tree, PR head where applicable, exact-tree gate receipt, integrated source identity, and verified image digest.
For a PR, deterministically prepare the full resulting diff against the reviewed base; do not present an empty checkout diff to the reviewer.
Keep PR content separate from unrelated maintenance edits.
Use a pinned non-force fast-forward PR integration only when the recorded base is an ancestor of the reviewed head and the reviewed and release trees match.
Check introduced history for protected-path changes and reject unsupported history shapes.
This protects pinned source identity but does not claim atomic GitHub PR-state or exact-base compare-and-swap semantics.
Honor newly enabled repository rules; block rather than using administrative bypass.
Persist reviewed source before publishing its image.
Publication retries reuse the original reviewed source and immutable version, not a new model batch.
A numbered-tag collision never permits overwrite.
A failed or rejected candidate cannot release.

## Observable and traceable

Actions summaries and explicitly selected sanitized artifacts are the reporting surface.
Distinguish no-op, skipped, invalid review output, substantive rejection, gate failure, integrated source with publication pending, republishing, abandoned, and verified release.
Executor and reviewer models are offered only the durable `codemode` tool, plus `submit_verdict` for the reviewer; their other tools are callable only from scripts, and scripts cannot start scripts.
Script `models.classify()` crosses the same budgeted provider boundary as chat: a priced upper bound from its serialized input is reserved and durably recorded before dispatch inside the same lease, budget, deadline, and call limit, settles from reported usage, and stays held when usage is unknown.
Classifier calls never count as provider failure evidence, because scripts control their input.
Script `models.generateImages()` and every other unbudgeted dispatch path are refused; compaction's `completeSimple` goes through the budgeted path.
Models are told that classifiers serve cheap triage and give untrusted advice.
Nested shell calls use the same credential-free prepared environment as before.
A best-effort tool guard rejects writes outside the worktree, through escaping symlinks, or into `.git` and the protected harness/CI paths, and shell commands that would bypass host commits, pushes, tags, history, Git configuration, registry publication, GitHub effects, or credential use, each with a corrective reason; post-hoc source checks remain authoritative.
Untrusted tool output (intake, sandbox runs, persisted plans, remote fetches) reaches models between per-run random-id markers that content cannot forge, without changing exit codes or JSON structure.
The reviewer ends its review by calling `submit_verdict` once with a closed bounded schema: findings (`id`, `severity` blocking|advisory, optional `file`/`line`, `impact`, `evidence`, `correction`) and what it `checked`.
The host derives approval from the durable tool record, never from answer text: approve iff exactly one valid call recorded no blocking finding.
A reviewer run ending without a verdict gets exactly one reminder within the same run, paid budget, and deadline; a second miss, or a repeated verdict, is invalid review output.
Allow reviewer responses up to 32,768 output tokens and executor responses up to 16,000, each clamped to the selected model's limit.
Reserve an upper bound on the maximum output the provider adapter sends before dispatch, phase ceiling plus any thinking budget it may add, inside the unchanged shared budget and original deadline; provider errors settle at that reservation.
Retain bounded stop-reason, text-length, verdict, and verdict-call-count diagnostics, not raw reviewer answers.
Retain each executor turn's final stop reason and whether it hit the output cap; a capped final answer gets exactly one continuation per executor conversation asking for a shorter script.
The reviewer may execute targeted checks only in a disposable offline rootless container over a read-only export of the recorded tree T, never in the maintenance worktree.
Sandbox containers get no network, credentials, or host environment, a read-only root, bounded time, memory, CPU, and PIDs, and are always removed.
Preparing the sandbox builds the fixed gate images from T before review, with network but without credentials; this runs candidate build steps earlier than the gate, approves nothing, and its failure only disables `run`.
Priming starts only when the deadline still holds the review window plus a reserve for the fixed gate; otherwise the sandbox reports unavailable and review stays read-only.
Priming and the fixed gate build from identical private exports of the recorded tree, so the gate tests exactly that tree and reuses the primed layers.
A review whose sandbox container cannot be removed reports that, keeps a recorded verdict, and fails only without one.
A per-review probe may drop only undelegated cgroup resource limits; it never drops network, read-only source, or environment isolation, and reports `available`, `limited`, or `unavailable` with a bounded reason, Podman version, and run count/seconds in the public report.
For candidates changing `client/` or `web/`, the reviewer may render the candidate's own panel headlessly with `ui_snapshot`: offline, non-root, without host mounts, with a throwaway database and a per-run random admin, inside the same sandbox time budget.
Rendered pages and screenshots are untrusted data; console, exception, and network signals come before screenshots, and pixel differences never block without a concrete user-facing problem.
The public report records visual review as `available`, `unavailable`, or `skipped` with a bounded reason, browser version, and snapshot count.
When the reviewer model has no image input, `ui_snapshot` still returns text signals and says that screenshots were omitted.
After review the host requires the worktree candidate to still equal T; otherwise the verdict is discarded as invalid review output.
Clear prior usage completeness before model dispatch or resume; active-model and explicitly interrupted reports cannot settle partial subtotals.
Intermediate review checkpoints remain unknown-cost until final accounting is refreshed.
Invalid review output remains a bot failure with no gate, source commit, or publication.
Permit at most one in-run fixed-gate diagnosis/repair for an approved maintenance source candidate, never a PR or management-only task.
Start a repair only while at least 75 minutes remain before the run deadline; otherwise keep the gate failure and report the skipped repair.
Require unchanged candidate identity, a failure event from that exact gate invocation, and a bounded regular private log inside the owned run directory; missing, stale, symlinked, or ambiguous evidence cannot authorize repair.
Name private evidence by the gate invocation's event boundary so a pre-checkpoint orphan cannot block a later fresh capture or be reused as current evidence.
Persist the consumed repair allowance, invalidate reviewer and management approval, and clear usage completeness before another dispatch.
Detach run data deeply from SDK-owned snapshots before mutation so checkpoint changes reach SQLite, including after restart or recursive repair.
Preserve the original task, request/accounting identity, lease, deadline, and budget; charge only newly incurred usage and accumulate both cycles' phase costs.
Give the executor the private failure log as untrusted data and restrict it to diagnosis or a safe correction of that failure, not a new maintenance sweep or weaker checks.
Use a fresh independent reviewer on the entire resulting candidate and plans, then rerun every fixed gate before source persistence.
Another failure or rejection ends repair; no raw logs, private evidence paths, or source diffs enter public reports.
Host commits carry a subject naming the day and main change, at most 72 characters, plus a body of at most 2 KiB built from the executor's final summary, the reviewer's checks and advisory findings, and host facts such as the pinned upstream merge or harness incident.
Model text in commit messages is redacted like reports, stripped of control characters, wrapped at 72 columns, never placed where Git reads a trailer, and labelled unverified.
The exact message is checkpointed before the commit, and recovery accepts an interrupted commit only with that exact message.
Report reasons, bounded reviewer findings, relevant issue/PR identifiers, source/tree hashes, phase and gate timings, model usage/cost, and publication receipts.
Retain useful failure diagnostics even when execution throws or the runner is interrupted.
Never upload raw model transcripts, SQLite, environment dumps, credential files, or unchecked command logs.
Redaction is defense-in-depth, not an OS sandbox or a guarantee that arbitrary model prose is safe.

## Efficiency and personality

Validate the exact private container storage configuration before paid model requests.
Stay provider-independent through Pi's normal model runtime, standard provider credentials, and pi-ai error classification, with no provider or model special-cased in code.
Work with whichever pi-ai provider API keys are configured; CI forwards every pi-ai provider credential name and known companion explicitly, never the whole secrets context.
Choose models as Pi does: optional `enabledModels` preference first, then Pi's saved default, then each authenticated provider's Pi default model in Pi's order; no hand-curated model list.
Use the first available candidate with known pricing; independent review prefers a candidate from a different provider.
Fail closed when no candidate is available.
After a provider error pi-ai never retries, or a transient one once Pi's retry policy is spent, move work to the next available model inside the original lease, cap, and deadline.
Never re-dispatch to an exhausted provider within the run; deterministic provider failures are environment failures, not hourly retries.
Remember provider quota and auth failures across runs as bounded provider holds until the stated reset or 24h, cleared by a config change; skip held providers, and admit no paid work while every known provider is held.
Keep model budgets and process deadlines; do not weaken checks to obtain a green run.
Prefer an honest no-op over speculative changes or decorative activity.
Remember review-rejected maintenance candidates for 30 days in the trusted checkpoint by changed-file area and blocking finding ids, show them to the executor as untrusted intake, and refuse before review, as the normal no-op outcome `repeat-rejected`, a candidate whose area was rejected twice within that window.
Use Annie's concise, cheerful maintainer voice in summaries while keeping failures and consequences unmistakable.
Never describe a no-op as a source or image publication.

## Harness self-repair

When Annie's own machinery fails, she reports it and, where she can, proposes a reviewed fix that only Oliver merges.
Observe derives incidents model-free from trusted evidence it already holds and failed jobs of trusted runs within 24h, except failures a later green trusted run supersedes by running the same job successfully; review rejections, product gate failures, model failures, honest no-ops, and a quota hold while another provider works are not incidents.
Incident fingerprints cover kind and identity, never timestamps; the checkpoint deduplicates at most 20 strictly validated entries.
After two observations, a model-free job with the native token and `issues: write` keeps one `annie-incident` issue per fingerprint by hidden marker and complete bounded lookup, with sanitized facts only, and closes it once the incident clears.
A repairable incident admits a `harness` task at most once per incident and trusted policy, within allowance and providers, under a $5 cap and without a calendar slot.
Its executor sees a bounded redacted incident digest as untrusted spotlit data and must never weaken checks, budgets, or security boundaries.
A harness PR's own `pull_request` workflows run with a token whose read-only default a `permissions:` key overrides, and trunk is unprotected.
So a candidate may change only `tools/maintainer/**` and `.github/workflows/honest-annie.yml`, whose top-level `on:` and key set stay deeply equal to the base's; every other `.github` change is refused.
One shared function enforces that rule at the executor guard (paths), the maintain snapshot, the harness gate, CI import, and delivery before any PAT use.
A fresh independent reviewer reads the full diff read-only; the fixed harness gate (npm ci, npm test, bash -n, workflow YAML parse, actionlint) replaces the product gates, with at most one in-run repair.
The harness gate reruns on a fresh credential-free runner; a separate model-free step that never executes candidate code verifies the bundle, pushes it to `annie/harness/<fingerprint>`, and opens a PR against trunk with `ANNIE_GH_TOKEN`.
Harness candidates never reach trunk, the registry, or management, and every delivery outcome is a receipt plus an incident comment, never a silent drop.
Annie never admits, reviews for integration, or integrates `annie/harness/*` PRs or any PR touching protected paths, and refuses them before paid admission.

## Selected-task integration interface

`PUFFER_MAINT_TASK` is strict trusted JSON selected before model execution and delivered unchanged to the release/management job.
Schema and CLI ordering are binding as documented in README's selected-task contract.
Own repo/ref are exactly `bugabinga/pufferpanel` / `refs/heads/trunk`; original B/H/U cannot be inferred from paid mutable artifacts.
PR routing uses native read-only preparation, no coding executor, complete B→T read-only review, fixed source gates, and synthetic C with exact parent `[B]` and tree(C)=tree(H)=T.
PR introduced history must be linear, descend from B, and contain no introduced `.github` or `tools/maintainer` changes, even reverted changes.
Current GitHub trust/lifecycle/head/check/rules reads fail closed, with explicit bounded-pagination failures; a protected branch or any effective rule blocks automatic integration.
Fresh job import verifies both bundled C and H, complete ordered parents, trusted upstream U, and exact tree/history before independently rerunning fixed gates.
Actual PR source persistence pushes only H using native token and non-force explicit trunk refspec.
A trusted private temporary pre-push hook validates advertised old OID against observed ancestry, preventing deleted refs, rewind, or independent advancement between observation and push.
Already-H reconciliation remains model-free and does not depend on the PR remaining open.
Source receipt and current remote identity must be verified before registry login and publication.
Publisher builds detached actual source H, with exact reviewed tree T and OCI revision H; reports keep C and H distinct.
Calendar numbered tags remain immutable, so a second distinct revision on the same UTC date may persist source but cannot replace that day's image.

## Reviewed GitHub management

Management-only approval stops at `managing`, exits successfully, and never runs source gates, creates a source commit, or publishes an image.
Only current-run bounded independently approved canonical plans cross jobs as a publication-safe sanitized hash-bound operational artifact, separate from public reports.
Host execution rechecks whole-plan hash/repo/source/approval, exact current target identity/open state/updatedAt, admin permission class for `enable-issues`, and bounded idempotence coverage; native-token mutations let their HTTP status decide.
Native token executes ordinary allowlisted operations; admin token is restricted to explicitly reviewed `enable-issues` from a selected management task.
No arbitrary API endpoints, destructive actions, protection changes, visibility changes, collaborator changes, or automatic issue enabling are permitted.
Source plus plans executes management after publication, and still after verified source persistence when registry login or publication failed.
Management is best-effort: failed receipts are reported, the step succeeds, and receipts never gate release, publication, or the queue.
While intake reports issues disabled (`has_issues: false` or HTTP 410), proposals cannot create issues or target non-PR issues.
Posts identify Annie as an automated maintainer and use stable hash markers excluding volatile updatedAt; labels reconcile the desired set.
Retries never duplicate when complete lookup coverage proves an earlier marker, and fail closed when lookup is truncated or unknown.
Optional PR rejection feedback is host-generated `COMMENT` at exact current H from substantive trusted read-only reviewer findings only; invalid review output is bot failure, not PR blame.
Public reports contain identities, diagnostics, model costs, publication state, and action receipts, never plan bodies, raw snapshots, transcripts, reviewer answers, unchecked logs, or credential values.
Plan hashes are integrity checks, not signatures or an OS sandbox; trusted workflow artifact provenance and credential-step isolation remain mandatory.
GitHub state checks and API posts/pushes are not one atomic transaction; live role/openness cannot be atomically asserted with Git push.

## Admission and accounting

Only attempt 1 may pay, with a prepaid immutable lease verified by artifact ID/digest before provider dispatch.
The absolute paid horizon is original GitHub run creation plus two hours, including queued/preflight time and cancellation margin.
Each lease cap is at most $15 and at most remaining shared rolling-24h allowance.
A host-owned durable call intent precedes each provider dispatch, priced for the physical model actually sent; only a completed valid response with pi-ai usage settles it at its normal final usage cost.
Partial SSE, provider errors, cancellation, missing usage, synthetic zero errors, and missing final reports never refund partial spend.
A provider error response settles at its full call reservation, so a recovered retry or failover can complete the phase; cancellation, interruption, and missing usage stay unknown.
Complete known actual cost replaces the lease cap, held for 24h from original final model-report artifact creation.
Release reports never create a second charge or move that billing timestamp.
Unknown/partial usage reserves the entire cap until the absolute deadline plus 24h and termination margin, with nonterminal execution held conservatively.
Native reads cover bounded complete run/artifact pagination; missing provenance, duplicates, malformed/oversized archives, expired active artifacts, and coverage limits prohibit new paid work.
Historical charges remain accounted when current trusted policy changes.
Only two accounting record types exist: prepaid lease and sanitized final settlement report.
Call usage is configured-pricing/token evidence, not provider billing-account confirmation or a tamper-proof financial ledger.
Administrators deleting runs/artifacts or changing trusted code/secret/environment policy cross the operational trust boundary.

Healthy cheap sweeps refresh a small sanitized decision checkpoint for current PR fingerprints, latest handled maintenance identity, calendar slots, and pending-effect metadata.
PR fingerprints bind number/H/B/policy, excluding clock/upstream/reviews/attempt IDs.
Ordinary rejection and deterministic preparation failure remain handled until relevant input changes.
Missing or expired checkpoint state blocks admission rather than silently resetting deduplication; initial bootstrap must be explicit.
Management-only tasks cannot change source/history or reserve an image slot.
Source work reserves one calendar opportunity before pay; terminal verified no-source work releases it, while an approved unpersisted source with a live candidate and fewer than three effects attempts blocks new source work across UTC midnight.
Source is released iff a release report proves publication digest, persisted source, and matching release commit; a management-only record is terminal once any completed release report exists.
Unpersisted work with a missing or expired candidate or an exhausted effects ceiling becomes `abandoned`: reported, non-blocking, and not handled, so later batches may redo it.
All source/report paths use frozen selected-task day.
Approved effects recovery uses only an existing known model-free release job, rechecks enablement and protected policy, has a three-attempt ceiling and 30-minute cooldown, and never requests rerun-all or rerun-failed.
Persisted but unpublished source never blocks: anonymous registry evidence marks it released, superseded by a newer `latest` or tag collision, or a model-free republish candidate.
Republish runs only from attempt-1 paid-capable observation without admitting paid work in that run, uses a trusted current harness on a detached release-commit worktree, reruns every fixed gate, and is bounded to three attempts with a 30-minute cooldown before `abandoned`.
Republish requires an unprotected rule-free trunk, the trusted checkout's protected policy equal to current trunk's, and the release commit reachable from current remote trunk; the release commit's own harness is build input only and never executed.
Unknown registry or compare answers hold only that record and are reported; transient GitHub controller reads retry twice on network error, 5xx, or 429, never on 4xx.
Unpaid observe/sweep cannot dispatch a retry.
Current branch/rules policy blocks ordinary maintenance pushes as well as PR pushes; no bypass exists.

## Acceptance evidence

Offline tests cover source protection, real temporary Git/SQLite recovery, invalid/rejected reviews, diagnostic redaction, exact-store preflight, trusted-author admission, head/base races, retryable publication, trigger deduplication, budget admission, credential-based model selection from Pi defaults and `enabledModels`, cross-run provider holds, the forwarded provider env list against pi-ai's mapping, and in-lease provider failover.
Offline tests cover budgeted script classifiers, refused image generation and raw dispatch, commit message composition, bounds, redaction, and interrupted-commit recovery, and rejection memory accumulation, expiry, intake, and host refusal.
Shell and workflow validation pass.
Offline tests cover incident detection and dedupe, idempotent incident issues against a fake GitHub, harness task schema and caps, guard selection, the harness gate runner, a faux harness run through export, PR delivery success and failures, and self-integration refusals.
Fake-Podman tests cover reviewer sandbox flags, environment, freezing, output capping, timeout/abort cleanup, and the per-review time budget.
Fake-Podman tests cover `ui_snapshot` isolation flags, priming decisions, caps, budget sharing, the skipped and unavailable paths, and the result schema; a faux review shows a screenshot to the model with `image()`.
A real isolated short-runroot container preflight succeeds without changing host configuration.
Check-only CI verifies the uploaded harness without model requests or production effects.
Live paid maintenance, PR integration, registry publication, and GitHub administration require separately recorded execution evidence; offline fixtures do not prove them.
