# honest_annie

Minimal project-specific maintenance bot around Pi Durable, not a new agent platform.
GitHub Actions integration is `.github/workflows/honest-annie.yml` on fork default branch `trunk`.
Desktop scheduling templates remain optional, uninstalled, and inactive.
No klops auto-update configuration is changed.

## Flow

Daily timer → isolated persistent worktree → bounded maintenance agent → independent read-only reviewer → fixed gates → host commit → numbered image → `latest`.
No useful changes → no commit or release.
A rejected draft remains in the maintenance worktree for the next daily batch.
Desktop mode never pushes Git remote refs.
CI release mode pushes only the reviewed commit to fork `trunk`, without force or overwriting an independently advanced branch.

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
Each UTC day has one idempotent input request ID and at most one changed release.
SQLite checkpoints retain execution, reviewer identity, reviewed tree/hash, commit, version, and publication phase.
An interrupted commit is accepted only when tree, parent, subject, and cleanliness prove it is the same reviewed commit.
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
Workflow: `honest_annie`; daily schedule: 04:17 UTC, subject to GitHub scheduling delays.
Fork scheduled workflows must be enabled; GitHub can disable schedules after 60 days without repository activity.
`HONEST_ANNIE_ENABLED` repository variable must equal `true` for any paid maintenance run.
Initial setup leaves it `false` until credentials are configured.
Manual `workflow_dispatch` defaults to `check`: offline harness tests only, no secrets, model requests, image publication, or Git writes.
After setting credentials, select `maintain` to run a real bounded maintenance batch.

Configure two environments, each restricted to deployment branch `trunk`:

- `honest-annie-model`: secret `ZAI_API_KEY`, from a Z.AI account entitled to GLM-5.3 on its coding endpoint.
- `honest-annie-release`: secrets `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`, scoped to publishing `registry.bugabinga.net/pufferpanel`.

No PAT or extra bot account is needed.
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
PR/push events run offline harness checks only; maintenance secrets never run against PR code.

Hosted runners retain SQLite and local drafts only within a job.
Runner loss or a failed maintenance job discards its draft and checkpoints; the next maintenance job starts fresh from `trunk`.
The `$15` model budget applies per hosted maintenance job; manually rerunning maintenance starts a fresh budget.
The model/gate wrapper has a two-hour deadline; the separate no-model release job has its own timeout.
Successful maintenance artifacts are retained seven days, so rerun only a failed release job to reuse the exact commit/version without more model spend.
Do not rerun the whole workflow as a publication retry: it can create a different same-day candidate and encounter an immutable version collision.
The numeric daily version allows at most one image revision per UTC date.
Source may already be on trunk when registry publication fails; that is not evidence of deployment.
No desktop timer or klops deployment is activated by this integration.

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
