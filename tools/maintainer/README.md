# honest_annie

Minimal project-specific maintenance bot around Pi Durable, not a new agent platform.
GitHub Actions integration is `.github/workflows/honest-annie.yml` on fork default branch `trunk`.
Desktop scheduling templates remain optional, uninstalled, and inactive.
No klops auto-update configuration is changed.

## Flow

Daily timer → isolated persistent worktree → bounded maintenance agent → independent read-only reviewer → fixed gates → host commit → numbered image → `latest`.
No useful changes → no commit or release.
A failed fixed gate permits one maintenance-only diagnosis/repair using a bounded private log, inside the original budget and deadline.
Repairs revoke prior approval, get a fresh independent full review, and rerun every gate; PR tasks never acquire a coding turn.
A rejected draft remains in the maintenance worktree for the next daily batch.
Desktop mode never pushes Git remote refs.
CI release mode pushes only reviewed source to fork `trunk`, without force or overwriting independent advancement.
Maintenance pushes host commit C; selected PRs push original head H, never synthetic C.

Pi Durable `1.2.0`, Pi AI, Chord, and the coding-agent model runtime are pinned in `package-lock.json`.
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
An interrupted commit is accepted only when tree, full expected parent list, subject, and cleanliness prove it is the same reviewed commit.
An ordinary patch has exact parent `[base]`; a resolved upstream merge has exact parents `[base, pinnedUpstreamSha]` and only when `MERGE_HEAD` was that pinned SHA.
Pending publication is reconciled before a new daily batch, even after its original model deadline.
Interrupted non-replay-safe shell tools are reported as interrupted, not blindly rerun by the durable runtime.
Expired non-publication work is stopped; the next daily batch can inspect and finish the retained draft.
One local flock owns the storage; do not run this storage from multiple processes or hosts.

## Models and limits

Desktop executor and separate reviewer conversation use the configured Pi `ultra.providerModelTiers[defaultProvider].medium` model.
CI uses checked-in `ci-settings.json`: both conversations select exactly `zai/glm-5.3`, with supported `high` thinking.
The pinned Pi catalog includes GLM-5.3, its Z.AI coding endpoint, context limits, compatibility settings, and nonzero prices.
CI authenticates through the provider-native `ZAI_API_KEY` environment variable; no desktop auth/settings files are copied.
Missing configured models fail closed, rather than silently escalating or choosing another provider.
Existing Pi OAuth/API credentials and model overrides are accessed through `ModelRuntime`, never copied into prompts or logs.
Existing coding-agent extensions cannot be loaded unchanged into Pi Durable's distinct extension API.
Policies reuse Oliver's small-change preference, selected model tier, independent review, Git protection, and verified-release discipline.
Provider admission checks reported spend against `$15` and the persisted `2h` deadline before every request.
Requests reserve worst-case context/input plus 4000 output tokens using the model's quoted prices; unknown prices block dispatch.
The budget is based on provider-reported usage and quoted prices, not a guarantee about subscription billing or unreported work interrupted before a usage receipt.
The wrapper's two-hour process-group timeout includes tools, tests, builds, and publication; subsequent invocations may reconcile an already pending publication without spending on new model work.

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

- `honest-annie-model`: secret `ZAI_API_KEY`, from a Z.AI account entitled to GLM-5.3 on its coding endpoint.
- `honest-annie-release`: secrets `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, scoped to publishing `registry.bugabinga.net/pufferpanel`.

Ordinary source/PR/issue operations and model-free retry use native workflow tokens, not a PAT.
Optional `ANNIE_GH_TOKEN` belongs only to `honest-annie-release`, exposed solely when a selected management task explicitly approves `enable-issues`.
Issues remain disabled and trunk remains unprotected unless separately reviewed policy changes say otherwise.
Only the release job requests `contents: write`; repository default workflow permissions can remain read-only.
Do not enable Actions permission to approve pull requests.
Required reviewers are intentionally absent for unattended operation; adding an environment approval pauses the corresponding job.
If future trunk protection requires PRs or rejects GitHub Actions pushes, switch to a reviewed PR-based flow rather than bypassing protection.
Commit display name is `honest_annie`; GitHub authentication/attribution remains the native `github-actions[bot]` identity.

The maintenance job has a read-only GitHub token and only the ZAI secret during its model step.
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
CI validates private Podman storage after runtime preparation and before exposing `ZAI_API_KEY`, then always removes its explicit short runroot; release cleanup also removes registry auth.
Each model/release job writes a sanitized Actions summary and uploads only its explicit `report.json` for 14 days, including on failure; raw logs, transcripts, SQLite, environment data, and source diffs are not uploaded.
Reviewed bundles/plans remain separate explicitly approved 14-day artifacts, never blanket report/log uploads.
Rerun only a failed release job to reuse the exact commit/version without more model spend.
Do not rerun the whole workflow as a publication retry: the runtime and YAML prohibit new model calls on every attempt after 1.
The numeric daily version allows at most one image revision per UTC date.
Source may already be on trunk when registry publication fails; that is not evidence of deployment.
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

`kind` is `maintenance`, `pr`, or `management`; non-PR tasks omit `number`, `head`, and `author` entirely.
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
6. If `management=true`, run `ci.sh management` after source persistence, before registry authentication.
7. Only then expose registry credentials to `ci.sh registry-login`, followed by `ci.sh publish`.
8. Always collect sanitized report/receipts, then cleanup temporary registry auth/runroot.

`registry-login` refuses any authentication effect without independent exact-tree gates, matching source receipt, and matching current remote trunk.
The workflow invokes this guard after native source persistence and optional approved management, never direct unguarded Podman login.
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
Missing auth or unknown permission class fails clearly without credential values.
Labels read current desired state; posts use stable markers excluding volatile timestamps, with complete bounded lookup coverage; stale targets skip visibly.
Read/post races cannot be made atomic by GitHub comments API; timestamps are re-fetched immediately before mutation.
No automatic issue enabling or repository-setting change occurs by default.
Optional `ci.sh feedback` consumes only substantive rejected read-only reviewer findings, posts idempotent `COMMENT` review at exact current H, and rechecks lifecycle/head.
Malformed/contradictory review output never blames the PR or executes rejected proposals.
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
Intake bodies remain ephemeral; checkpoint hashes contain no issue/PR bodies, titles, transcripts, or reviewer findings.
Issue title/body/state changes can be useful inputs; labels/comments alone never create an own-effect paid loop.
Exact own source H is acknowledged without swallowing a concurrent human source commit.
PR fingerprints bind number/H/B/protected-policy identity and exclude clock, upstream, review timestamps, and attempt IDs.
Only currently ready trusted PRs passing native role/check/rule reads are considered before pay.
A daily quality round may honestly no-op; identical handled inputs never force source churn.
The calendar slot is reserved before model execution; verified terminal no-source reports release it, while approved source keeps its immutable slot and blocks replacement work.
Management-only work never consumes that slot.
Anonymous registry HEAD must prove the numbered tag absent before new source admission; collision or unknown availability prevents pay.
Pending approved source/management effects take priority across midnight and suppress fresh model work.
Missing approved candidate artifacts are blockers, not permission to buy a replacement candidate.

Lease artifact: `annie-lease-RUN_ID-1`, expected file `lease.json`.
Final model settlement: `honest-annie-model-report-RUN_ID-1`, expected file `report.json`.
Effects reports: `honest-annie-release-report-RUN_ID-ATTEMPT`; they never contribute additional model charges.
Decision checkpoint: `annie-checkpoint-RUN_ID-1`, refreshed by healthy unpaid sweeps with 14-day retention.
Approved candidate: `honest-annie-candidate-RUN_ID-1`, always reused by selective effects retries.
Artifact transport verifies immutable IDs/digests, bounded ZIP contents, and HTTPS storage redirect hosts; native API auth is never forwarded to storage.
Known complete actual cost replaces cap reservation and is held 24h from original final model-report artifact creation.
Unknown/partial/interrupted cost holds the entire cap through original creation + 2h + 24h + 5min; nonterminal execution is held more conservatively.
The provider boundary persists at most 256 request-scoped call intents before dispatch and settles only valid completed responses with explicit raw `prompt_tokens` and `completion_tokens` counters.
The installed OpenAI adapter invokes `onProviderStreamEvent` before normalizing usage; the wrapper retains validated scalar counters only, forwards the previous callback, and accounts optional cache-read/write counters using caller-configured prices.
Missing, empty, partial, invalid, errored, or interrupted SSE usage never settles, even when the adapter returns a successful normalized zero-usage message.
Provider client retries are disabled with `maxRetries: 0`; every new paid retry requires a fresh original-attempt run and ordinary admission.
`usageComplete`, `knownSubtotal`, call count, cap, absolute deadline, lease hash, and optional `modelFailure` (`environment` | `transient`) are sanitized report metadata.
Default desktop limits remain $15/2h; hosted allowance can only tighten them.
These are configured token/pricing statistics, not authoritative provider invoices or a tamper-proof financial ledger.
Artifacts and prompts are not an OS sandbox; repository administrators deleting history or changing trusted policy cross the operational boundary.

`controller.mjs retry` uses only a known `Annie effects (model-free)` job ID, native `actions: write`, matching original/current protected-policy trees, current enablement, and current unprotected branch/rules.
It dispatches asynchronously without waiting under the trusted concurrency group, never uses generic rerun-all/rerun-failed, waits at least 30 minutes, and stops after attempt 3.
Legacy policy, exhausted attempts, missing approved evidence, and superseded source are deferred without rollback or a new paid batch.
Every effect command independently rechecks current enablement/protected policy during hosted reruns.
`controller.mjs verify-upload` verifies the prepaid artifact before the first provider credential/model step.
`ci.sh management-check` validates the canonical plan and emits `adminAction` before any admin credential is exposed.

History discovery covers a rolling 33-day created horizon: GitHub's 30-day rerun window plus accounting/termination tail.
Filtered windows recursively shard below GitHub's 1000-result cap; each window requires complete stable pagination, with one-hour minimum windows failing closed on saturation.
Lifetime history beyond 10,000 runs does not exhaust admission coverage.
Healthy observations download recent accounting artifacts and checkpoint-carried outstanding IDs, including older nonterminal executions fetched individually.
Pending receipts preserve original lease identity, sanitized settlement, candidate metadata, and original artifact timestamps across 14-day artifact expiry.
Expired/missing candidate packs and exhausted effects retries remain visible blockers; receipt refresh never manufactures approval or completion.
An expired original lease on an old-created recent rerun retains unknown spend without crashing observation; an unsupported expired candidate identity is carried as an explicit blocker rather than silently forgotten.
Bounds remain 999 counted records/window, 198 current PRs, 200 handled fingerprints/outcomes, 20 outstanding receipts/flights, 32 calendar slots, and 256KiB ZIP/128KiB JSON payloads.
Admission records an in-flight task, not terminal handling; verified original-attempt job/step evidence that the model-capable step was skipped releases the flight/calendar slot without charging a lease.
Manual check mode itself remains fully offline; later native observers establish zero dispatch from job metadata, never from the event name alone.
Only valid no-op, substantive rejection, or approved work acknowledges maintenance inputs; invalid review output and transient failures remain bot retries, bounded to three attempts per fingerprint with one-hour backoff.
Exact host-classified PR source refusals (`sourceRejection`: `unsupported-history`, `protected-history`, `non-descendant`) cache until source input changes; stale qualification and transport errors do not.
Environment failures share a 24-hour cooldown across candidates; actual trusted policy/enablement/config-revision changes reset environment gating.
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
Go runs in the glibc Docker test stage with built frontend embeds, not an Alpine container missing gcc/game compatibility/assets.
The successful gate receipt identifies the exact Git tree, not a reusable boolean success marker.
Only the host creates a commit after independent JSON approval with zero findings and unchanged candidate identity.
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

## Trust and tests

The executor uses an operator-trusted local shell with the operator's OS permissions.
Prompts and protected-path checks are policy defenses, not an OS sandbox or credential-isolation boundary.
Use a dedicated restricted account/environment before enabling this against untrusted projects if stronger isolation is needed.
The reviewer has only a confined read tool and fixed diff tool, with no arbitrary shell or write tool.
Host gate/publisher copies come from the original harness directory, not the candidate checkout.
Offline tests use real SQLite and faux model/tool turns, real temporary Git worktrees/commits, and stubbed external publisher commands.
No paid maintenance run, live gate build, registry publication, system installation, or deployment is performed by those tests.
A separate live gate validation built the real node/glibc test images and passed frontend checks, Ace identity, full Go race tests, vet, and actionlint.
The uncached normal suite exposed an intermittent existing `TestServers_Restarts` failure (`server running`); the gate stopped without a release receipt, demonstrating fail-closed behavior.
Investigating that restart failure is an initial maintenance candidate, not a reason to bypass the gate.

## Research

[Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) documents SQLite recovery, request IDs, tool replay policy, extension registration, and usage accounting.
[Durable coding-agent example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/26-coding-agent.ts) supplies the built-in tools/environment pattern.
[Durable reviewer example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/28-reviewer.ts) supplies separate conversation/tool selection.
[Published package metadata](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.2.0) confirms the pinned experimental package release.
Installed operator Pi was `1.1.0`; this module does not upgrade that installation or `pi-ext` dependencies.
Experimental API changes require an explicit harness dependency update and tests, not an incidental daily self-update.
