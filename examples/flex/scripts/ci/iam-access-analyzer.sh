#!/usr/bin/env bash
# IAM Access Analyzer checks against the synthesised FlexPlatform templates.
# Moved verbatim from the "IAM Access Analyzer" step of _quality-checks.yml.
# Needs: `cdk synth` already run, cfn-policy-validator installed, AWS credentials.
set -euo pipefail

for template in platform/infra/flex/cdk.out/*-FlexPlatform.template.json; do
  echo "=== Auditing Template: $template ==="

  # Extract all parameter keys from the CFN template and format as "Key1=dummy Key2=dummy" (dummy values are intentional)
  PARAMS=$(jq -r '.Parameters // {} | keys | map("\(.)=dummy-value") | join(" ")' "$template")

  echo "Supplying parameters"

  # Catch syntax errors, malformed JSON, and iam:PassRole wildcards
  cfn-policy-validator validate \
    --template-path "$template" \
    --region eu-west-2 \
    --parameters $PARAMS \
    --treat-finding-type-as-blocking ERROR,SECURITY_WARNING \
    --ignore-finding MISSING_ARN_FIELD,DATA_TYPE_MISMATCH # ignoring two best practices that are only resulting in false positives

  # Catch dangerous internal actions granted
  # Unresolved Fn::ImportValue refs produce unparseable policies (false positives)
  EXCLUSIONS="policy-analysis-CheckAccessNotGrantedValidationException"
  # API Gateway Lambda integrations require lambda:InvokeFunction on the resource policy
  EXCLUSIONS+=",JwksEndpointStubFunctionE64FCBB8.policy-analysis-CheckAccessNotGranted"
  EXCLUSIONS+=",UnsServiceGatewayFunction8EEBB91B.policy-analysis-CheckAccessNotGranted"
  EXCLUSIONS+=",UdpServiceGatewayFunctionAC8DA85C.policy-analysis-CheckAccessNotGranted"
  EXCLUSIONS+=",TravelServiceGatewayFunction6F065CFF.policy-analysis-CheckAccessNotGranted"
  EXCLUSIONS+=",DvlaServiceGatewayFunction043A0515.policy-analysis-CheckAccessNotGranted"

  cfn-policy-validator check-access-not-granted \
    --template-path "$template" \
    --actions "iam:PassRole" \
    --actions "kms:Decrypt" \
    --actions "kms:*" \
    --actions "lambda:InvokeFunction" \
    --region eu-west-2 \
    --parameters $PARAMS \
    --ignore-finding "$EXCLUSIONS"

  # Catch resource policies that expose resources to the public internet
  # Unresolved Fn::ImportValue in the PrivateGateway VPC endpoint condition
  PUBLIC_EXCLUSIONS="policy-analysis-CheckNoPublicAccessValidationException"
  # JWKS endpoint is intentionally public for JWT signature verification
  PUBLIC_EXCLUSIONS+=",JwksEndpointStubFunctionE64FCBB8.policy-analysis-CheckNoPublicAccess"

  cfn-policy-validator check-no-public-access \
    --template-path "$template" \
    --region eu-west-2 \
    --parameters $PARAMS \
    --ignore-finding "$PUBLIC_EXCLUSIONS"
done
