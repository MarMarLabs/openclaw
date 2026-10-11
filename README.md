# Proof-only CI: OpenClaw #137250 forward upgrade

This orphan branch contains a disposable evidence harness, not product changes.
The dispatch-only workflow runs only Slack; #137233's passed evidence from run
38151741290 is preserved without rerunning its unchanged inputs.

The source candidate is `b682ad79204c585b345e1628746679812df81a00`:
upstream published beta `f283c3c71226c2e1d9ca06b11972f8bdb3969bd8` plus the exact
five-file #137250 delta. The actual version remains `2026.10.5-beta.1`.
Base, delta SHA-256, candidate SHA, package integrity, and harness SHA are recorded.
This supplementary integration is not the unchanged PR head `ec516390d975...`.
No release identity is invented, and no release is published.

Every contributor-controlled test, build, package, install and CLI command executes
inside an unprivileged Docker container on a GitHub-hosted runner. Only source,
harness and task-owned scratch are mounted. No Docker socket, runner home,
repository/environment secret, GitHub token, credential cache or live account
state enters the container. Checkout credentials do not persist and workflow
permissions are contents:read. Capability commands use `--network none`.

The candidate runs the three focused Slack tests and the canonical changed-file
checks against its beta parent, including lint/types/guards, before packaging.
The canonical packer produces a core package without adding bundled Slack.
The repository's prepublish-plugin-registry artifact creator builds the matching
external Slack package. Its existing in-container registry wrapper verifies the
sealed manifest and serves that companion through the normal npm updater cohort.
The registry is test-local; no upstream publication or account permission changes.

Both partial and explicit empty account action fixtures start with actual published
core `2026.10.1`, embedded commit `e178c39e9aae3fa440735217f9aef9574f286677`,
and official Slack `2026.10.1` with npm integrity checked. The normal
`@openclaw/slack@latest` selector is recorded; a different resolved baseline fails.
This differs from the previous run's explicit `--pin` selector, without attributing
the previous ownership failure to pinning. The installed stable driver runs first:

```sh
openclaw update --channel beta --tag /app/package/candidate.tgz --yes --no-restart --json
```

Each scenario requires updater exit 0, candidate core commit/version, external
Slack archive integrity/provenance, exact resulting capabilities, unchanged
explicit actions and operator configuration. Full config snapshots and every
leaf difference remain visible. Only exact Doctor metadata and the requested
beta-channel change are permitted; unexpected changes fail. Persisted plugin
indexes are captured before and after, including install ownership.

No Slack messages, reactions or other live actions are sent. Availability means
CLI capability discovery, not live delivery. The previous `2026.10.1 -> 2026.9.9`
external-to-bundled downgrade remains a failed transaction, never an upgrade pass.

`summary.json` records assertions, exact command argv, timestamps, elapsed time,
exit status and output filenames. `transcript.md` includes the captured streams.
Failed/incomplete scenarios fail the workflow; artifact upload always runs.
Actions artifacts expire after 30 days. A concise actual command/result transcript
is intended for durable PR text, linked to full artifacts and immutable sources.

Local harness checks: Node syntax, Bash syntax, Git whitespace and independent
review. Product execution is confined to the isolated workflow.
