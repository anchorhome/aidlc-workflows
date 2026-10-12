# Anchor patches

`anchor` = the latest upstream release tag + the patches below, one commit
each. `main` only mirrors `awslabs/aidlc-workflows` main. We keep this list
short: every patch is also offered upstream, and dropped here once an
upstream release includes it.

Base: `v2.11.0`. Check with `anchor/fork.sh status`.

## What earns a patch

Unblockers only: a bug or defect that stops our work, such as a deadlock, a
wrong result or a crash. Performance counts only when it is bad enough to
block us in practice. Slower-than-ideal but workable behaviour, designed
behaviour we would have chosen differently, and improvements stay out of the
fork. Each patch carries a test that fails without it. Keep the diff as small
as the fix allows, so rebases stay easy.

Considered and declined:

- Scoping the unit-major receipt floor to the jump target. A backward jump
  makes every per-unit stage re-mint its receipts. That is documented
  behaviour (construction protocol, "Re-entry settlement and review"), and
  with 0001 it costs a few quick receipt turns, not a block.

## 0001 Plan-approval guard admits unit-major re-entry receipts (dropped at v2.11.0)
Upstream v2.11.0 no longer deadlocks here: while a plan waits it admits the
design-stage `engine state unit` receipts (and, more broadly, other engine
moves the person or engine names). Our t265 case for it now fails only because
upstream admits more than our narrow patch did, not because anything is
refused. Dropped; nothing to carry.
## 0002 `testing-posture embed` writes the Testing Contract into a plan
- **Why:** the conductor hand-copies `testing-posture render` output into
  `code-generation-plan.md`. A copy turns the literal `\n` escapes in
  `applicable_notes[].text` into real newlines, the block no longer hashes to
  the current posture, and Plan Approval cannot be recorded (#334). Upstream's
  `replaceTestingContractSection` (after v2.11.0) re-renders a block made stale
  by a setting change, but a hand-damaged block still takes the repair branch.
  Hit on anchor-home `261011-testing-contract-embed`, 2026-10-11.
- **Change:** `core/tools/aidlc-testing-posture.ts` adds `embed --plan <path>`
  (`embedTestingContract`, fence-aware insert or in-place replace of
  `renderTestingContract(resolveTestingPosture(projectDir))`, idempotent; a
  missing plan throws and creates nothing). The verb joins upstream's shared
  `TESTING_POSTURE_SUBCOMMANDS` (`core/tools/aidlc-lib.ts`, added in v2.11.0),
  which now also builds the usage error. `core/tools/aidlc.ts` routes it.
  `core/hooks/aidlc-plan-approval-guard.ts` admits `embed` as a plan-approval
  prerequisite only when `--plan` resolves, lexically and by real path, inside
  the Code Generation record dir; every other guard outcome is unchanged.
- **Test:** `tests/unit/t-anchor-testing-posture-embed.test.ts`. It fails
  without the patch.
- **Upstream:** still needed at v2.11.0, whose Code Generation stage still has
  the agent paste the block by hand. Upstream main (after v2.11.0) adds
  `replaceTestingContractSection`, which re-renders only a block made stale by a
  setting change; reuse it for the splice once it ships in a release.
## Known upstream test failures (not ours)

`tests/unit/t343-swarm-checkpoints.test.ts` "lifecycle-gate withdraws batch
consent before an unrelated Approve" fails on stock `v2.10.0` too.
`tests/unit/t335-change-control-review-summary.test.ts` has 5 failures on
stock `v2.10.0` on this machine, identical with and without our patches:
four under "(2) summary confirmation" and one under "(4) an invalid memory Mode".

## Layout

- `anchor/fork.sh`: status, sync, rebase, test, build, overlay, install
- `anchor/overlay.mjs`: records and re-applies a project's own edits to
  shipped JSON (agent allowlists, MCP servers, CLI settings) across refreshes
- `anchor/tests.txt`: test files that cover these patches

## Updating to a new upstream release

```sh
anchor/fork.sh sync                 # mirror upstream main and tags
anchor/fork.sh rebase vX.Y.Z        # move our patches onto the release
anchor/fork.sh test                 # typecheck, determinism, patch tests
# edit this file: drop patches upstream now includes, update Base
git push --force-with-lease origin anchor
anchor/fork.sh install ~/workspace/anchor-home          # dry run
anchor/fork.sh install ~/workspace/anchor-home --apply  # needs every workflow complete
# or, while a workflow is active (aidlc config refuses then):
anchor/fork.sh install ~/workspace/anchor-home --in-flight
```

anchor-home switched to this fork on 2026-09-29, in flight, during
`260928-hub-member-avatars`. The first `install --apply` after that intent
completes lets `aidlc config` record ownership of the files.
