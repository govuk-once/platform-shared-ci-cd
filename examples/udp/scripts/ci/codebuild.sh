#!/usr/bin/env bash
# Helpers shared by e2e.sh and perf.sh. Source, don't execute.

# stack_output <OutputKey> - reads a value from the STACK_OUTPUTS JSON the
# pipeline exports after deploying (outputs-stack in pipeline.yml).
stack_output() {
  local json="${STACK_OUTPUTS:-}" value
  [ -n "${json}" ] || json='{}'
  value=$(jq -r --arg k "$1" '.[$k] // empty' <<< "${json}")
  if [ -z "${value}" ]; then
    echo "::error::Stack output '$1' not found. Is outputs-stack set for this stage?" >&2
    return 1
  fi
  printf '%s' "${value}"
}

# upload_source <bucket> <key> - zips the workspace plus the pnpm store for CodeBuild.
upload_source() {
  local bucket="$1" key="$2" store
  store=$(pnpm store path)
  pnpm store prune
  mkdir -p .pnpm-store
  cp -r "${store}"/* .pnpm-store/
  rm -f source.zip
  zip -rqy source.zip . -x '.git/*' -x '.nx/*' -x 'cdk/cdk.out/*'
  echo "Uploading source to s3://${bucket}/${key}"
  aws s3 cp source.zip "s3://${bucket}/${key}"
}

# run_codebuild <project> <wait:true|false> [env-override...]
run_codebuild() {
  local project="$1" wait="$2"
  shift 2
  local args=(--project-name "${project}" --query 'build.id' --output text)
  if [ "$#" -gt 0 ]; then
    args+=(--environment-variables-override "$@")
  fi

  local build_id logs_url
  build_id=$(aws codebuild start-build "${args[@]}")
  logs_url="https://${AWS_REGION}.console.aws.amazon.com/codesuite/codebuild/projects/${project}/build/${build_id}"
  echo "Started ${build_id}"
  echo "Logs: ${logs_url}"
  echo "- [${project}](${logs_url})" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

  [ "${wait}" = "true" ] || return 0

  local status phase
  while true; do
    read -r status phase <<< "$(aws codebuild batch-get-builds --ids "${build_id}" \
      --query 'builds[0].[buildStatus,currentPhase]' --output text)"
    echo "Build status: ${status}, phase: ${phase}"
    case "${status}" in
      SUCCEEDED) return 0 ;;
      FAILED | FAULT | STOPPED | TIMED_OUT)
        echo "::error::CodeBuild ${status}. Logs: ${logs_url}"
        return 1
        ;;
    esac
    sleep 30
  done
}
