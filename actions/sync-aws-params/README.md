# sync-aws-params

Upserts SSM parameters and Secrets Manager secrets before a CDK deployment. Replaces per-service `cdk.predeploy.ssm.ts` scripts with a single shared action.

## Usage

```yaml
- name: Sync AWS Parameters & Secrets
  uses: govuk-once/shared-pipeline-actions/sync-aws-params@v1
  env:
    SERVICE_API_ENDPOINT: ${{ secrets.SERVICE_API_ENDPOINT }}
    DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
    SLACK_CHANNEL_ID: ${{ vars.SLACK_CHANNEL_ID }}
  with:
    environment: ${{ inputs.environment }}
    service_name: 'idx'
    ssm_params: |
      /{{var.SERVICE}}/{{var.ENV}}/api_endpoint=SERVICE_API_ENDPOINT
      /{{var.SERVICE}}/{{var.ENV}}/slack_channel=SLACK_CHANNEL_ID
    secrets_params: |
      {{var.ENV}}/{{var.SERVICE}}/db_credentials=DB_PASSWORD
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `environment` | yes | — | Deployment environment. Replaces `{{var.ENV}}` tokens. |
| `service_name` | yes | — | Service name. Replaces `{{var.SERVICE}}` tokens. |
| `ssm_params` | no | `''` | Newline-delimited SSM parameter mappings (see format below). |
| `secrets_params` | no | `''` | Newline-delimited Secrets Manager mappings (see format below). |
| `aws_region` | no | `eu-west-2` | AWS region. |

## Mapping format

Each line follows the pattern `path=ENV_VAR_NAME`:

```
/{{var.SERVICE}}/{{var.ENV}}/some_key=MY_ENV_VAR
```

- The left side is the SSM parameter path or Secrets Manager secret name. Use `{{var.ENV}}` and `{{var.SERVICE}}` as placeholders — they are replaced by the `environment` and `service_name` inputs at runtime.
- The right side is the name of an environment variable in the step's `env:` block. Its value is written to AWS.
- Blank lines and lines starting with `#` are ignored.

## Behaviour

- **SSM parameters** — upserts with `Overwrite: true`. Always writes, regardless of whether the value changed.
- **Secrets Manager secrets** — checks for existence first. Creates the secret if it does not exist; updates it otherwise.
- **Failures** — the action fails immediately (and fails the pipeline) if an env var is missing/empty or any AWS call returns an error.

## Prerequisites

AWS credentials must be configured on the runner before this step runs, typically via `aws-actions/configure-aws-credentials`:

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v5
  with:
    role-to-assume: ${{ secrets.DEPLOYMENT_ROLE }}
    aws-region: eu-west-2

- name: Sync AWS Parameters & Secrets
  uses: govuk-once/shared-pipeline-actions/sync-aws-params@v1
  ...
```

## Development

```bash
cd sync-aws-params
npm install
npm test          # run Vitest tests
npm run build     # compile dist/index.js with ncc (commit the result)
```
