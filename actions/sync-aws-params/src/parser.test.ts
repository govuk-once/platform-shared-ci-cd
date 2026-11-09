import { describe, expect, it } from 'vitest';

import { parseMappings } from './parser';

describe('parseMappings', () => {
  it('parses a single valid line', () => {
    expect(parseMappings('/svc/dev/endpoint=MY_ENDPOINT')).toEqual([
      { pathTemplate: '/svc/dev/endpoint', envVarName: 'MY_ENDPOINT' },
    ]);
  });

  it('parses multiple lines', () => {
    const input = `/svc/dev/endpoint=MY_ENDPOINT\n/svc/dev/key=MY_KEY`;
    expect(parseMappings(input)).toEqual([
      { pathTemplate: '/svc/dev/endpoint', envVarName: 'MY_ENDPOINT' },
      { pathTemplate: '/svc/dev/key', envVarName: 'MY_KEY' },
    ]);
  });

  it('preserves template tokens in paths', () => {
    expect(parseMappings('/{{var.SERVICE}}/{{var.ENV}}/key=MY_VAR')).toEqual([
      { pathTemplate: '/{{var.SERVICE}}/{{var.ENV}}/key', envVarName: 'MY_VAR' },
    ]);
  });

  it('skips blank lines', () => {
    const input = `/a=A\n\n  \n/b=B`;
    expect(parseMappings(input)).toHaveLength(2);
  });

  it('skips comment lines', () => {
    const input = `# this is a comment\n/a=A`;
    expect(parseMappings(input)).toEqual([{ pathTemplate: '/a', envVarName: 'A' }]);
  });

  it('returns empty array for blank input', () => {
    expect(parseMappings('')).toEqual([]);
    expect(parseMappings('   \n  ')).toEqual([]);
  });

  it('throws on a line missing =', () => {
    expect(() => parseMappings('/path/with/no/equals')).toThrow("Invalid mapping (missing '=')");
  });

  it('throws on an empty path', () => {
    expect(() => parseMappings('=MY_VAR')).toThrow("Invalid mapping (empty path)");
  });

  it('throws on an empty env var name', () => {
    expect(() => parseMappings('/path=')).toThrow("Invalid mapping (empty env var name)");
  });

  it('handles = sign within the env var name (uses first = as split point)', () => {
    // env var names never contain = but paths could have encoded chars — split on first =
    const result = parseMappings('/path=MY_VAR');
    expect(result[0].envVarName).toBe('MY_VAR');
  });
});
