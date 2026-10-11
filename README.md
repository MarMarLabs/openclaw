# Proof-only CI: OpenClaw #137233 and #137250

This orphan branch contains only a disposable evidence harness. It is not a PR,
release, production-code change, or request to publish comments. PR branches are
never mutated. An explicit dispatch on this branch runs two bounded, independent jobs.
The branch-local definition uses the fork's already registered Package Acceptance
workflow path; neither the default branch nor its workflow definition is changed.

Product source is pinned to the full PR head commits in the workflow and harness.
Every contributor-controlled build, package, install, and CLI command executes in
an unprivileged Docker container on a GitHub-hosted runner. Only source, harness,
and task-owned scratch mounts are supplied. No Docker socket, runner home,
repository/environment secrets, GitHub token, credential cache, service, or live
account state is passed into the container. Checkout credentials do not persist;
workflow permissions are contents:read. Capability commands use --network none.

The canonical packer explicitly composes Slack (and Discord for paired selector
controls) from the same pinned source into the candidate. This supported custom
distribution differs in plugin composition from the stock core-only tarball;
production source and the candidate version are not patched or relabeled.

For #137233, exact blank/whitespace failure reasons are paired with omitted
channel, agent, target, and account controls. Offline health probe failures are
not confused with selector failures. Historical transcripts remain separate.

For #137250, both partial and explicit empty account actions start on published
2026.10.1. The installed stable updater is invoked with the unmodified-version
2026.9.9 candidate. This is **downgrade/replacement**, never forward upgrade proof.
Each case saves pre/post config bytes, hashes, whole-config comparison, changed
top-level keys, operator Slack/Gateway equality, installed identities, and CLI
action lists. Metadata changes remain visible, not silently normalized away.
No message, reaction, or other Slack action is sent. Availability means discovery,
not live delivery. Genuine forward-upgrade validation remains outstanding.

`evidence/summary.json` lists individual checks, command argv, exit codes, wall
times, and output files. `transcript.md` assembles the exact captured outputs.
An earlier phase failure means later scenarios were not run, even if artifact
upload succeeds. The workflow fails for failed/incomplete executed cells and
always attempts artifact upload. Do not interpret a green workflow as approval
of the version mismatch or the maintainer's separate compatibility decision.

Harness validation: Node syntax check, Git whitespace check, independent review,
then the actual isolated workflow. No dependencies are added to either PR.
