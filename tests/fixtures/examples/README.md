Files layered over `examples/<name>` when building the act workspace, so the
example's scripts and callers find the repository layout they expect: a `cdk/`
directory, a synthesised template, a package.json in a stage's
`working-directory`, and stand-ins for repo-local workflows (flex's `zap.yml`).
