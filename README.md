# Reusable GitHub Actions CI/CD

This repository contains centrally maintained GitHub Actions workflows for GOV.UK App services.

Application repositories remain responsible for their own quality checks, builds, tests and deployments. These workflows provide a consistent release contract without centralising service-specific deployment logic.

## Available workflows

| Workflow                                     | Purpose                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/semantic-release.yml`     | Determines whether a release is required, creates the Git tag and GitHub release, and returns explicit release outputs. |
| `.github/workflows/release-notification.yml` | Sends a Slack notification for major and minor production releases. Patch releases are silently skipped.                |
| `.github/workflows/pr-title.yml`             | Validates the pull request title against a pattern and optionally keeps a guidance comment on the PR up to date.       |
| `.github/workflows/sonar-scan.yml`           | Installs dependencies, runs tests for coverage, runs a SonarQube scan and waits for the Quality Gate.                  |

## Available actions

Composite actions for use as steps inside a caller's own jobs are documented in [`actions/README.md`](actions/README.md).

| Action                                  | Purpose                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `actions/setup-node-pnpm`               | Sets up pnpm and Node.js, optionally authenticates to AWS CodeArtifact, and installs dependencies. |
| `actions/validate-conventional-commits` | Checks that the commits in a pull request follow the Conventional Commits format.                  |

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
      id-token: write
    with:
      node-version: "24"
    secrets:
      deployment-role: ${{ secrets.AWS_deployment-role }}
```

The workflow always authenticates to AWS CodeArtifact before installing dependencies, so the `deployment-role` secret is required.

### Inputs

| Input          | Required | Default | Description                                                            |
| -------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `node-version` | No       | `24`    | Node.js version used to install dependencies and run semantic-release. |

### Secrets

| Secret            | Required | Description                                     |
| ----------------- | -------- | ----------------------------------------------- |
| `deployment-role` | Yes      | IAM role ARN assumed via OIDC for CodeArtifact. |

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

- a `package.json` with a `packageManager` field and a `pnpm-lock.yaml` file;
- the `semantic-release` package; and
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
      id-token: write
    secrets:
      deployment-role: ${{ secrets.AWS_deployment-role }}

  deploy:
    name: Deploy to production
    needs: release
    if: needs.release.outputs.released == 'true'
    uses: ./.github/workflows/deploy.yml # the service's own deployment
    with:
      version: ${{ needs.release.outputs.version }}

  notify:
    name: Notify
    needs: [release, deploy]
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
      deployment-role: ${{ secrets.AWS_deployment-role }}
```

### Inputs

| Input           | Required | Default     | Description                                            |
| --------------- | -------- | ----------- | ------------------------------------------------------ |
| `application`   | Yes      | —           | Human-readable name of the service.                    |
| `version`       | Yes      | —           | Semantic version without `v` prefix.                   |
| `type`          | Yes      | —           | `major`, `minor` or `patch`.                           |
| `slack-channel` | Yes      | —           | Slack channel to post to (e.g. `#my-release-channel`). |
| `aws-region`    | No       | `eu-west-2` | AWS region for credential exchange.                    |

### Secrets

| Secret            | Required | Description                                             |
| ----------------- | -------- | ------------------------------------------------------- |
| `deployment-role` | Yes      | IAM role ARN assumed via OIDC to send the notification. |

## PR title validation

Checks the pull request title against an extended regular expression (`grep -E`). Squash merges use the PR title as the commit message, so the title drives semantic-release.

The default pattern requires a Jira reference followed by a Conventional Commit type, for example `ABC-123 feat(api): add endpoint`. Pull requests from `dependabot[bot]` and runs triggered by non-PR events are skipped.

### Usage

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  title:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/pr-title.yml@v1
    permissions:
      pull-requests: write
    with:
      post-comment: true
      guidance-url: https://github.com/govuk-once/my-service/blob/main/docs/releases.md
      examples: |
        ABC-123 feat: add user preferences endpoint
        ABC-456 fix(api): handle empty payload
```

Include `edited` in the trigger types so the check re-runs when the title changes. To re-run only the title check on title edits, guard other jobs with `if: github.event.action != 'edited'`.

A service with its own convention can pass a custom pattern:

```yaml
    with:
      pattern: '^[A-Z]{3,4}-[1-9][0-9]{0,4}: .+'
      format: "UDP-123: Description"
```

### Inputs

| Input          | Required | Default                                                        | Description                                                                  |
| -------------- | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pattern`      | No       | `<JIRA-REF> <type>(<scope>)?: <description>`                   | Extended regular expression the title must match.                            |
| `format`       | No       | `<JIRA-REF> <type>(<scope>)?: <description>`                   | Human-readable format shown in the error and PR comment.                     |
| `examples`     | No       | Three `ABC-123` examples                                       | Example valid titles, one per line, shown in the PR comment.                 |
| `guidance-url` | No       | —                                                              | Link to further guidance, included in the PR comment.                        |
| `skip-actors`  | No       | `dependabot[bot]`                                              | Space-separated PR authors whose titles are not checked.                     |
| `post-comment` | No       | `false`                                                        | Create a guidance comment when the title is invalid and update it on change. |

### Outputs

| Output  | Description                                                                 |
| ------- | --------------------------------------------------------------------------- |
| `valid` | `true` when the title is valid or the check was skipped; otherwise `false`. |

### Permissions

The workflow requests `pull-requests: write`, so the calling job must grant it even when `post-comment` is `false`. Posting the comment is best-effort: on pull requests from forks, where the token is read-only, the check still passes or fails on the title alone.

## SonarQube scan

Checks out the calling repository with full history, installs dependencies with pnpm, optionally runs a test command to produce coverage, then runs a SonarQube scan and fails if the Quality Gate fails.

Project settings such as `sonar.projectKey`, sources, exclusions and coverage report paths belong in the calling repository's `sonar-project.properties`, or can be passed through `args`.

### Usage

```yaml
jobs:
  sonar:
    uses: govuk-once/platform-shared-ci-cd/.github/workflows/sonar-scan.yml@v1
    permissions:
      contents: read
      id-token: write
    with:
      test-command: pnpm test:coverage
    secrets:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
      SONAR_URL: ${{ secrets.SONAR_URL }}
```

When dependencies come from AWS CodeArtifact and the role is held in a GitHub environment:

```yaml
    with:
      test-command: pnpm test:all
      environment: ephemeral
      codeartifact: true
    secrets: inherit
```

### Inputs

| Input                   | Required | Default | Description                                                                                  |
| ----------------------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `test-command`          | No       | —       | Command run before the scan to generate coverage. Skipped when empty.                         |
| `node-version`          | No       | `24`    | Node.js version used to install dependencies and run tests.                                  |
| `install`               | No       | `true`  | Run `pnpm install --frozen-lockfile` before the tests and scan.                              |
| `codeartifact`          | No       | `false` | Configure AWS CodeArtifact auth before installing. Requires the `deployment-role` secret.    |
| `environment`           | No       | —       | GitHub environment for the scan job, for callers whose secrets are environment-scoped.       |
| `wait-for-quality-gate` | No       | `true`  | Fail the job when the Quality Gate fails.                                                    |
| `quality-gate-timeout`  | No       | `300`   | Seconds to wait for the Quality Gate result.                                                 |
| `project-base-dir`      | No       | `.`     | Directory to scan, relative to the repository root.                                          |
| `args`                  | No       | —       | Additional scanner arguments, for example `-Dsonar.projectKey=my-service`.                   |

### Secrets

| Secret            | Required | Description                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `SONAR_TOKEN`     | Yes      | SonarQube token with permission to analyse the project.                     |
| `SONAR_URL`       | Yes      | SonarQube server URL.                                                       |
| `deployment-role` | No       | IAM role ARN assumed via OIDC for CodeArtifact. Required when `codeartifact` is `true`. |

The job fails early with a clear error if a required secret is empty or not available to it, for example because it lives in an environment that was not passed as `environment`.

### Calling-repository requirements

- a `package.json` with a `packageManager` field and a `pnpm-lock.yaml` file, unless `install` is `false`;
- a `sonar-project.properties` file, or equivalent `args`; and
- for coverage, a test command that writes the report to the path configured in `sonar.javascript.lcov.reportPaths`.

## Repository access

For private repositories, configure this repository under **Settings → Actions → General → Access** so approved organisation repositories can call its workflows.

Calling repositories must also permit actions and reusable workflows from this repository under their GitHub Actions policy.

## Versioning and compatibility

Consumers should reference an approved major version:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
```

Releases use immutable semantic-version tags such as `v1.2.0`. The major tag (`v1`) points at the latest release in that major version, so `@v1` picks up new minor and patch releases.

Callers that need immutable references for supply-chain reasons can pin a full commit SHA with the version as a comment:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@<commit-sha> # v1.2.0
```

The following changes are considered breaking and require a new major version:

- removing or renaming an input, output or secret;
- changing the meaning or format of an output;
- requiring additional caller permissions;
- changing notification eligibility; or
- changing behaviour in a way that requires caller modifications.

Callers should not reference `@main` in production workflows.

