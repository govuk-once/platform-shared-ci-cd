#!/usr/bin/env bash
# Run an example's full pipeline locally with act (https://github.com/nektos/act).
#
#   scripts/act.sh <event> [example] [-- extra act args]
#
#   event    pr-open | pr-closed | push | all
#   example  udp | flex | all          (default: udp, or $EXAMPLE)
#
# Examples:
#   scripts/act.sh pr-open
#   scripts/act.sh push flex
#   scripts/act.sh all all
#   STUB_RELEASE_TYPE=patch scripts/act.sh push     # major | minor | patch | none
#   scripts/act.sh pr-open udp -- -j title           # extra act arguments
#
# What runs for real: this repository's workflows and actions (from your working
# copy, not the published tag), the example's pipeline.yml and its scripts.
# What is stubbed (tests/stubs): every external service. Third-party actions
# (AWS credentials, dependency review, Sonar, ...), CLIs (aws, gh, pnpm, npx,
# checkov, ...) and semantic-release, which never tags or publishes. pnpm
# commands from pipeline.yml are logged, not run: they belong to the
# consuming repository.
#
# Each run builds a throwaway git workspace in .act/workspaces/<example> from
# tests/fixtures/node-project, the example and tests/fixtures/examples/<example>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUBS="${ROOT}/tests/stubs"
FIXTURES="${ROOT}/tests/fixtures"
IMAGE="catthehacker/ubuntu:act-latest"
# Native platform: the image is multi-arch and the stubs are plain bash.
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[ $# -ge 1 ] || usage 1
case "$1" in -h|--help) usage ;; esac

EVENT="$1"; shift
EXAMPLE_ARG="${EXAMPLE:-udp}"
if [ $# -gt 0 ] && [ "$1" != "--" ]; then EXAMPLE_ARG="$1"; shift; fi
[ "${1:-}" = "--" ] && shift
EXTRA_ARGS=("$@")

for cmd in act docker git node; do
  command -v "${cmd}" >/dev/null || { echo "${cmd} is required (act: brew install act)" >&2; exit 1; }
done

case "${EVENT}" in
  pr-open|pr-closed|push) EVENTS=("${EVENT}") ;;
  all) EVENTS=(pr-open pr-closed push) ;;
  *) echo "Unknown event '${EVENT}'" >&2; usage 1 ;;
esac

if [ "${EXAMPLE_ARG}" = "all" ]; then
  EXAMPLES=()
  for d in "${ROOT}"/examples/*/; do EXAMPLES+=("$(basename "${d}")"); done
else
  [ -d "${ROOT}/examples/${EXAMPLE_ARG}" ] || { echo "No example '${EXAMPLE_ARG}' in examples/" >&2; exit 1; }
  EXAMPLES=("${EXAMPLE_ARG}")
fi

# This repository's actions and workflows come from the working copy; each
# third-party action in tests/stubs/actions.map is replaced by its stub, for
# every ref this repository uses.
REPO_ARGS=(--local-repository "govuk-once/platform-shared-ci-cd@v1=${ROOT}")
while read -r repo stub || [ -n "${repo}" ]; do
  case "${repo}" in ''|\#*) continue ;; esac
  while read -r ref; do
    REPO_ARGS+=(--local-repository "${repo}@${ref}=${STUBS}/actions/${stub}")
  done < <(grep -rhoE "uses: ${repo}(/[^@ ]+)?@[^ ]+" "${ROOT}/.github" "${ROOT}/actions" | sed 's/.*@//' | sort -u)
done < "${STUBS}/actions.map"

# Put the stub CLIs first on PATH in every job, ahead of the image's own tools.
IMAGE_PATH="$(docker run --rm --platform "${PLATFORM}" --entrypoint printenv "${IMAGE}" PATH)"

# The first line of pr.title.examples, so the title check passes.
pr_title() {
  awk '/^ *examples: *\|/ { grab = 1; next } grab && NF { sub(/^ +/, ""); print; exit }' \
    "${ROOT}/examples/$1/.github/pipeline.yml"
}

build_workspace() {
  local example="$1" ws="$2"
  rm -rf "${ws}"
  mkdir -p "${ws}"
  cp -R "${FIXTURES}/node-project/." "${ws}/"
  cp -R "${ROOT}/examples/${example}/." "${ws}/"
  [ -d "${FIXTURES}/examples/${example}" ] && cp -R "${FIXTURES}/examples/${example}/." "${ws}/"
  mkdir -p "${ws}/.act/bin" "${ws}/node_modules"
  cp "${STUBS}/bin/"* "${ws}/.act/bin/"
  cp -R "${STUBS}/semantic-release" "${ws}/node_modules/semantic-release"
  (
    cd "${ws}"
    git init -q -b main
    git remote add origin "https://github.com/govuk-once/act-${example}.git"
    git add -A
    git -c user.name=act -c user.email=act@localhost commit -qm "chore: initial commit"
    git -c user.name=act -c user.email=act@localhost commit -q --allow-empty -m "feat: change under test"
  )
}

# Fill the event fixture with the workspace's commits and the example's title.
write_event() {
  local template="$1" out="$2" ws="$3" title="$4"
  BASE="$(git -C "${ws}" rev-parse HEAD~1)" HEAD_SHA="$(git -C "${ws}" rev-parse HEAD)" \
  TITLE="${title}" node -e '
    const fs = require("fs");
    const [template, out] = process.argv.slice(1);
    const e = JSON.parse(fs.readFileSync(template, "utf8"));
    const { BASE, HEAD_SHA, TITLE } = process.env;
    if (e.pull_request) {
      e.pull_request.base.sha = BASE;
      e.pull_request.head.sha = HEAD_SHA;
      if (TITLE) e.pull_request.title = TITLE;
    } else {
      e.before = BASE;
      e.after = HEAD_SHA;
      e.head_commit.id = HEAD_SHA;
    }
    fs.writeFileSync(out, JSON.stringify(e, null, 2));
  ' "${template}" "${out}"
}

run() {
  local example="$1" event="$2" gh_event workflow fixture ws
  case "${event}" in
    pr-open)   gh_event=pull_request; workflow=pr.yml;         fixture=pull_request.json ;;
    pr-closed) gh_event=pull_request; workflow=pr-cleanup.yml; fixture=pull_request_closed.json ;;
    push)      gh_event=push;         workflow=release.yml;    fixture=push.json ;;
  esac
  ws="${ROOT}/.act/workspaces/${example}"

  echo
  echo "━━━ ${example}: ${event} (${workflow}) ━━━"
  build_workspace "${example}" "${ws}"
  write_event "${FIXTURES}/events/${fixture}" "${ws}/.act/event.json" "${ws}" "$(pr_title "${example}")"

  (
    cd "${ws}"
    act "${gh_event}" \
      -W ".github/workflows/${workflow}" \
      -e .act/event.json \
      --container-architecture "${PLATFORM}" \
      --container-daemon-socket - \
      --bind \
      --concurrent-jobs "${ACT_CONCURRENT_JOBS:-1}" \
      --secret-file "${STUBS}/secrets.env" \
      --env "PATH=${ws}/.act/bin:${IMAGE_PATH}" \
      --env "STUB_RELEASE_TYPE=${STUB_RELEASE_TYPE:-minor}" \
      "${REPO_ARGS[@]}" \
      ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
  )
}

RESULTS=()
STATUS=0
for example in "${EXAMPLES[@]}"; do
  for event in "${EVENTS[@]}"; do
    if run "${example}" "${event}"; then
      RESULTS+=("✅ ${example} ${event}")
    else
      RESULTS+=("❌ ${example} ${event}")
      STATUS=1
    fi
  done
done

echo
echo "━━━ Summary ━━━"
printf '%s\n' "${RESULTS[@]}"
exit "${STATUS}"