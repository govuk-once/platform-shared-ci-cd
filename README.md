# Reusable GitHub Actions CI/CD

This repository contains centrally maintained GitHub Actions workflows for GOV.UK App services.

Application repositories remain responsible for their own quality checks, builds, tests and deployments. These workflows provide a consistent release contract without centralising service-specific deployment logic.

## Available workflows

| Workflow                                     | Purpose                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/semantic-release.yml`     | Determines whether a release is required, creates the Git tag and GitHub release, and returns explicit release outputs. |
| `.github/workflows/release-notification.yml` | Sends a Slack notification for major and minor production releases. Patch releases are silently skipped.                |

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
      deployment-role: ${{ secrets.AWS_DEPLOYMENT_ROLE }}
```

### Inputs

| Input          | Required | Default | Description                                                            |
| -------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `node-version` | No       | `24`    | Node.js version used to install dependencies and run semantic-release. |

### Secrets

| Secret            | Required | Description                                    |
| ----------------- | -------- | ---------------------------------------------- |
| `deployment-role` | Yes      | ARN of the IAM role to assume for deployment.  |

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
  deploy:
    name: Deploy to production
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

## Repository access

For private repositories, configure this repository under **Settings → Actions → General → Access** so approved organisation repositories can call its workflows.

Calling repositories must also permit actions and reusable workflows from this repository under their GitHub Actions policy.

## Versioning and compatibility

Consumers should reference an approved major version:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
```

Workflow releases should use immutable semantic-version tags such as `v1.0.0`. A maintained `v1` tag may point to the latest backwards-compatible `v1` release.

The following changes are considered breaking and require a new major version:

- removing or renaming an input, output or secret;
- changing the meaning or format of an output;
- requiring additional caller permissions;
- changing notification eligibility; or
- changing behaviour in a way that requires caller modifications.

Callers should not reference `@main` in production workflows.
