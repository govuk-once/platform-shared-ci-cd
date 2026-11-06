#!/usr/bin/env bash
# Runs the E2E suite in CodeBuild against the stage just deployed.
# Replaces .github/workflows/__e2e.yml and the upload-source / run-codebuild /
# e2e-stack-outputs local actions.
#
# Usage: e2e.sh [E2E_TARGET]
# Needs: STACK_OUTPUTS (set by the pipeline from outputs-stack) and AWS credentials.
set -euo pipefail

TARGET="${1:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=codebuild.sh
source "${DIR}/codebuild.sh"

PROJECT=$(stack_output CodeBuildProjectName)
upload_source "$(stack_output SourceBucketName)" "$(stack_output SourcePath)"

overrides=()
if [ -n "${TARGET}" ]; then
  overrides=("name=E2E_TARGET,value=${TARGET},type=PLAINTEXT")
fi
run_codebuild "${PROJECT}" true ${overrides[@]+"${overrides[@]}"}
