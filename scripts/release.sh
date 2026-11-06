#!/usr/bin/env bash
# Release this repository, or pin it for testing from a sandbox repository.
#
#   scripts/release.sh <patch|minor|major|vX.Y.Z> [--push]
#   scripts/release.sh --pin <ref>
#
# Internal references (uses: govuk-once/platform-shared-ci-cd/...@vN) can't be
# relative, because ./ resolves against the caller's repository. On main they
# point at the floating major tag. A release rewrites them to the exact tag in
# a release-only commit (never on main), so each tag only runs its own code:
#
#   1. checks the tree is clean and HEAD is origin/main
#   2. works out the version from the latest vX.Y.Z tag (or takes it as given)
#   3. rewrites @vN to @vX.Y.Z in .github/workflows and actions, and commits
#   4. tags vX.Y.Z and moves vN to the same commit
#   5. with --push: pushes both tags and creates the GitHub release (needs gh)
#
# Without --push the tags stay local so you can inspect them. Remove them with:
#   git tag -d vX.Y.Z && git fetch origin --tags --force
#
# --pin <ref> rewrites the references to @<ref> and commits on the current
# branch. Use it on a throwaway branch, push it, then reference the pipelines
# @<ref> from a sandbox repository.
#
# A major release needs a PR to main that changes @vN to @vN+1 first; this
# script refuses to tag v2.0.0 while main still references @v1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="govuk-once/platform-shared-ci-cd"
SCAN_DIRS=(.github/workflows actions)

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
die() { echo "release: $*" >&2; exit 1; }

cd "${ROOT}"

# Files under SCAN_DIRS with internal references at @v<major>.
files_referencing() {
  grep -rlE "${REPO}/[^@[:space:]]+@v$1([^0-9.]|$)" "${SCAN_DIRS[@]}" 2>/dev/null || true
}

# Every internal reference must point at a workflow or action that exists, or
# the tag would publish a broken pipeline.
check_refs() {
  local missing=0 path
  while IFS= read -r path; do
    [ -e "${path}" ] || { echo "release: missing ${path}, referenced as ${REPO}/${path}" >&2; missing=1; }
  done < <(grep -rhoE "${REPO}/[^@[:space:]]+@" "${SCAN_DIRS[@]}" | sed "s|^${REPO}/||; s|@$||" | sort -u)
  [ "${missing}" -eq 0 ] || die "fix the references above first"
}

# Rewrite @v<major> to @<target> in place.
rewrite_refs() {
  local major="$1" target="$2" files
  files="$(files_referencing "${major}")"
  [ -n "${files}" ] || die "no internal references at @v${major} in ${SCAN_DIRS[*]}"
  # shellcheck disable=SC2086
  TARGET="${target}" perl -pi -e \
    "s{(\Q${REPO}\E/[^\@\s]+)\@v${major}(?=[^0-9.]|\$)}{\$1\@\$ENV{TARGET}}g" ${files}
  echo "${files}"
}

require_clean() {
  [ -z "$(git status --porcelain)" ] || die "working tree is not clean"
}

# ---- arguments ---------------------------------------------------------------

[ $# -ge 1 ] || usage 1
case "$1" in -h|--help) usage ;; esac

if [ "$1" = "--pin" ]; then
  [ $# -eq 2 ] && [ -n "$2" ] || usage 1
  ref="$2"
  require_clean
  check_refs
  major="$(grep -rhoE "${REPO}/[^@[:space:]]+@v[0-9]+([^0-9.]|$)" "${SCAN_DIRS[@]}" \
    | sed -E 's/.*@v([0-9]+).*/\1/' | sort -u)"
  [ "$(echo "${major}" | wc -l | tr -d ' ')" = "1" ] || die "internal references use more than one major: ${major//$'\n'/, }"
  rewrite_refs "${major}" "${ref}" | xargs git add
  git commit -q -m "chore: pin internal refs to @${ref}"
  echo "Pinned internal references to @${ref}. Push this branch and reference the pipelines @${ref}."
  exit 0
fi

spec="$1"; shift
push=false
for arg in "$@"; do
  case "${arg}" in
    --push) push=true ;;
    *) die "unknown argument '${arg}'" ;;
  esac
done

# ---- preconditions -----------------------------------------------------------

require_clean
if "${push}"; then command -v gh >/dev/null || die "gh is required with --push"; fi
git fetch -q --tags --force origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "HEAD is not origin/main; release from an up-to-date main"
check_refs

# ---- version -----------------------------------------------------------------

latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
latest="${latest:-v0.0.0}"
IFS=. read -r lmaj lmin lpat <<<"${latest#v}"

case "${spec}" in
  major) version="v$((lmaj + 1)).0.0" ;;
  minor) version="v${lmaj}.$((lmin + 1)).0" ;;
  patch) version="v${lmaj}.${lmin}.$((lpat + 1))" ;;
  v[0-9]*)
    [[ "${spec}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'${spec}' is not vX.Y.Z"
    version="${spec}"
    highest="$(printf '%s\n%s\n' "${latest}" "${version}" | sort -V | tail -1)"
    [ "${version}" != "${latest}" ] && [ "${highest}" = "${version}" ] \
      || die "${version} is not higher than the latest release ${latest}"
    ;;
  *) die "unknown version '${spec}' (patch, minor, major or vX.Y.Z)" ;;
esac

git rev-parse -q --verify "refs/tags/${version}" >/dev/null && die "tag ${version} already exists"
major="${version#v}"; major="${major%%.*}"
major_tag="v${major}"

[ -n "$(files_referencing "${major}")" ] \
  || die "internal references are not @${major_tag}; bump them to @${major_tag} on main before releasing ${version}"
other="$(grep -rhoE "${REPO}/[^@[:space:]]+@v[0-9]+([^0-9.]|$)" "${SCAN_DIRS[@]}" \
  | sed -E 's/.*@(v[0-9]+).*/\1/' | sort -u | grep -vx "${major_tag}" || true)"
[ -z "${other}" ] || die "internal references also use ${other//$'\n'/, }; they must all be @${major_tag}"

echo "Releasing ${version} (previous ${latest}), moving ${major_tag}"

# ---- release commit and tags -------------------------------------------------

base="$(git rev-parse HEAD)"
start_ref="$(git symbolic-ref -q --short HEAD || echo "${base}")"
git checkout -q --detach
restore() { git checkout -q "${start_ref}"; }
trap restore EXIT

rewrite_refs "${major}" "${version}" | xargs git add
git commit -q -m "chore(release): ${version}" -m "Pins internal references to @${version}. Built from ${base}."
git tag -a "${version}" -m "${version}"
git tag -f "${major_tag}" "${version}^{commit}" >/dev/null

if ! "${push}"; then
  echo "Tagged ${version} and ${major_tag} locally (not pushed)."
  echo "Remove them with: git tag -d ${version} && git fetch origin --tags --force"
else
  git push -q origin "refs/tags/${version}"
  git push -q --force origin "refs/tags/${major_tag}"
  gh release create "${version}" --verify-tag --generate-notes --latest \
    --notes-start-tag "${latest}" --title "${version}"
  echo "Released ${version} and moved ${major_tag}."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "version=${version}" >>"${GITHUB_OUTPUT}"; fi