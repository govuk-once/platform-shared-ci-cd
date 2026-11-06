# Shared pipelines

A repository adopts complete PR, cleanup and release pipelines by committing:

1. a config file, `.github/pipeline.yml`, describing *what* to run;
2. three short caller workflows (copy them from [`examples/udp/.github/workflows`](../examples/udp/.github/workflows)).

The pipeline logic (ordering, credentials, setup, notifications) lives in this repository and is versioned.

| Workflow | Trigger in the caller | What it does |
| --- | --- | --- |
| `pr-pipeline.yml` | `pull_request` (opened, edited, synchronize, reopened) | Title check, quality checks, deploy the ephemeral environment and run its hooks. Editing only the PR title re-runs the title check without redeploying. |
| `pr-cleanup.yml` | `pull_request` (closed) | Destroys the ephemeral environment. Shares a concurrency group with the PR deploy so they never overlap. |
| `release-pipeline.yml` | `push` to `main` | Quality checks, semantic release, then each environment in order, then a failure notification. |

Complete worked examples: [UDP](../examples/udp) and [flex](../examples/flex).

## How it fits together

```text
pr-pipeline:       config ─┬─ title ──────── ephemeral (deploy-stage)
                           └─ quality (checks │ security │ sonar)

release-pipeline:  config ── quality ── release ── env[0] ── env[1] ── env[2] ── env[3]
                                                                         └── notify-failure

deploy-stage (one job, in the stage's GitHub environment):
  checkout → export env → assume DEPLOYMENT_ROLE → setup Node/pnpm
  → pre-deploy hooks → deploy → post-deploy hooks → release / deployment notifications
```

Each environment runs as a single job, so hooks share the deploy's credentials, installed dependencies and stack outputs. A failing hook fails the stage and stops promotion.

## Config reference

Add `# yaml-language-server: $schema=<path or URL to schema/pipeline.schema.json>` at the top for editor autocomplete. The pipeline validates the file on every run and reports the exact key at fault, e.g. `environments[1].deploy: is required`.

### Top level

| Key | Default | Description |
| --- | --- | --- |
| `application` | (required) | Service name used in notifications. |
| `node.version` | `.nvmrc`, then `24` | Node.js version. |
| `node.codeartifact` | `false` | Log in to CodeArtifact before installing. Every job that installs then needs AWS credentials (see [Secrets](#secrets-and-environments)). |
| `aws.region` | `eu-west-2` | Region for credentials. |
| `release.enabled` | `true` | Run semantic-release. When `false`, the short commit SHA is the version. |

### Stages: `pr.ephemeral` and each `environments[]` entry

| Key | Default | Description |
| --- | --- | --- |
| `name` | `ephemeral` for `pr.ephemeral`; required for environments | Shown in job names; exported as `PIPELINE_ENV`. |
| `environment` | `name` | GitHub environment the job runs in. Its `DEPLOYMENT_ROLE` secret and protection rules apply. |
| `env` | — | `NAME: value` exported to every command. Placeholders: `{pr}`, `{sha}`, `{env}`, `{version}`. |
| `working-directory` | `.` | Where `deploy`/`destroy` run and the version is stamped. Hooks always run from the repository root. |
| `deploy` | (required) | Deploy command. |
| `destroy` | — | `pr.ephemeral` only: run by `pr-cleanup.yml`. |
| `pre-deploy`, `post-deploy` | — | Hook lists, run in order. Each item is a command string or `{name, run}`. |
| `prerelease-tag` | — | Stamp `package.json` as `<version>-<tag>.<short-sha>`, e.g. `1.4.0-rc.abc1234`. |
| `outputs-stack` | — | CloudFormation stack whose outputs are exported to post-deploy hooks as `STACK_OUTPUTS` JSON. |
| `release-notification.slack-channel` | — | Send the Slack release notification after this stage for major/minor releases. Use on production. |
| `timeout-minutes` | `60` | Job timeout, including hooks. |

The release pipeline supports up to **four** environments.

Every command (deploy, destroy, hooks) runs with `bash -euo pipefail` and sees:

| Variable | Value |
| --- | --- |
| `PIPELINE_ENV` | Stage name. |
| `PR_NUMBER` | PR number (PR pipelines only). |
| `VERSION` | Version deployed, including any prerelease suffix (release pipeline only). |
| `STACK_OUTPUTS` | JSON of `outputs-stack` outputs, e.g. `jq -r .ApiUrl <<< "$STACK_OUTPUTS"` (post-deploy only). |
| `CDK_DEPLOYMENT_ROLE_ARN` | The assumed role ARN. |
| AWS credentials | From the stage's `DEPLOYMENT_ROLE`. |

### `pr.title`

Set `title: false` to disable. Otherwise see the [validate-pr-title inputs](../README.md#validate-pr-title): `pattern`, `format`, `examples`, `guidance-url`, `skip-actors`, `comment`.

### `quality`

| Key | Default | Description |
| --- | --- | --- |
| `setup` | — | Command run before checks, e.g. `python3 -m pip install checkov`. |
| `checks` | — | Commands run in order in the **Checks** job. |
| `aws` | `false` | Give the Checks job AWS credentials (e.g. for `cdk synth`). |
| `environment` | `pr.ephemeral.environment`, else the first environment | GitHub environment whose `DEPLOYMENT_ROLE` quality jobs assume when they need AWS. |
| `nx` | `false` | Set `NX_BASE`/`NX_HEAD` for `nx affected`. |
| `dependency-review` | `false` | Fail PRs adding dependencies with high-severity vulnerabilities. |
| `conventional-commits` | `false` | Require at least one Conventional Commit in the PR. |
| `sonar` | — | `true`, or `{test, args}`: run `test` for coverage, then SonarQube with quality-gate wait. |

### `notifications`

| Key | Default | Description |
| --- | --- | --- |
| `topic-arn` / `topic-arn-ssm-parameter` | — | AWS Chatbot SNS topic. |
| `notify-on` | `[failure]` when a topic is set | `success` posts after each environment deploys; `failure` posts once if the release pipeline fails, naming the stage. |

## Secrets and environments

Callers pass `secrets: inherit`. The pipelines expect these names:

| Secret | Scope | Needed for |
| --- | --- | --- |
| `DEPLOYMENT_ROLE` | **Each GitHub environment** (`ephemeral`, `dev`, `staging`, `production`, …) | Deploying that stage, and quality/release jobs when AWS is needed. |
| `CODEARTIFACT_ACCOUNT` | Repository or organisation | `node.codeartifact: true`. |
| `SONAR_TOKEN`, `SONAR_URL` | Repository or organisation | `quality.sonar`. |
| `NOTIFICATIONS_ROLE` | Repository | Publishing deployment notifications (e.g. a dev-account topic). Without it, success notifications use the stage's role and failure notifications are skipped with a warning. |
| `GH_APP_ID`, `GH_APP_PRIVATE_KEY` | Repository | Optional. semantic-release uses a GitHub App token, e.g. when branch protection blocks `github.token`. |

### One-off setup per repository

1. **Create GitHub environments** for `pr.ephemeral.environment` and each `environments[].environment`, each with a `DEPLOYMENT_ROLE` secret.
   - Restrict deployment branches to `main` on shared environments, but not on the ephemeral one: PR branches deploy to it.
   - Add required reviewers on production.
2. **Update IAM trust policies.** Jobs that run in an environment present the OIDC subject `repo:govuk-once/<repo>:environment:<environment>`, instead of `ref:refs/heads/main` or `pull_request`. Each deployment role must trust the subject for its environment(s). The quality and release jobs use the ephemeral environment by default, so its role must also trust runs on `main`.
3. **Allow access to this repository:** Settings → Actions → General → Access (see the README).

## Hooks: putting repo-specific work in the pipeline

Callers can't insert their own jobs between shared stages, so repo-specific work runs as hooks:

- **Short commands** go inline in the config.
- **Anything longer** goes in a script under `scripts/ci/`. That keeps it testable locally and reviewable in the repository.
- **Long suites** can be started without waiting for them, as UDP's [perf.sh](../examples/udp/scripts/ci/perf.sh) does.
- **Work that should not gate promotion** (e.g. a ZAP scan) can be a normal job in the caller's release workflow with `needs: pipeline`; it runs after the whole pipeline. See [flex's release.yml](../examples/flex/.github/workflows/release.yml).

## Migrating a repository

1. **Add the config, scripts and IAM/environment setup** from the checklist above.
2. **Add the caller workflows** with only `workflow_dispatch` as the trigger, alongside the existing workflows. Run them and compare with the existing pipeline.
3. **Switch over:** move the triggers (`pull_request`, `push`) to the new callers and delete the old workflows and local actions.
4. **Update required status checks** in branch protection; job names change.

## Developing this repository

- Internal references use `govuk-once/platform-shared-ci-cd/...@v1`, because `./` would resolve against the caller's repository.
- To test a branch from a sandbox repository:
  1. Run `scripts/release.sh --pin <branch>` on a throwaway branch and push it.
  2. In the sandbox, reference the pipelines `@<that branch>`.
- **Release** with the *Release* workflow (manual): it runs the tests, then `scripts/release.sh vX.Y.Z --push`. That rewrites internal references to `@vX.Y.Z` in a release-only commit, tags it, moves `v1` and creates the GitHub release. Each tag therefore only uses code from that tag.
- Loader tests: `node --test actions/load-pipeline-config/` (the example configs are checked when `yq` is installed).


