import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export interface SecretMapping {
  secretName: string;
  envVarName: string;
}

export async function syncSecrets(mappings: SecretMapping[], region: string): Promise<void> {
  if (mappings.length === 0) return;

  const client = new SecretsManagerClient({ region });

  for (const { secretName, envVarName } of mappings) {
    const value = process.env[envVarName];

    if (!value) {
      throw new Error(
        `Environment variable '${envVarName}' is not set or empty (required for secret '${secretName}')`,
      );
    }

    const exists = await describeSecretExists(client, secretName);

    if (exists) {
      console.log(`Updating secret: ${secretName}`);
      await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: value }));
    } else {
      console.log(`Creating secret: ${secretName}`);
      await client.send(new CreateSecretCommand({ Name: secretName, SecretString: value }));
    }

    console.log(`  ✓ ${secretName}`);
  }
}

async function describeSecretExists(client: SecretsManagerClient, secretName: string): Promise<boolean> {
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return false;
    throw error;
  }
}
