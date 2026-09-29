# Anchor patches

`anchor` = the latest upstream release tag + the patches below, one commit
each. `main` only mirrors `awslabs/aidlc-workflows` main. We keep this list
short: every patch is also offered upstream, and dropped here once an
upstream release includes it.

Base: `v2.10.0`. Check with `anchor/fork.sh status`.

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

## Known upstream test failures (not ours)

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
```
