#!/usr/bin/env bash
# Deploys the monitoring stack only when its synthesised template has changed.
# Replaces .github/workflows/__deploy-monitoring.yml.
#
# Usage: deploy-monitoring.sh <env: dev|stag|prod> <package.json deploy script>
# Needs: AWS credentials; DEVELOPER_ID for PR environments; checkov installed
# (installed here if missing).
set -euo pipefail

ENVIRONMENT="$1"
DEPLOY_SCRIPT="$2"
export ENVIRONMENT

if [ -n "${DEVELOPER_ID:-}" ]; then
  STACK_NAME="${DEVELOPER_ID}-${ENVIRONMENT}-monitoring"
else
  STACK_NAME="${ENVIRONMENT}-monitoring"
fi
SSM_PARAM="/upd/${STACK_NAME}/template-hash"

command -v checkov > /dev/null || python3 -m pip install --quiet checkov

npx tsx cdk/scripts/discover-monitoring.ts

rm -rf cdk/cdk.out
(cd cdk && npx cdk synth "${STACK_NAME}" -c env="${ENVIRONMENT}" -c skipMainStack=true --quiet)
TEMPLATE="cdk/cdk.out/${STACK_NAME}.template.json"

CURRENT_HASH=$(sha256sum "${TEMPLATE}" | awk '{print $1}')
PREVIOUS_HASH=$(aws ssm get-parameter --name "${SSM_PARAM}" --query "Parameter.Value" --output text 2> /dev/null || true)
STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --query "Stacks[0].StackStatus" --output text 2> /dev/null || true)

if [ -n "${PREVIOUS_HASH}" ] && [ -n "${STACK_STATUS}" ] && [ "${CURRENT_HASH}" = "${PREVIOUS_HASH}" ]; then
  echo "Template unchanged and stack exists; skipping monitoring deployment."
  exit 0
fi

checkov -f "${TEMPLATE}" --config-file cdk/.checkov.yaml
pnpm run "${DEPLOY_SCRIPT}"

aws ssm put-parameter --name "${SSM_PARAM}" --value "${CURRENT_HASH}" --type String --overwrite > /dev/null
echo "Saved template hash to ${SSM_PARAM}"
