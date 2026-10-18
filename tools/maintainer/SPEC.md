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
Optional ANNIE_GH_TOKEN belongs only to trusted release/management steps; model tools never receive it.
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
Distinguish no-op, skipped, invalid review output, substantive rejection, gate failure, integrated source with publication pending, and verified release.
Require a complete reviewer response matching the strict JSON verdict schema.
Allow reviewer responses up to 32,768 output tokens, clamped to the selected model's limit; executor responses remain capped at 4,000 tokens.
Reserve the full phase-specific output ceiling before dispatch, inside the unchanged shared budget and original deadline.
Permit at most one same-reviewer format correction for malformed or incomplete output, within the original paid budget and deadline; never retry substantive rejection or contradictory findings as formatting.
Retain bounded stop-reason, text-length, and verdict diagnostics, not raw reviewer answers.
Recognizable substantive or contradictory rejection remains terminal even when the provider marks that response truncated.
Clear prior usage completeness before model dispatch or resume; active-model and explicitly interrupted reports cannot settle partial subtotals.
Intermediate review/format-correction checkpoints remain unknown-cost until final accounting is refreshed.
A second invalid or incomplete response remains a bot failure with no gate, source commit, or publication.
Permit at most one in-run fixed-gate diagnosis/repair for an approved maintenance source candidate, never a PR or management-only task.
Require unchanged candidate identity, a failure event from that exact gate invocation, and a bounded regular private log inside the owned run directory; missing, stale, symlinked, or ambiguous evidence cannot authorize repair.
Name private evidence by the gate invocation's event boundary so a pre-checkpoint orphan cannot block a later fresh capture or be reused as current evidence.
Persist the consumed repair allowance, invalidate reviewer and management approval, and clear usage completeness before another dispatch.
Detach run data deeply from SDK-owned snapshots before mutation so checkpoint changes reach SQLite, including after restart or recursive repair.
Preserve the original task, request/accounting identity, lease, deadline, and budget; charge only newly incurred usage and accumulate both cycles' phase costs.
Give the executor the private failure log as untrusted data and restrict it to diagnosis or a safe correction of that failure, not a new maintenance sweep or weaker checks.
Use a fresh independent reviewer on the entire resulting candidate and plans, then rerun every fixed gate before source persistence.
Another failure or rejection ends repair; no raw logs, private evidence paths, or source diffs enter public reports.
Report reasons, bounded reviewer findings, relevant issue/PR identifiers, source/tree hashes, phase and gate timings, model usage/cost, and publication receipts.
Retain useful failure diagnostics even when execution throws or the runner is interrupted.
Never upload raw model transcripts, SQLite, environment dumps, credential files, or unchecked command logs.
Redaction is defense-in-depth, not an OS sandbox or a guarantee that arbitrary model prose is safe.

## Efficiency and personality

Validate the exact private container storage configuration before paid model requests.
Keep model budgets and process deadlines; do not weaken checks to obtain a green run.
Prefer an honest no-op over speculative changes or decorative activity.
Use Annie's concise, cheerful maintainer voice in summaries while keeping failures and consequences unmistakable.
Never describe a no-op as a source or image publication.

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
Host execution rechecks whole-plan hash/repo/source/approval, exact current target identity/open state/updatedAt, permission class, and bounded idempotence coverage.
Native token executes ordinary allowlisted operations; admin token is restricted to explicitly reviewed `enable-issues` from a selected management task.
No arbitrary API endpoints, destructive actions, protection changes, visibility changes, collaborator changes, or automatic issue enabling are permitted.
Source plus plans executes management after verified source persistence and before registry login.
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
A host-owned durable call intent precedes each provider dispatch; only a completed valid response with usage settles it.
Partial SSE, provider errors, cancellation, missing usage, synthetic zero errors, and missing final reports never refund partial spend.
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
Source work reserves one calendar opportunity before pay; terminal verified no-source work releases it, while an approved pending source blocks new source work across UTC midnight.
All source/report paths use frozen selected-task day.
Approved effects recovery uses only an existing known model-free release job, rechecks enablement and protected policy, has a three-attempt ceiling and 30-minute cooldown, and never requests rerun-all or rerun-failed.
Unpaid observe/sweep cannot dispatch a retry.
Current branch/rules policy blocks ordinary maintenance pushes as well as PR pushes; no bypass exists.

## Acceptance evidence

Offline tests cover source protection, real temporary Git/SQLite recovery, invalid/rejected reviews, diagnostic redaction, exact-store preflight, trusted-author admission, head/base races, retryable publication, trigger deduplication, and budget admission.
Shell and workflow validation pass.
A real isolated short-runroot container preflight succeeds without changing host configuration.
Check-only CI verifies the uploaded harness without model requests or production effects.
Live paid maintenance, PR integration, registry publication, and GitHub administration require separately recorded execution evidence; offline fixtures do not prove them.
