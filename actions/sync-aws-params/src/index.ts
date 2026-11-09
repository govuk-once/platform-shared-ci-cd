import * as core from '@actions/core';

import { parseMappings } from './parser';
import { syncSecrets } from './secrets';
import { syncSsmParams } from './ssm';
import { expandTemplate, TemplateVars } from './template';

async function run(): Promise<void> {
  const environment = core.getInput('environment', { required: true });
  const serviceName = core.getInput('service_name', { required: true });
  const ssmParamsInput = core.getInput('ssm_params');
  const secretsParamsInput = core.getInput('secrets_params');
  const awsRegion = core.getInput('aws_region') || 'eu-west-2';

  const vars: TemplateVars = { ENV: environment, SERVICE: serviceName };

  if (ssmParamsInput.trim()) {
    core.info('--- Syncing SSM Parameters ---');
    const mappings = parseMappings(ssmParamsInput).map(({ pathTemplate, envVarName }) => ({
      path: expandTemplate(pathTemplate, vars),
      envVarName,
    }));
    await syncSsmParams(mappings, awsRegion);
  }

  if (secretsParamsInput.trim()) {
    core.info('--- Syncing Secrets Manager Secrets ---');
    const mappings = parseMappings(secretsParamsInput).map(({ pathTemplate, envVarName }) => ({
      secretName: expandTemplate(pathTemplate, vars),
      envVarName,
    }));
    await syncSecrets(mappings, awsRegion);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
