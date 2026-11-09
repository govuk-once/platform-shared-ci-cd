import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncSecrets } from './secrets';

const smMock = mockClient(SecretsManagerClient);

describe('syncSecrets', () => {
  beforeEach(() => {
    smMock.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('updates an existing secret with PutSecretValue', async () => {
    smMock.on(DescribeSecretCommand).resolves({});
    smMock.on(PutSecretValueCommand).resolves({});
    vi.stubEnv('MY_SECRET', 'super-secret');

    await syncSecrets([{ secretName: 'dev/svc/db', envVarName: 'MY_SECRET' }], 'eu-west-2');

    const putCalls = smMock.commandCalls(PutSecretValueCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input).toEqual({
      SecretId: 'dev/svc/db',
      SecretString: 'super-secret',
    });

    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('creates a new secret when it does not exist', async () => {
    smMock.on(DescribeSecretCommand).rejects(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} }),
    );
    smMock.on(CreateSecretCommand).resolves({});
    vi.stubEnv('MY_SECRET', 'new-value');

    await syncSecrets([{ secretName: 'dev/svc/new', envVarName: 'MY_SECRET' }], 'eu-west-2');

    const createCalls = smMock.commandCalls(CreateSecretCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0].input).toEqual({
      Name: 'dev/svc/new',
      SecretString: 'new-value',
    });

    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it('does nothing when mappings list is empty', async () => {
    await syncSecrets([], 'eu-west-2');
    expect(smMock.calls()).toHaveLength(0);
  });

  it('throws if the env var is not set', async () => {
    await expect(
      syncSecrets([{ secretName: 'dev/svc/missing', envVarName: 'NOT_SET' }], 'eu-west-2'),
    ).rejects.toThrow("Environment variable 'NOT_SET' is not set or empty");
  });

  it('throws if the env var is an empty string', async () => {
    vi.stubEnv('EMPTY_SECRET', '');

    await expect(
      syncSecrets([{ secretName: 'dev/svc/empty', envVarName: 'EMPTY_SECRET' }], 'eu-west-2'),
    ).rejects.toThrow("Environment variable 'EMPTY_SECRET' is not set or empty");
  });

  it('propagates unexpected DescribeSecret errors', async () => {
    smMock.on(DescribeSecretCommand).rejects(new Error('AccessDeniedException'));
    vi.stubEnv('MY_SECRET', 'value');

    await expect(
      syncSecrets([{ secretName: 'dev/svc/secret', envVarName: 'MY_SECRET' }], 'eu-west-2'),
    ).rejects.toThrow('AccessDeniedException');
  });

  it('propagates PutSecretValue errors', async () => {
    smMock.on(DescribeSecretCommand).resolves({});
    smMock.on(PutSecretValueCommand).rejects(new Error('InvalidRequestException'));
    vi.stubEnv('MY_SECRET', 'value');

    await expect(
      syncSecrets([{ secretName: 'dev/svc/secret', envVarName: 'MY_SECRET' }], 'eu-west-2'),
    ).rejects.toThrow('InvalidRequestException');
  });

  it('processes multiple mappings', async () => {
    smMock.on(DescribeSecretCommand).resolves({});
    smMock.on(PutSecretValueCommand).resolves({});
    vi.stubEnv('SECRET_A', 'val-a');
    vi.stubEnv('SECRET_B', 'val-b');

    await syncSecrets(
      [
        { secretName: 'dev/svc/a', envVarName: 'SECRET_A' },
        { secretName: 'dev/svc/b', envVarName: 'SECRET_B' },
      ],
      'eu-west-2',
    );

    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(2);
  });
});
