# Anchor patches

`anchor` = the latest upstream release tag + the patches below, one commit
each. `main` only mirrors `awslabs/aidlc-workflows` main. We keep this list
short: every patch is also offered upstream, and dropped here once an
upstream release includes it.

Base: `v2.10.0`. Current fork release: `v2.10.101`. Check with `anchor/fork.sh status`.

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

## 0001 Plan-approval guard admits unit-major re-entry receipts

- **Why:** after a backward jump into code-generation under unit-major
  iteration (for example, Request Changes at build-and-test), the router
  re-issues the design stages' per-unit directives first, and the construction
  protocol says to re-mint `unit start` / `unit complete` for each. The guard
  saw Current Stage = code-generation, found no code-generation directive, and
  refused those receipts, as well as `report` and `park`. The workflow deadlocks.
  Hit on anchor-home `260928-hub-member-avatars`, 2026-09-29.
- **Change:** `core/hooks/aidlc-plan-approval-guard.ts` gains
  `unitMajorReplayReceipt()`. It admits exactly one literal
  `engine state unit <start|complete|pause|resume>` call whose `--stage` and
  `--unit` match an active v2 per-unit run-stage for a Construction stage
  before code-generation, under unit-major. Everything else under the durable
  code-generation pointer stays guarded.
- **Test:** `tests/unit/t265-plan-approval-guard.test.ts`, "unit-major
  re-entry admits only the matching design-stage unit receipts". It fails
  without the patch.
- **Upstream:** not filed (our call). On each rebase, drop this patch if
  upstream has fixed the guard or scoped the receipt floor to the jump target;
  the t265 test shows whether it's still needed.

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
  missing plan throws and creates nothing) and one `SUBCOMMANDS` list for
  dispatch and usage. `core/tools/aidlc.ts` routes the verb.
  `core/hooks/aidlc-plan-approval-guard.ts` admits `embed` as a plan-approval
  prerequisite only when `--plan` resolves, lexically and by real path, inside
  the Code Generation record dir; every other guard outcome is unchanged.
- **Test:** `tests/unit/t-anchor-testing-posture-embed.test.ts`. It fails
  without the patch.
- **Upstream:** not filed yet. On rebase past v2.11.0, consider reusing
  upstream's `replaceTestingContractSection` for the splice.
## 0003 Fork release channel
- **Why:** anchor-home runs the compiled `aidlc` binary, so a patch only reaches
  it through a release, and `aidlc update` installs only releases whose
  provenance GitHub attests. That needs this repo to publish its own releases.
- **Change:** `DEFAULT_RELEASE_REPOSITORY` (`core/tools/aidlc-release.ts`) and the
  `install.sh` / `install.ps1` defaults point at `anchorhome/aidlc-workflows`.
  `release.yml` requires the tag on `anchor` (not `main`) and a fork version
  (patch >= 100), so mirrored upstream tags never publish here. Fork version =
  upstream base patch x 1000 + 100 + build (base 2.10.0, build 1 -> 2.10.101).
  README badge, CHANGELOG and `aidlc-version.ts` carry the fork version.
- **Test:** `t68`, `t243`, `t244`, `t332`, `t239` pass with the new default; the
  `gh` test fixture follows it.
- **Upstream:** never; fork-only. On rebase, re-apply and bump the version.
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
