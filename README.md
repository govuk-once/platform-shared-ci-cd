# Shared CI/CD for GOV.UK App services

This repository contains centrally maintained GitHub Actions for GOV.UK App services, at three levels:

- **Complete pipelines** are configured by a `.github/pipeline.yml` in your repository. This is the recommended way to adopt them: see [docs/pipelines.md](docs/pipelines.md).
- **Reusable workflows** (`.github/workflows/`) are whole jobs you call with `uses:` at job level.
- **Composite actions** (`actions/`) are single steps you drop into your own jobs.

Anything repo-specific (deploy commands, test scripts, stack names, PR title formats) is configuration, not shared code.

## Complete pipelines

```yaml
# .github/workflows/release.yml (the PR and cleanup callers are the same shape)
on:
  push:
    branches: [main]

jobs:
  pipeline:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/release-pipeline.yml@v1
    permissions:
      contents: write
      issues: write
      pull-requests: write
      id-token: write
      actions: read
    secrets: inherit
```

```yaml
# .github/pipeline.yml
application: My Service
pr:
  ephemeral:
    env: { STAGE: "pr-{pr}" }
    deploy: pnpm run deploy
    post-deploy: [./scripts/ci/e2e.sh]
    destroy: pnpm run destroy
quality:
  checks: [pnpm lint, pnpm build]
  sonar: { test: pnpm test }
environments:
  - { name: dev, deploy: pnpm run deploy:dev, post-deploy: [./scripts/ci/e2e.sh] }
  - { name: production, deploy: pnpm run deploy:prod }
```

| Workflow                | Purpose                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `pr-pipeline.yml`       | PR title check, quality checks, ephemeral environment deploy with hooks.                                  |
| `pr-cleanup.yml`        | Destroys the ephemeral environment when the PR closes.                                                    |
| `release-pipeline.yml`  | Quality checks, semantic release, then up to four environments in order, with notifications.              |
| `deploy-stage.yml`      | One stage (used by the pipelines): credentials, setup, hooks, deploy/destroy, notifications.              |
| `quality-checks.yml`    | Config-driven checks, security and SonarQube jobs (used by the pipelines).                                |

Full config reference, secrets, the GitHub environment and IAM setup checklist, and migration steps are in [docs/pipelines.md](docs/pipelines.md). Worked examples: [examples/udp](examples/udp) and [examples/flex](examples/flex).

## Available actions

| Action                          | Purpose                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `actions/setup-node-pnpm`       | Sets up pnpm and Node.js (from `.nvmrc` by default), optional CodeArtifact login, installs dependencies.   |
| `actions/validate-pr-title`     | Checks the PR title against a configurable pattern and optionally maintains a guidance comment on the PR. |
| `actions/sonar-scan`            | Runs tests for coverage, then a SonarQube scan with quality-gate wait.                                     |
| `actions/cdk-deploy`            | Stamps a version, runs a CDK deploy/destroy command, and returns a stack's outputs as JSON.               |
| `actions/notify-deployment`     | Publishes a deployment success/failure (or custom) notification to an AWS Chatbot SNS topic.              |
| `actions/semantic-release`      | Runs semantic-release and outputs `released`, `version`, `type` and `deployed-version`.                   |
| `actions/release-notification`  | Slack release notification for major/minor releases (needs AWS credentials).                              |
| `actions/run-hooks`             | Runs a JSON list of `{name, run}` commands in order, failing on the first error.                          |
| `actions/load-pipeline-config`  | Validates `.github/pipeline.yml` and outputs it as normalised JSON.                                       |

## Available workflows

| Workflow                                      | Purpose                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/cdk-deploy.yml`            | Full deploy job: checkout, AWS OIDC credentials, Node/pnpm setup, CDK command, optional stack outputs.                  |
| `.github/workflows/semantic-release.yml`      | Determines whether a release is required, creates the Git tag and GitHub release, and returns explicit release outputs. |
| `.github/workflows/release-notification.yml`  | Sends a Slack notification for major and minor production releases. Patch releases are silently skipped.                |

## Composing your own pipeline

If the complete pipelines don't fit, compose the pieces directly:

```yaml
# .github/workflows/pr.yml
on:
  pull_request:
    branches: [main]
    types: [opened, edited, synchronize, reopened]

jobs:
  pr-title:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: govuk-once/platform-shared-ci-cd/actions/validate-pr-title@v1
        with:
          post-comment: "true"

  sonar:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: govuk-once/platform-shared-ci-cd/actions/setup-node-pnpm@v1
      - uses: govuk-once/platform-shared-ci-cd/actions/sonar-scan@v1
        with:
          test-command: pnpm test:all
          sonar-token: ${{ secrets.SONAR_TOKEN }}
          sonar-host-url: ${{ secrets.SONAR_URL }}

  deploy-pr-env:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/cdk-deploy.yml@v1
    permissions:
      id-token: write
      contents: read
    with:
      job-name: Deploy PR environment
      command: pnpm run cdk:deploy:dev
      env: |
        DEVELOPER_ID=pr-${{ github.event.pull_request.number }}
      outputs-stack: pr-${{ github.event.pull_request.number }}-dev-e2e
    secrets:
      deployment-role: ${{ secrets.DEV_DEPLOYMENT_ROLE }}
```

```yaml
# .github/workflows/release.yml (push to main)
jobs:
  release:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
    permissions:
      contents: write
      issues: write
      pull-requests: write

  deploy-staging:
    needs: release
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/cdk-deploy.yml@v1
    permissions:
      id-token: write
      contents: read
    with:
      job-name: Deploy to staging
      environment: staging
      command: pnpm run cdk:deploy:stag
      version: ${{ needs.release.outputs.version }}
      prerelease-tag: rc
    secrets:
      deployment-role: ${{ secrets.STAGING_DEPLOYMENT_ROLE }}

  # ...deploy-prod, then release-notification.yml
```

## Setup Node.js and pnpm

Installs pnpm using the `packageManager` field in `package.json`, sets up Node.js and runs `pnpm install --frozen-lockfile`.

```yaml
- uses: govuk-once/platform-shared-ci-cd/actions/setup-node-pnpm@v1
  with:
    # Only needed for private @govuk-connect packages; configure AWS credentials first.
    codeartifact-account: ${{ secrets.CODEARTIFACT_ACCOUNT }}
```

| Input                     | Default              | Description                                                                 |
| ------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `node-version`            | —                    | Node.js version. When empty, read from `node-version-file`, else `24`.      |
| `node-version-file`       | `.nvmrc`             | File to read the Node.js version from.                                      |
| `cache`                   | `true`               | Cache the pnpm store.                                                       |
| `install`                 | `true`               | Run `pnpm install`.                                                         |
| `install-args`            | `--frozen-lockfile`  | Arguments for `pnpm install`.                                               |
| `working-directory`       | `.`                  | Directory containing `package.json` and `pnpm-lock.yaml`.                   |
| `codeartifact-account`    | —                    | When set, runs `aws codeartifact login` before installing.                  |
| `codeartifact-domain`     | `registry-prod`      | CodeArtifact domain.                                                        |
| `codeartifact-repository` | `registry-prod-repo` | CodeArtifact repository.                                                    |
| `codeartifact-namespace`  | `govuk-connect`      | npm scope routed to CodeArtifact.                                           |
| `codeartifact-region`     | `eu-west-2`          | Region of the CodeArtifact domain.                                          |

## Validate PR title

Fails the job when the PR title does not match `pattern`. PRs from actors in `skip-actors` (Dependabot by default) pass automatically. With `post-comment: "true"` a single guidance comment is created when the title is invalid and updated once it is fixed; this needs `pull-requests: write`.

The default pattern is `<JIRA-REF> <type>(<scope>)?: <description>`, e.g. `FLEX-123 feat: add preferences endpoint`. Set your own:

```yaml
- uses: govuk-once/platform-shared-ci-cd/actions/validate-pr-title@v1
  with:
    pattern: '^[A-Z]{3,4}-[1-9][0-9]{0,4}: .+'
    format: "UDP-123: Description"
    examples: |
      UDP-123: Add consent endpoint
```

| Input          | Default                         | Description                                              |
| -------------- | ------------------------------- | -------------------------------------------------------- |
| `pattern`      | Jira ref + Conventional Commit  | Extended regular expression (`grep -E`) to match.        |
| `format`       | `<JIRA-REF> <type>(<scope>)?: <description>` | Format shown in errors and the PR comment.  |
| `examples`     | Three sample titles             | Example titles, one per line, shown in the PR comment.   |
| `guidance-url` | —                               | Link to further guidance in the PR comment.              |
| `skip-actors`  | `dependabot[bot]`               | Space-separated actors to skip.                          |
| `post-comment` | `false`                         | Create/update a guidance comment on the PR.              |
| `github-token` | `github.token`                  | Token used to comment.                                   |

Output: `valid` (`true`/`false`).

## SonarQube scan

Runs `test-command` (to generate coverage), then the SonarQube scanner, waiting for the quality gate. Check out with `fetch-depth: 0` and install dependencies first.

```yaml
- uses: govuk-once/platform-shared-ci-cd/actions/sonar-scan@v1
  with:
    test-command: pnpm exec nx run-many --target=test --all --run --coverage
    sonar-token: ${{ secrets.SONAR_TOKEN_FLEX }}
    sonar-host-url: ${{ secrets.SONAR_URL }}
```

| Input                   | Required | Default | Description                                                  |
| ----------------------- | -------- | ------- | ------------------------------------------------------------ |
| `sonar-token`           | Yes      | —       | SonarQube token.                                             |
| `sonar-host-url`        | Yes      | —       | SonarQube server URL.                                        |
| `test-command`          | No       | —       | Command run before the scan. Leave empty to skip.            |
| `wait-for-quality-gate` | No       | `true`  | Fail if the quality gate fails.                              |
| `quality-gate-timeout`  | No       | `120`   | Seconds to wait for the quality gate.                        |
| `args`                  | No       | —       | Extra scanner arguments.                                     |
| `project-base-dir`      | No       | `.`     | Directory to scan.                                           |

Environment variables set on the step (for example dummy AWS credentials for unit tests) are available to `test-command`.

## CDK deploy

Two ways to use it:

- **`actions/cdk-deploy`** when you are building your own job. Configure AWS credentials and install dependencies first.
- **`.github/workflows/cdk-deploy.yml`** for a complete job with checkout, OIDC credentials, Node/pnpm setup and GitHub environment protection.

The command runs with `bash -euo pipefail` and may be multi-line. `CDK_DEPLOYMENT_ROLE_ARN` is exported as the assumed-role ARN unless already set. The same building block tears down ephemeral environments by passing a destroy command.

### Action

```yaml
- uses: govuk-once/platform-shared-ci-cd/actions/cdk-deploy@v1
  id: deploy
  env:
    STAGE: staging
  with:
    working-directory: platform/infra/flex
    command: pnpm run deploy

- run: echo "${{ fromJSON(steps.deploy.outputs.stack-outputs).ApiUrl }}"
```

### Workflow

```yaml
jobs:
  deploy-dev:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/cdk-deploy.yml@v1
    permissions:
      id-token: write
      contents: read
    with:
      job-name: Deploy to development
      environment: development
      env: |
        STAGE=development
      command: |
        pnpm openapi:generate
        cd platform/infra/flex && pnpm run deploy
    secrets:
      deployment-role: ${{ secrets.DEV_DEPLOYMENT_ROLE }}

  cleanup:
    if: github.event.action == 'closed'
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/cdk-deploy.yml@v1
    permissions:
      id-token: write
      contents: read
    with:
      job-name: Destroy PR environment
      command: pnpm cdk:destroy:dev
      env: |
        DEVELOPER_ID=pr-${{ github.event.pull_request.number }}
    secrets:
      deployment-role: ${{ secrets.DEV_DEPLOYMENT_ROLE }}
```

### Inputs

| Input               | Action | Workflow | Default     | Description                                                                 |
| ------------------- | :----: | :------: | ----------- | --------------------------------------------------------------------------- |
| `command`           | ✓      | ✓        | (required)  | Deploy or destroy command.                                                  |
| `working-directory` | ✓      | ✓        | `.`         | Directory the command and version stamping run in.                          |
| `version`           | ✓      | ✓        | —           | Version to write to `package.json` before the command.                      |
| `prerelease-tag`    | ✓      | ✓        | —           | Makes the version `<version>-<tag>.<short-sha>`, e.g. `1.2.0-rc.abc1234`.   |
| `outputs-stack`     | ✓      | ✓        | —           | CloudFormation stack whose outputs are returned as `stack-outputs`.         |
| `environment`       |        | ✓        | —           | GitHub environment (protection rules, environment secrets).                 |
| `job-name`          |        | ✓        | `Deploy`    | Job display name.                                                           |
| `env`               |        | ✓        | —           | Extra environment variables, one `KEY=value` per line.                      |
| `ref`               |        | ✓        | trigger ref | Git ref to check out.                                                       |
| `aws-region`        |        | ✓        | `eu-west-2` | AWS region.                                                                 |
| `node-version`      |        | ✓        | `.nvmrc`/24 | Node.js version.                                                            |
| `timeout-minutes`   |        | ✓        | `60`        | Job timeout.                                                                |

Workflow secrets: `deployment-role` (required), `codeartifact-account` (optional).

Outputs (both): `version` (the version written, if any) and `stack-outputs` (JSON object keyed by OutputKey, `{}` when skipped). From the workflow use `fromJSON(needs.<job>.outputs.stack-outputs).<OutputKey>`.

## Notify deployment

Publishes an [AWS Chatbot custom notification](https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html) to an SNS topic. Configure AWS credentials that can publish to the topic first. A failed notification only logs a warning unless `fail-on-error: "true"`.

```yaml
- uses: govuk-once/platform-shared-ci-cd/actions/notify-deployment@v1
  with:
    application: Flex
    environment: production
    version: ${{ needs.release.outputs.version }}
    status: ${{ needs.deploy-prod.result == 'failure' && 'failure' || 'success' }}
    topic-arn-ssm-parameter: /development/flex/topic/release-notifications
```

| Input                     | Default   | Description                                                         |
| ------------------------- | --------- | ------------------------------------------------------------------- |
| `application`             | (required)| Service name used in the title.                                     |
| `environment`             | —         | Environment deployed to.                                            |
| `version`                 | —         | Version deployed, without the `v`.                                  |
| `status`                  | `success` | `success` or `failure`.                                             |
| `title` / `message`       | —         | Override the generated title / Slack-markdown body (e.g. for alerts that aren't deployments). |
| `topic-arn`               | —         | SNS topic ARN.                                                      |
| `topic-arn-ssm-parameter` | —         | SSM parameter holding the topic ARN (used when `topic-arn` is empty). |
| `fail-on-error`           | `false`   | Fail the step if publishing fails.                                  |

## Semantic release

### Usage

```yaml
jobs:
  release:
    name: Create Release
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
    permissions:
      contents: write
      issues: write
      pull-requests: write
    with:
      node-version: "24"
```

### Inputs

| Input          | Required | Default | Description                                                            |
| -------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `node-version` | No       | `24`    | Node.js version used to install dependencies and run semantic-release. |

### Outputs

| Output     | Description                                                                     |
| ---------- | ------------------------------------------------------------------------------- |
| `released` | `true` when a release was created; otherwise `false`.                           |
| `version`  | New semantic version without the `v` prefix. Empty when no release was created. |
| `type`     | `major`, `minor` or `patch`. Empty when no release was created.                 |

Callers access the outputs through the release job:

```yaml
${{ needs.release.outputs.released }}
${{ needs.release.outputs.version }}
${{ needs.release.outputs.type }}
```

### Calling-repository requirements

The workflow checks out and runs against the calling repository. Each caller must contain:

- a `pnpm-lock.yaml` file;
- the `semantic-release` package
- a semantic-release configuration such as `.releaserc.json`.

For example:

```json
{
  "branches": ["main"],
  "tagFormat": "v${version}",
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/github"
  ]
}
```

## Release notification

Sends a Slack notification when a major or minor release is deployed to production. Patch releases are silently skipped.

The notification includes the release notes, a link to the GitHub release and a link to the deployment run.

### Usage

Chain it after the semantic release job:

```yaml
jobs:
  release:
    name: Create Release
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
    permissions:
      contents: write
      issues: write
      pull-requests: write

  notify:
    name: Notify
    needs: release
    if: needs.release.outputs.released == 'true'
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/release-notification.yml@v1
    permissions:
      contents: read
      id-token: write
    with:
      application: my-service
      version: ${{ needs.release.outputs.version }}
      type: ${{ needs.release.outputs.type }}
      slack-channel: "#my-release-channel"
    secrets:
      deployment-role: ${{ secrets.AWS_DEPLOYMENT_ROLE }}
```

### Inputs

| Input           | Required | Default     | Description                          |
| --------------- | -------- | ----------- | ------------------------------------ |
| `application`   | Yes      | —           | Human-readable name of the service.  |
| `version`       | Yes      | —           | Semantic version without `v` prefix. |
| `type`          | Yes      | —           | `major`, `minor` or `patch`.         |
| `slack-channel` | Yes      | —           | Slack channel to post to (e.g. `#my-release-channel`). |
| `aws-region`    | No       | `eu-west-2` | AWS region for credential exchange.  |

### Secrets

| Secret            | Required | Description                                      |
| ----------------- | -------- | ------------------------------------------------ |
| `deployment-role` | Yes      | IAM role ARN assumed via OIDC to send the notification. |

## Repository access

For private repositories, configure this repository under **Settings → Actions → General → Access** so approved organisation repositories can call its workflows.

Calling repositories must also permit actions and reusable workflows from this repository under their GitHub Actions policy.

## Versioning and compatibility

Consumers should reference an approved major version:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
```

Workflow releases should use immutable semantic-version tags such as `v1.0.0`. A maintained `v1` tag may point to the latest backwards-compatible `v1` release.

The `v1` tag is **required**, not optional. Reusable workflows can't reference this repository's actions by relative path (`./actions/...` resolves against the caller's checkout), so they reference `govuk-once/platform-shared-ci-cd/...@v1`.

Release with the manual **Release** workflow (`.github/workflows/release.yml`). It runs `scripts/release.sh vX.Y.Z --push`, which:

- pins those internal references to `@vX.Y.Z` in a release-only commit;
- tags that commit `vX.Y.Z` and moves `v1` to it;
- creates the GitHub release.

Each tag therefore only uses code from that tag. This includes `semantic-release.yml` and `release-notification.yml`, which call `actions/semantic-release` and `actions/release-notification`, so they work from a release tag rather than from `main`. On `main`, internal references stay at `@v1`; don't edit them by hand. To test unreleased changes, see [Developing this repository](docs/pipelines.md#developing-this-repository).

The following changes are considered breaking and require a new major version:

- removing or renaming an input, output or secret;
- changing the meaning or format of an output;
- requiring additional caller permissions;
- changing notification eligibility; or
- changing behaviour in a way that requires caller modifications.

Callers should not reference `@main` in production workflows.

