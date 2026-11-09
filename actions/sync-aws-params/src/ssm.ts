import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface SsmMapping {
  path: string;
  envVarName: string;
}

export async function syncSsmParams(mappings: SsmMapping[], region: string): Promise<void> {
  if (mappings.length === 0) return;

  const client = new SSMClient({ region });

  for (const { path, envVarName } of mappings) {
    const value = process.env[envVarName];

    if (!value) {
      throw new Error(
        `Environment variable '${envVarName}' is not set or empty (required for SSM parameter '${path}')`,
      );
    }

    console.log(`Writing SSM parameter: ${path}`);

    await client.send(
      new PutParameterCommand({
        Name: path,
        Value: value,
        Type: 'String',
        Overwrite: true,
      }),
    );

    console.log(`  ✓ ${path}`);
  }
}
