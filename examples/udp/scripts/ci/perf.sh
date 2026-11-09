#!/usr/bin/env bash
# Starts the performance suite in CodeBuild without waiting (fire-and-forget).
# Replaces .github/workflows/__perf-test.yml.
#
# Usage: perf.sh <stack-prefix> <perf-target>   e.g. perf.sh dev smoke
# Needs: STACK_OUTPUTS (source bucket/path from the -e2e stack) and AWS credentials.
set -euo pipefail

STACK_PREFIX="$1"
PERF_TARGET="$2"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=codebuild.sh
source "${DIR}/codebuild.sh"

PROJECT=$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-perf" \
  --query "Stacks[0].Outputs[?OutputKey=='PerfCodeBuildProjectName'].OutputValue" --output text)

upload_source "$(stack_output SourceBucketName)" "$(stack_output SourcePath)"
run_codebuild "${PROJECT}" false "name=PERF_TARGET,value=${PERF_TARGET},type=PLAINTEXT"
