import { describe, expect, it } from 'vitest';

import { expandTemplate } from './template';

const vars = { ENV: 'dev', SERVICE: 'idx' };

describe('expandTemplate', () => {
  it('expands {{var.ENV}}', () => {
    expect(expandTemplate('/{{var.ENV}}/key', vars)).toBe('/dev/key');
  });

  it('expands {{var.SERVICE}}', () => {
    expect(expandTemplate('/{{var.SERVICE}}/key', vars)).toBe('/idx/key');
  });

  it('expands both tokens in one path', () => {
    expect(expandTemplate('/{{var.SERVICE}}/{{var.ENV}}/endpoint', vars)).toBe('/idx/dev/endpoint');
  });

  it('returns the string unchanged when no tokens are present', () => {
    expect(expandTemplate('/static/path', vars)).toBe('/static/path');
  });

  it('throws on an unknown token', () => {
    expect(() => expandTemplate('/{{var.UNKNOWN}}/key', vars)).toThrow(
      "Unknown template token: '{{var.UNKNOWN}}'",
    );
  });

  it('expands repeated tokens', () => {
    expect(expandTemplate('{{var.ENV}}-{{var.ENV}}', vars)).toBe('dev-dev');
  });
});
