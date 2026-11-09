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

Composite actions for use as steps inside a caller's own jobs.

| Action                                  | Purpose                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `actions/setup-node-pnpm`               | Sets up pnpm and Node.js, optionally authenticates to AWS CodeArtifact, and installs dependencies.          |
| `actions/validate-conventional-commits` | Checks that the commits in a pull request follow the Conventional Commits format.                           |

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
      DEPLOYMENT_ROLE: ${{ secrets.AWS_DEPLOYMENT_ROLE }}
```

If the role is stored as an environment secret named `DEPLOYMENT_ROLE`, pass the environment and inherit secrets instead:

```yaml
    with:
      environment: ephemeral
    secrets: inherit
```

Services that don't install packages from AWS CodeArtifact can set `codeartifact: false`, and then need no role.

### Inputs

| Input          | Required | Default | Description                                                                             |
| -------------- | -------- | ------- | --------------------------------------------------------------------------------------- |
| `node-version` | No       | `24`    | Node.js version used to install dependencies and run semantic-release.                  |
| `codeartifact` | No       | `true`  | Configure AWS CodeArtifact auth before installing dependencies. Requires a role secret. |
| `environment`  | No       | —       | GitHub environment for the job, for callers whose secrets are environment-scoped.       |

### Secrets

| Secret            | Required                     | Description                                                      |
| ----------------- | ---------------------------- | ---------------------------------------------------------------- |
| `DEPLOYMENT_ROLE` | When `codeartifact` is true  | IAM role ARN assumed via OIDC for CodeArtifact.                  |
| `deployment-role` | No                           | Deprecated alias for `DEPLOYMENT_ROLE`. Removed in v2.           |

The job fails early with a clear error if `codeartifact` is true and neither secret is available to it.

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
      id-token: write
    secrets:
      DEPLOYMENT_ROLE: ${{ secrets.AWS_DEPLOYMENT_ROLE }}

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
      DEPLOYMENT_ROLE: ${{ secrets.AWS_DEPLOYMENT_ROLE }}
```

### Inputs

| Input           | Required | Default     | Description                                            |
| --------------- | -------- | ----------- | ------------------------------------------------------ |
| `application`   | Yes      | —           | Human-readable name of the service.                    |
| `version`       | Yes      | —           | Semantic version without `v` prefix.                   |
| `type`          | Yes      | —           | `major`, `minor` or `patch`.                           |
| `slack-channel` | Yes      | —           | Slack channel to post to (e.g. `#my-release-channel`). |
| `aws-region`    | No       | `eu-west-2` | AWS region for credential exchange.                    |
| `environment`   | No       | —           | GitHub environment for the job, for environment-scoped secrets. |

### Secrets

| Secret            | Required | Description                                                       |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `DEPLOYMENT_ROLE` | Yes      | IAM role ARN assumed via OIDC to send the notification.           |
| `deployment-role` | No       | Deprecated alias for `DEPLOYMENT_ROLE`. Removed in v2.            |

One of the two must be available to the job.

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
| `codeartifact`          | No       | `false` | Configure AWS CodeArtifact auth before installing. Requires the `DEPLOYMENT_ROLE` secret.    |
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
| `DEPLOYMENT_ROLE` | No       | IAM role ARN assumed via OIDC for CodeArtifact. Required when `codeartifact` is `true`. |

The job fails early with a clear error if a required secret is empty or not available to it, for example because it lives in an environment that was not passed as `environment`.

### Calling-repository requirements

- a `package.json` with a `packageManager` field and a `pnpm-lock.yaml` file, unless `install` is `false`;
- a `sonar-project.properties` file, or equivalent `args`; and
- for coverage, a test command that writes the report to the path configured in `sonar.javascript.lcov.reportPaths`.

## Setup Node.js and pnpm (action)

Installs pnpm at the version in `package.json`'s `packageManager` field, sets up Node.js with the pnpm store cached, optionally authenticates to AWS CodeArtifact, and runs `pnpm install --frozen-lockfile`.

### Usage

```yaml
steps:
  - uses: actions/checkout@<sha> # v6
    with:
      persist-credentials: false

  - uses: govuk-once/platform-shared-ci-cd/actions/setup-node-pnpm@v1
    with:
      codeartifact-role: ${{ secrets.DEPLOYMENT_ROLE }} # omit if you don't use CodeArtifact
```

The Node.js version comes from `node-version` if set, otherwise from `.nvmrc` (any value `actions/setup-node` accepts, such as `24` or `lts/krypton`), otherwise `24`.

### CodeArtifact

When `codeartifact-role` is set, the action assumes the role via GitHub OIDC (the job needs `id-token: write`), fetches a CodeArtifact auth token and writes **only** the token line to the user-level `~/.npmrc`:

```txt
//registry-prod-904690835784.d.codeartifact.eu-west-2.amazonaws.com/npm/registry-prod-repo/:_authToken=***
```

The repository's own `.npmrc` stays in control of which packages resolve from CodeArtifact (for example `@govuk-connect:registry=…`) and of settings such as `min-release-age`. The role's AWS credentials are not exported to later steps in the job. The action warns if the repository's `.npmrc` doesn't reference the CodeArtifact endpoint, because the token would then be unused.

### Inputs

| Input                       | Required | Default              | Description                                                                 |
| --------------------------- | -------- | -------------------- | --------------------------------------------------------------------------- |
| `node-version`              | No       | —                    | Node.js version. Overrides `node-version-file`.                             |
| `node-version-file`         | No       | `.nvmrc`             | File, relative to `working-directory`, to read the version from.            |
| `cache`                     | No       | `true`               | Cache the pnpm store.                                                       |
| `install`                   | No       | `true`               | Run `pnpm install`.                                                         |
| `install-args`              | No       | `--frozen-lockfile`  | Arguments for `pnpm install`, e.g. `--frozen-lockfile --filter @app/docs`.  |
| `working-directory`         | No       | `.`                  | Directory containing `package.json` and `pnpm-lock.yaml`.                   |
| `codeartifact-role`         | No       | —                    | IAM role ARN for CodeArtifact. Empty skips CodeArtifact.                    |
| `codeartifact-domain`       | No       | `registry-prod`      | CodeArtifact domain.                                                        |
| `codeartifact-repository`   | No       | `registry-prod-repo` | CodeArtifact repository.                                                    |
| `codeartifact-domain-owner` | No       | `904690835784`       | AWS account that owns the domain.                                           |
| `codeartifact-region`       | No       | `eu-west-2`          | Region of the domain.                                                       |

### Outputs

| Output         | Description                         |
| -------------- | ----------------------------------- |
| `node-version` | The Node.js version requested.      |

## Validate Conventional Commits (action)

Checks the subjects of the non-merge commits in a pull request against `<type>(<scope>)?!?: <description>`. By default at least one commit must match, which is enough for semantic-release to work out a version. Set `mode: all` to require every commit to match.

### Usage

```yaml
steps:
  - uses: actions/checkout@<sha> # v6
    with:
      persist-credentials: false

  - uses: govuk-once/platform-shared-ci-cd/actions/validate-conventional-commits@v1
```

Full history isn't required: the action fetches the base and head commits if the checkout doesn't contain them. Runs triggered by non-PR events are skipped unless `base-sha` and `head-sha` are given, and so are pull requests from `dependabot[bot]`.

### Inputs

| Input         | Required | Default                                                      | Description                                           |
| ------------- | -------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `types`       | No       | `feat fix chore docs style refactor test perf ci build revert` | Space-separated allowed commit types.               |
| `mode`        | No       | `at-least-one`                                               | `at-least-one` or `all`.                              |
| `base-sha`    | No       | PR base SHA                                                  | Base commit (exclusive).                              |
| `head-sha`    | No       | PR head SHA                                                  | Head commit (inclusive).                              |
| `skip-actors` | No       | `dependabot[bot]`                                            | Space-separated PR authors whose commits aren't checked. |

### Outputs

| Output  | Description                                                                  |
| ------- | ---------------------------------------------------------------------------- |
| `valid` | `true` when the commits are valid or the check was skipped; otherwise `false`. |

## Repository access

For private repositories, configure this repository under **Settings → Actions → General → Access** so approved organisation repositories can call its workflows.

Calling repositories must also permit actions and reusable workflows from this repository under their GitHub Actions policy.

## Versioning and compatibility

Consumers should reference an approved major version:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@v1
```

Workflow releases use immutable semantic-version tags such as `v1.2.0`. When a non-prerelease `vX.Y.Z` GitHub release is published, `.github/workflows/update-major-tag.yml` moves the `vX` tag to it, so `@v1` always resolves to the latest `v1` release. It never moves a major tag backwards, for example when a `v1.2.1` patch is published after `v1.3.0`.

Callers that need immutable references for supply-chain reasons can pin a full commit SHA with the version as a comment:

```yaml
uses: govuk-once/platform-shared-ci-cd/.github/workflows/semantic-release.yml@<commit-sha> # v1.2.0
```

### Secret naming

Secrets are named in UPPERCASE (`DEPLOYMENT_ROLE`, `SONAR_TOKEN`, `SONAR_URL`) to match GitHub secret names, so callers can use `secrets: inherit`. The lowercase `deployment-role` secret is still accepted throughout v1 and will be removed in v2.

The following changes are considered breaking and require a new major version:

- removing or renaming an input, output or secret;
- changing the meaning or format of an output;
- requiring additional caller permissions;
- changing notification eligibility; or
- changing behaviour in a way that requires caller modifications.

Callers should not reference `@main` in production workflows.
