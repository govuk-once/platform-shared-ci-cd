#!/usr/bin/env node
// Validates a pipeline config (already converted from YAML to JSON), applies
// defaults and expands placeholders. Zero dependencies so it runs on any runner
// with Node.js.
//
// CLI: node load.mjs <config.json>
//   env PR_NUMBER, GITHUB_SHA       placeholder values
//   env GITHUB_OUTPUT               when set, outputs are written there

import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export class ConfigError extends Error {}

export const MAX_ENVIRONMENTS = 4;

export const DEFAULT_TITLE = {
  pattern:
    "^[A-Z]+-[0-9]+ (feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\\([^)]+\\))?!?: .+",
  format: "<JIRA-REF> <type>(<scope>)?: <description>",
  examples:
    "ABC-123 feat: add user preferences endpoint\nABC-456 fix(api): handle empty payload\nABC-789 feat!: drop legacy auth",
  "guidance-url": "",
  "skip-actors": "dependabot[bot]",
  comment: false,
};

// Allowed keys per section. Exported so tests can check the JSON schema agrees.
export const KEYS = {
  root: ["application", "node", "aws", "pr", "quality", "release", "environments", "notifications"],
  node: ["version", "codeartifact"],
  aws: ["region"],
  pr: ["title", "ephemeral"],
  title: ["pattern", "format", "examples", "guidance-url", "skip-actors", "comment"],
  stage: [
    "name",
    "environment",
    "env",
    "working-directory",
    "deploy",
    "destroy",
    "pre-deploy",
    "post-deploy",
    "prerelease-tag",
    "outputs-stack",
    "release-notification",
    "timeout-minutes",
  ],
  releaseNotification: ["slack-channel"],
  hook: ["name", "run"],
  quality: [
    "environment",
    "aws",
    "nx",
    "setup",
    "checks",
    "dependency-review",
    "conventional-commits",
    "sonar",
  ],
  sonar: ["test", "args"],
  release: ["enabled"],
  notifications: ["topic-arn", "topic-arn-ssm-parameter", "notify-on"],
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOTIFY_EVENTS = ["success", "failure"];

const fail = (path, message) => {
  throw new ConfigError(`${path}: ${message}`);
};

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v) => v === undefined || v === null;

function mapping(v, path, keys) {
  if (absent(v)) return {};
  if (!isMapping(v)) fail(path, "must be a mapping");
  for (const key of Object.keys(v)) {
    if (!keys.includes(key)) fail(path, `unknown key "${key}" (allowed: ${keys.join(", ")})`);
  }
  return v;
}

function string(v, path, { required = false, fallback = "" } = {}) {
  if (absent(v)) {
    if (required) fail(path, "is required");
    return fallback;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") fail(path, "must be a string");
  if (required && v.trim() === "") fail(path, "must not be empty");
  return v;
}

function boolean(v, path, fallback = false) {
  if (absent(v)) return fallback;
  if (typeof v !== "boolean") fail(path, "must be true or false");
  return v;
}

function integer(v, path, fallback) {
  if (absent(v)) return fallback;
  if (!Number.isInteger(v) || v <= 0) fail(path, "must be a positive whole number");
  return v;
}

function list(v, path) {
  if (absent(v)) return [];
  if (!Array.isArray(v)) fail(path, "must be a list");
  return v;
}

// Replaces {pr}, {sha} and {env}. {version} is left for the stage to resolve at
// deploy time, and any other braces (e.g. shell syntax) are untouched.
function expand(value, ctx) {
  return value
    .replaceAll("{pr}", ctx.pr)
    .replaceAll("{sha}", ctx.sha)
    .replaceAll("{env}", ctx.env ?? "");
}

function hooks(v, path) {
  return list(v, path).map((hook, i) => {
    const p = `${path}[${i}]`;
    if (typeof hook === "string") {
      if (hook.trim() === "") fail(p, "must not be empty");
      return { name: hook.split("\n")[0].slice(0, 60), run: hook };
    }
    const h = mapping(hook, p, KEYS.hook);
    const run = string(h.run, `${p}.run`, { required: true });
    return { name: string(h.name, `${p}.name`, { fallback: run.split("\n")[0].slice(0, 60) }), run };
  });
}

function envVars(v, path, ctx) {
  const out = {};
  if (absent(v)) return out;
  if (!isMapping(v)) fail(path, "must be a mapping of NAME: value");
  for (const [key, value] of Object.entries(v)) {
    if (!ENV_KEY.test(key)) fail(path, `"${key}" is not a valid environment variable name`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      fail(`${path}.${key}`, "must be a string, number or boolean");
    }
    const s = String(value);
    if (s.includes("\n")) fail(`${path}.${key}`, "must be a single line");
    out[key] = expand(s, ctx);
  }
  return out;
}

function stage(v, path, ctx, { defaultName, requireDeploy }) {
  const s = mapping(v, path, KEYS.stage);
  if (!isMapping(v)) fail(path, "must be a mapping");

  const name = string(s.name, `${path}.name`, { required: !defaultName, fallback: defaultName });
  const stageCtx = { ...ctx, env: name };

  let releaseNotification = null;
  if (!absent(s["release-notification"])) {
    const rn = mapping(s["release-notification"], `${path}.release-notification`, KEYS.releaseNotification);
    releaseNotification = {
      "slack-channel": string(rn["slack-channel"], `${path}.release-notification.slack-channel`, {
        required: true,
      }),
    };
  }

  const result = {
    name,
    environment: string(s.environment, `${path}.environment`, { fallback: name }),
    env: envVars(s.env, `${path}.env`, stageCtx),
    "working-directory": string(s["working-directory"], `${path}.working-directory`, { fallback: "." }),
    deploy: string(s.deploy, `${path}.deploy`, { required: requireDeploy }),
    destroy: string(s.destroy, `${path}.destroy`),
    "pre-deploy": hooks(s["pre-deploy"], `${path}.pre-deploy`),
    "post-deploy": hooks(s["post-deploy"], `${path}.post-deploy`),
    "prerelease-tag": string(s["prerelease-tag"], `${path}.prerelease-tag`),
    "outputs-stack": expand(string(s["outputs-stack"], `${path}.outputs-stack`), stageCtx),
    "release-notification": releaseNotification,
    "timeout-minutes": integer(s["timeout-minutes"], `${path}.timeout-minutes`, 60),
  };
  if (result.environment.trim() === "") fail(`${path}.environment`, "must not be empty");
  return result;
}

export function loadConfig(raw, { pr = "", sha = "" } = {}) {
  const ctx = { pr: String(pr), sha: String(sha) };
  if (!isMapping(raw)) fail("config", "must be a mapping");
  const root = mapping(raw, "config", KEYS.root);

  const application = string(root.application, "application", { required: true });

  const nodeCfg = mapping(root.node, "node", KEYS.node);
  const node = {
    version: string(nodeCfg.version, "node.version"),
    codeartifact: boolean(nodeCfg.codeartifact, "node.codeartifact"),
  };

  const awsCfg = mapping(root.aws, "aws", KEYS.aws);
  const aws = { region: string(awsCfg.region, "aws.region", { fallback: "eu-west-2" }) };

  // PR
  const prCfg = mapping(root.pr, "pr", KEYS.pr);
  let title = null;
  if (prCfg.title !== false) {
    const t = mapping(prCfg.title, "pr.title", KEYS.title);
    title = {
      pattern: string(t.pattern, "pr.title.pattern", { fallback: DEFAULT_TITLE.pattern }),
      format: string(t.format, "pr.title.format", { fallback: DEFAULT_TITLE.format }),
      examples: string(t.examples, "pr.title.examples", { fallback: DEFAULT_TITLE.examples }),
      "guidance-url": string(t["guidance-url"], "pr.title.guidance-url"),
      "skip-actors": string(t["skip-actors"], "pr.title.skip-actors", {
        fallback: DEFAULT_TITLE["skip-actors"],
      }),
      comment: boolean(t.comment, "pr.title.comment"),
    };
    try {
      new RegExp(title.pattern);
    } catch (e) {
      fail("pr.title.pattern", `is not a valid regular expression (${e.message})`);
    }
  }
  const ephemeral = absent(prCfg.ephemeral)
    ? null
    : stage(prCfg.ephemeral, "pr.ephemeral", ctx, { defaultName: "ephemeral", requireDeploy: true });

  // Environments
  const envList = list(root.environments, "environments");
  if (envList.length > MAX_ENVIRONMENTS) {
    fail("environments", `at most ${MAX_ENVIRONMENTS} environments are supported (got ${envList.length})`);
  }
  const environments = envList.map((e, i) =>
    stage(e, `environments[${i}]`, ctx, { requireDeploy: true }),
  );
  const seen = new Set();
  for (const e of environments) {
    if (seen.has(e.name)) fail("environments", `duplicate environment name "${e.name}"`);
    seen.add(e.name);
  }

  // Quality
  const q = mapping(root.quality, "quality", KEYS.quality);
  let sonar = null;
  if (!absent(q.sonar) && q.sonar !== false) {
    const sc = q.sonar === true ? {} : mapping(q.sonar, "quality.sonar", KEYS.sonar);
    sonar = { test: string(sc.test, "quality.sonar.test"), args: string(sc.args, "quality.sonar.args") };
  }
  const quality = {
    aws: boolean(q.aws, "quality.aws"),
    nx: boolean(q.nx, "quality.nx"),
    setup: string(q.setup, "quality.setup"),
    checks: hooks(q.checks, "quality.checks"),
    "dependency-review": boolean(q["dependency-review"], "quality.dependency-review"),
    "conventional-commits": boolean(q["conventional-commits"], "quality.conventional-commits"),
    sonar,
    environment: string(q.environment, "quality.environment"),
  };
  // Jobs that install dependencies need AWS credentials for CodeArtifact, and
  // credentials come from a GitHub environment's DEPLOYMENT_ROLE secret.
  if ((quality.aws || node.codeartifact) && !quality.environment) {
    quality.environment = ephemeral?.environment ?? environments[0]?.environment ?? "";
    if (!quality.environment) {
      fail(
        "quality.environment",
        "is required when quality.aws or node.codeartifact is set and there is no pr.ephemeral or environments entry",
      );
    }
  }
  quality["has-checks"] = quality.setup !== "" || quality.checks.length > 0;
  quality["has-security"] = quality["dependency-review"] || quality["conventional-commits"];

  // Release
  const r = mapping(root.release, "release", KEYS.release);
  const release = { enabled: boolean(r.enabled, "release.enabled", true) };

  // Notifications
  const n = mapping(root.notifications, "notifications", KEYS.notifications);
  const notifications = {
    "topic-arn": string(n["topic-arn"], "notifications.topic-arn"),
    "topic-arn-ssm-parameter": string(n["topic-arn-ssm-parameter"], "notifications.topic-arn-ssm-parameter"),
    "notify-on": [],
  };
  const hasTopic = notifications["topic-arn"] !== "" || notifications["topic-arn-ssm-parameter"] !== "";
  const notifyOn = absent(n["notify-on"]) ? (hasTopic ? ["failure"] : []) : list(n["notify-on"], "notifications.notify-on");
  for (const ev of notifyOn) {
    if (!NOTIFY_EVENTS.includes(ev)) fail("notifications.notify-on", `"${ev}" must be one of ${NOTIFY_EVENTS.join(", ")}`);
  }
  if (notifyOn.length > 0 && !hasTopic) {
    fail("notifications", "notify-on is set but neither topic-arn nor topic-arn-ssm-parameter is");
  }
  notifications["notify-on"] = [...new Set(notifyOn)];

  return {
    application,
    node,
    aws,
    pr: { title, ephemeral },
    quality,
    release,
    environments,
    notifications,
  };
}

function writeOutputs(config, file) {
  const outputs = {
    config: JSON.stringify(config),
    "environment-count": String(config.environments.length),
    "has-ephemeral": String(config.pr.ephemeral !== null),
    "has-destroy": String(config.pr.ephemeral !== null && config.pr.ephemeral.destroy !== ""),
  };
  for (const [key, value] of Object.entries(outputs)) {
    const delimiter = `EOF_${Math.random().toString(36).slice(2)}`;
    appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("usage: load.mjs <config.json>");
    process.exit(2);
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const config = loadConfig(raw, { pr: process.env.PR_NUMBER ?? "", sha: process.env.GITHUB_SHA ?? "" });
    if (process.env.GITHUB_OUTPUT) writeOutputs(config, process.env.GITHUB_OUTPUT);
    else console.log(JSON.stringify(config, null, 2));
    const stages = config.environments.map((e) => e.name).join(" → ") || "(none)";
    console.log(`Pipeline config for ${config.application}: environments ${stages}`);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.log(`::error title=Invalid pipeline config::${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
