import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncSsmParams } from './ssm';

const ssmMock = mockClient(SSMClient);

describe('syncSsmParams', () => {
  beforeEach(() => {
    ssmMock.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls PutParameter with the correct path, value, and Overwrite: true', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    vi.stubEnv('MY_ENDPOINT', 'https://example.com');

    await syncSsmParams([{ path: '/svc/dev/endpoint', envVarName: 'MY_ENDPOINT' }], 'eu-west-2');

    const calls = ssmMock.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      Name: '/svc/dev/endpoint',
      Value: 'https://example.com',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('writes all mappings in order', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    vi.stubEnv('A', 'value-a');
    vi.stubEnv('B', 'value-b');

    await syncSsmParams(
      [
        { path: '/svc/dev/a', envVarName: 'A' },
        { path: '/svc/dev/b', envVarName: 'B' },
      ],
      'eu-west-2',
    );

    expect(ssmMock.calls()).toHaveLength(2);
  });

  it('does nothing when mappings list is empty', async () => {
    await syncSsmParams([], 'eu-west-2');
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it('throws if the env var is not set', async () => {
    await expect(
      syncSsmParams([{ path: '/svc/dev/missing', envVarName: 'NOT_SET_VAR' }], 'eu-west-2'),
    ).rejects.toThrow("Environment variable 'NOT_SET_VAR' is not set or empty");
  });

  it('throws if the env var is an empty string', async () => {
    vi.stubEnv('EMPTY_VAR', '');

    await expect(
      syncSsmParams([{ path: '/svc/dev/empty', envVarName: 'EMPTY_VAR' }], 'eu-west-2'),
    ).rejects.toThrow("Environment variable 'EMPTY_VAR' is not set or empty");
  });

  it('propagates AWS errors and fails the pipeline', async () => {
    ssmMock.on(PutParameterCommand).rejects(new Error('AccessDeniedException'));
    vi.stubEnv('MY_PARAM', 'value');

    await expect(
      syncSsmParams([{ path: '/svc/dev/param', envVarName: 'MY_PARAM' }], 'eu-west-2'),
    ).rejects.toThrow('AccessDeniedException');
  });

  it('stops processing on first AWS error', async () => {
    ssmMock.on(PutParameterCommand).rejects(new Error('ThrottlingException'));
    vi.stubEnv('A', 'val-a');
    vi.stubEnv('B', 'val-b');

    await expect(
      syncSsmParams(
        [
          { path: '/svc/dev/a', envVarName: 'A' },
          { path: '/svc/dev/b', envVarName: 'B' },
        ],
        'eu-west-2',
      ),
    ).rejects.toThrow('ThrottlingException');

    expect(ssmMock.calls()).toHaveLength(1);
  });
});
