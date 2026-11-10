# Composite actions

Composite actions for use as steps inside a caller's own jobs. For reusable workflows, see the [repository README](../README.md).

Each action lives in its own directory because GitHub resolves `uses: owner/repo/<path>@<ref>` to `<path>/action.yml`.

| Action                                                                | Purpose                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`actions/setup-node-pnpm`](#setup-nodejs-and-pnpm)                   | Sets up pnpm and Node.js, optionally authenticates to AWS CodeArtifact, and installs dependencies. |
| [`actions/validate-conventional-commits`](#validate-conventional-commits) | Checks that the commits in a pull request follow the Conventional Commits format.              |

## Setup Node.js and pnpm

Installs pnpm at the version in `package.json`'s `packageManager` field, sets up Node.js with the pnpm store cached, optionally authenticates to AWS CodeArtifact, and runs `pnpm install --frozen-lockfile`.

### Usage

```yaml
steps:
  - uses: actions/checkout@<sha> # v6
    with:
      persist-credentials: false

  - uses: govuk-once/platform-shared-ci-cd/actions/setup-node-pnpm@v1
    with:
      codeartifact-role: ${{ secrets.deployment-role }} # omit if you don't use CodeArtifact
```

The Node.js version comes from `node-version` if set, otherwise from `.nvmrc` (any value `actions/setup-node` accepts, such as `24` or `lts/krypton`), otherwise `24`.

### CodeArtifact

When `codeartifact-role` is set, the action assumes the role via GitHub OIDC (the job needs `id-token: write`), fetches a CodeArtifact auth token and writes **only** the token line to the user-level `~/.npmrc`:

```txt
//registry-prod-904690835784.d.codeartifact.eu-west-2.amazonaws.com/npm/registry-prod-repo/:_authToken=***
```

The repository's own `.npmrc` stays in control of which packages resolve from CodeArtifact (for example `@govuk-connect:registry=…`) and of settings such as `min-release-age`. The role's AWS credentials are not exported to later steps in the job. The action warns if the repository's `.npmrc` doesn't reference the CodeArtifact endpoint, because the token would then be unused.

### Inputs

| Input                       | Required | Default              | Description                                                                |
| --------------------------- | -------- | -------------------- | -------------------------------------------------------------------------- |
| `node-version`              | No       | —                    | Node.js version. Overrides `node-version-file`.                            |
| `node-version-file`         | No       | `.nvmrc`             | File, relative to `working-directory`, to read the version from.           |
| `cache`                     | No       | `true`               | Cache the pnpm store.                                                      |
| `install`                   | No       | `true`               | Run `pnpm install`.                                                        |
| `install-args`              | No       | `--frozen-lockfile`  | Arguments for `pnpm install`, e.g. `--frozen-lockfile --filter @app/docs`. |
| `working-directory`         | No       | `.`                  | Directory containing `package.json` and `pnpm-lock.yaml`.                  |
| `codeartifact-role`         | No       | —                    | IAM role ARN for CodeArtifact. Empty skips CodeArtifact.                   |
| `codeartifact-domain`       | No       | `registry-prod`      | CodeArtifact domain.                                                       |
| `codeartifact-repository`   | No       | `registry-prod-repo` | CodeArtifact repository.                                                   |
| `codeartifact-domain-owner` | No       | `904690835784`       | AWS account that owns the domain.                                          |
| `codeartifact-region`       | No       | `eu-west-2`          | Region of the domain.                                                      |

### Outputs

| Output         | Description                    |
| -------------- | ------------------------------ |
| `node-version` | The Node.js version requested. |

## Validate Conventional Commits

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

| Input         | Required | Default                                                        | Description                                              |
| ------------- | -------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `types`       | No       | `feat fix chore docs style refactor test perf ci build revert` | Space-separated allowed commit types.                    |
| `mode`        | No       | `at-least-one`                                                 | `at-least-one` or `all`.                                 |
| `base-sha`    | No       | PR base SHA                                                    | Base commit (exclusive).                                 |
| `head-sha`    | No       | PR head SHA                                                    | Head commit (inclusive).                                 |
| `skip-actors` | No       | `dependabot[bot]`                                              | Space-separated PR authors whose commits aren't checked. |

### Outputs

| Output  | Description                                                                    |
| ------- | ------------------------------------------------------------------------------ |
| `valid` | `true` when the commits are valid or the check was skipped; otherwise `false`. |