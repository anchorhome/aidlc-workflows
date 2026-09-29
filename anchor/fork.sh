#!/usr/bin/env bash
# Keeps the `anchor` branch = latest upstream release tag + our patches, and
# installs its Bun projection into a project. See anchor/PATCHES.md.
#
#   anchor/fork.sh status                 base tag, our patches, newer upstream releases
#   anchor/fork.sh sync                   fetch upstream; fast-forward origin/main and push tags
#   anchor/fork.sh rebase <tag>           move our patches onto an upstream release tag
#   anchor/fork.sh test                   typecheck, determinism check, and the patch tests
#   anchor/fork.sh build                  bun install + package -> dist/kiro
#   anchor/fork.sh overlay <project> <stock-dir>
#                                         record the project's customizations of shipped JSON
#   anchor/fork.sh install <project> [--apply|--in-flight]
#                                         refresh the project from dist/kiro (dry run by default),
#                                         then re-apply its overlay; --in-flight copies instead,
#                                         for when a workflow is active and aidlc config refuses
#
# The overlay lives in the project: <project>/tooling/aidlc/kiro-overlay.json
# (override with ANCHOR_OVERLAY).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf 'fork.sh: %s\n' "$*" >&2; exit 1; }
need_clean() { [ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"; }
base_tag() { git describe --tags --abbrev=0 --match 'v[0-9]*' anchor; }
latest_release() { git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -v -- '-' | head -1; }

cmd_status() {
  git fetch -q upstream --tags
  local base latest
  base=$(base_tag)
  latest=$(latest_release)
  echo "anchor base:     $base"
  echo "latest upstream: $latest"
  echo "our patches:"
  git log --oneline --no-decorate "$base..anchor" | sed 's/^/  /'
  if [ "$base" != "$latest" ]; then
    echo
    echo "A newer upstream release exists. Next: anchor/fork.sh sync && anchor/fork.sh rebase $latest"
  fi
}

cmd_sync() {
  git fetch -q upstream --tags
  # main mirrors upstream; refuse anything but a fast-forward.
  if git show-ref -q refs/remotes/origin/main; then
    git merge-base --is-ancestor origin/main upstream/main || die "origin/main has diverged from upstream/main; it must only mirror upstream"
  fi
  git push -q origin upstream/main:refs/heads/main
  git push -q origin --tags
  echo "origin/main = upstream/main ($(git rev-parse --short upstream/main)); tags pushed"
}

cmd_rebase() {
  local target=${1:-}
  [ -n "$target" ] || die "usage: fork.sh rebase <tag>"
  git rev-parse -q --verify "refs/tags/$target" >/dev/null || die "no tag $target (run sync first)"
  need_clean
  local base
  base=$(base_tag)
  [ "$base" != "$target" ] || { echo "anchor is already on $target"; return; }
  git switch -q anchor
  git tag -f "anchor-before-$target" anchor >/dev/null
  echo "rebasing $(git rev-list --count "$base..anchor") patch(es) from $base onto $target (backup tag anchor-before-$target)"
  git rebase --onto "$target" "$base" anchor
  echo "done. Next: anchor/fork.sh test, review anchor/PATCHES.md (drop patches upstream now includes), then git push --force-with-lease origin anchor"
}

cmd_build() {
  bun install --frozen-lockfile >/dev/null
  bun scripts/package.ts >/dev/null
  [ -f dist/kiro/.kiro/tools/aidlc.ts ] || die "dist/kiro was not produced"
  echo "built dist/kiro from $(git describe --tags --always anchor) ($(git rev-parse --short HEAD))"
}

cmd_test() {
  cmd_build
  bun run typecheck
  bun scripts/package.ts --check
  local files
  files=$(grep -v '^\s*#' anchor/tests.txt | grep -v '^\s*$' | tr '\n' ' ')
  # shellcheck disable=SC2086
  bun test $files
}

cmd_overlay() {
  local project=${1:-} stock=${2:-}
  [ -n "$project" ] && [ -n "$stock" ] || die "usage: fork.sh overlay <project> <stock-dir>"
  local out=${ANCHOR_OVERLAY:-$project/tooling/aidlc/kiro-overlay.json}
  mkdir -p "$(dirname "$out")"
  bun anchor/overlay.mjs extract "$project" "$stock" > "$out"
  echo "wrote $out ($(node -e 'console.log(Object.keys(require(process.argv[1])).length)' "$out") files)"
}

# Mid-workflow install. `aidlc config` refuses to refresh while any workflow
# is active, so this copies the projection's .kiro/ over the project's instead:
# back up, copy (framework files only; project-owned files are untouched and
# nothing is deleted), re-apply the overlay, recompile the active runtime graph.
# Workflow records under aidlc/ are never touched. Once every workflow is
# complete, run the normal `install --apply` so aidlc config records ownership.
cmd_install_inflight() {
  local project=$1 overlay=$2
  local backup_dir=${ANCHOR_BACKUP_DIR:-$HOME/anchor-home-backups}
  mkdir -p "$backup_dir"
  local backup
  backup="$backup_dir/kiro-before-$(git describe --tags --always anchor)-$(date +%Y%m%d-%H%M%S).tgz"
  (cd "$project" && tar -czf "$backup" .kiro)
  echo "backup: $backup  (restore: tar -xzf <backup> -C $project)"
  rsync -a --exclude tools/data/aidlc-projection.json "$ROOT/dist/kiro/.kiro/" "$project/.kiro/"
  (cd "$project" && bun "$ROOT/anchor/overlay.mjs" apply . "$overlay" | grep -v '^!' | tail -1 || true)
  (cd "$project" && bun .kiro/tools/aidlc.ts engine runtime compile >/dev/null)
  echo "installed $(git describe --tags --always anchor) into $project (in-flight copy); review with git -C $project diff --stat"
}

cmd_install() {
  local project=${1:-} apply=${2:-}
  [ -n "$project" ] || die "usage: fork.sh install <project> [--apply|--in-flight]"
  project=$(cd "$project" && pwd)
  [ -f dist/kiro/.kiro/tools/aidlc.ts ] || die "no dist/kiro; run fork.sh build"
  local overlay=${ANCHOR_OVERLAY:-$project/tooling/aidlc/kiro-overlay.json}
  [ -f "$overlay" ] || die "no overlay at $overlay; run fork.sh overlay first (or set ANCHOR_OVERLAY)"
  local src="$ROOT/dist/kiro"
  if [ "$apply" = "--in-flight" ]; then
    cmd_install_inflight "$project" "$overlay"
    return
  fi
  if [ "$apply" != "--apply" ]; then
    echo "dry run (add --apply to write):"
    aidlc config --project-dir "$project" --harness kiro --from "$src" --force --dry-run --json |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.message);console.log(JSON.stringify(j.data?.counts||{}));for(const a of (j.data?.actions||[]).filter(a=>a.action!=="preserve").slice(0,40))console.log("  "+a.action+" "+a.path)})'
    return
  fi
  aidlc config --project-dir "$project" --harness kiro --from "$src" --force --yes --quiet
  bun anchor/overlay.mjs apply "$project" "$overlay"
  echo "installed $(git describe --tags --always anchor) into $project; review with git -C $project diff --stat"
}

case "${1:-}" in
  status) cmd_status ;;
  sync) cmd_sync ;;
  rebase) shift; cmd_rebase "$@" ;;
  build) cmd_build ;;
  test) cmd_test ;;
  overlay) shift; cmd_overlay "$@" ;;
  install) shift; cmd_install "$@" ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
