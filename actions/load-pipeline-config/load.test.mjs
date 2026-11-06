import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, ConfigError, KEYS, DEFAULT_TITLE } from "./load.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const minimal = () => ({
  application: "Test",
  environments: [{ name: "dev", deploy: "pnpm deploy:dev" }],
});

const throwsConfig = (raw, match) =>
  assert.throws(() => loadConfig(raw), (e) => e instanceof ConfigError && match.test(e.message));

test("applies defaults to a minimal config", () => {
  const c = loadConfig(minimal());
  assert.equal(c.aws.region, "eu-west-2");
  assert.equal(c.node.codeartifact, false);
  assert.deepEqual(c.pr.title, DEFAULT_TITLE);
  assert.equal(c.pr.ephemeral, null);
  assert.equal(c.release.enabled, true);
  assert.deepEqual(c.notifications["notify-on"], []);
  const [dev] = c.environments;
  assert.equal(dev.environment, "dev");
  assert.equal(dev["working-directory"], ".");
  assert.equal(dev["timeout-minutes"], 60);
  assert.deepEqual(dev["post-deploy"], []);
  assert.equal(c.quality["has-checks"], false);
});

test("expands placeholders but leaves {version} and shell braces alone", () => {
  const raw = minimal();
  raw.pr = {
    ephemeral: {
      deploy: "x",
      env: { DEVELOPER_ID: "pr-{pr}", TAG: "{env}-{sha}-{version}", RAW: "${HOME}" },
      "outputs-stack": "pr-{pr}-dev-e2e",
    },
  };
  const c = loadConfig(raw, { pr: 42, sha: "abc" });
  assert.deepEqual(c.pr.ephemeral.env, {
    DEVELOPER_ID: "pr-42",
    TAG: "ephemeral-abc-{version}",
    RAW: "${HOME}",
  });
  assert.equal(c.pr.ephemeral["outputs-stack"], "pr-42-dev-e2e");
});

test("normalises hooks given as strings or mappings", () => {
  const raw = minimal();
  raw.environments[0]["post-deploy"] = ["./e2e.sh", { name: "Perf", run: "./perf.sh\n--smoke" }, { run: "a\nb" }];
  const hooks = loadConfig(raw).environments[0]["post-deploy"];
  assert.deepEqual(hooks, [
    { name: "./e2e.sh", run: "./e2e.sh" },
    { name: "Perf", run: "./perf.sh\n--smoke" },
    { name: "a", run: "a\nb" },
  ]);
});

test("title: false disables the title check", () => {
  const raw = minimal();
  raw.pr = { title: false };
  assert.equal(loadConfig(raw).pr.title, null);
});

test("quality environment defaults to the ephemeral environment when AWS is needed", () => {
  const raw = minimal();
  raw.node = { codeartifact: true };
  raw.pr = { ephemeral: { environment: "preview", deploy: "x" } };
  assert.equal(loadConfig(raw).quality.environment, "preview");

  delete raw.pr;
  assert.equal(loadConfig(raw).quality.environment, "dev");

  raw.environments = [];
  throwsConfig(raw, /quality.environment: is required/);
});

test("sonar accepts true or a mapping", () => {
  const raw = minimal();
  raw.quality = { sonar: true };
  assert.deepEqual(loadConfig(raw).quality.sonar, { test: "", args: "" });
  raw.quality = { sonar: { test: "pnpm test" } };
  assert.equal(loadConfig(raw).quality.sonar.test, "pnpm test");
  raw.quality = { sonar: false };
  assert.equal(loadConfig(raw).quality.sonar, null);
});

test("notify-on defaults to failure when a topic is set", () => {
  const raw = minimal();
  raw.notifications = { "topic-arn-ssm-parameter": "/x" };
  assert.deepEqual(loadConfig(raw).notifications["notify-on"], ["failure"]);
});

test("rejects invalid configs with a useful path", () => {
  const cases = [
    [{ environments: [] }, /application: is required/],
    [{ ...minimal(), enviroments: [] }, /unknown key "enviroments"/],
    [{ ...minimal(), environments: [{ name: "dev" }] }, /environments\[0\].deploy: is required/],
    [{ ...minimal(), environments: [{ deploy: "x" }] }, /environments\[0\].name: is required/],
    [
      { ...minimal(), environments: ["a", "b", "c", "d", "e"].map((name) => ({ name, deploy: "x" })) },
      /at most 4/,
    ],
    [
      { ...minimal(), environments: [{ name: "a", deploy: "x" }, { name: "a", deploy: "y" }] },
      /duplicate environment name "a"/,
    ],
    [{ ...minimal(), pr: { ephemeral: { deploy: "x", env: { "BAD-KEY": "1" } } } }, /not a valid environment variable/],
    [{ ...minimal(), pr: { ephemeral: { deploy: "x", env: { A: "1\n2" } } } }, /single line/],
    [{ ...minimal(), pr: { ephemeral: { env: {} } } }, /pr.ephemeral.deploy: is required/],
    [{ ...minimal(), pr: { title: { pattern: "(" } } }, /not a valid regular expression/],
    [{ ...minimal(), notifications: { "notify-on": ["failure"] } }, /neither topic-arn/],
    [{ ...minimal(), notifications: { "topic-arn": "x", "notify-on": ["always"] } }, /must be one of/],
    [{ ...minimal(), environments: [{ name: "a", deploy: "x", "post-deploy": [{ name: "n" }] }] }, /run: is required/],
    [{ ...minimal(), environments: [{ name: "a", deploy: "x", "release-notification": {} }] }, /slack-channel: is required/],
    [{ ...minimal(), environments: [{ name: "a", deploy: "x", "timeout-minutes": 0 }] }, /positive whole number/],
  ];
  for (const [raw, match] of cases) throwsConfig(raw, match);
});

test("JSON schema lists the same keys as the loader", () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, "schema", "pipeline.schema.json"), "utf8"));
  const keys = (o) => Object.keys(o.properties).sort();
  const p = schema.properties;
  const pairs = [
    [keys(schema), KEYS.root],
    [keys(p.node), KEYS.node],
    [keys(p.aws), KEYS.aws],
    [keys(p.pr), KEYS.pr],
    [keys(p.pr.properties.title.oneOf[1]), KEYS.title],
    [keys(schema.$defs.stage), KEYS.stage],
    [keys(schema.$defs.stage.properties["release-notification"]), KEYS.releaseNotification],
    [keys(schema.$defs.hooks.items.oneOf[1]), KEYS.hook],
    [keys(p.quality), KEYS.quality],
    [keys(p.quality.properties.sonar.oneOf[1]), KEYS.sonar],
    [keys(p.release), KEYS.release],
    [keys(p.notifications), KEYS.notifications],
  ];
  for (const [fromSchema, fromLoader] of pairs) assert.deepEqual(fromSchema, [...fromLoader].sort());
});

// Example configs are YAML; convert with yq when it is available (always on CI).
const hasYq = (() => {
  try {
    execFileSync("yq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("example configs are valid", { skip: !hasYq && "yq not installed" }, () => {
  const examples = join(repoRoot, "examples");
  for (const dir of readdirSync(examples)) {
    const file = join(examples, dir, ".github", "pipeline.yml");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(execFileSync("yq", ["-o=json", "explode(.)", file], { encoding: "utf8" }));
    assert.doesNotThrow(() => loadConfig(raw, { pr: 1, sha: "abc" }), `examples/${dir}`);
  }
});
