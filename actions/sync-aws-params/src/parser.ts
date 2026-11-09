export interface Mapping {
  pathTemplate: string;
  envVarName: string;
}

/**
 * Parses a multiline mapping block of the form:
 *   /path/{{var.SERVICE}}/{{var.ENV}}/key=ENV_VAR_NAME
 *
 * Blank lines and lines starting with '#' are ignored.
 */
export function parseMappings(input: string): Mapping[] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) {
        throw new Error(`Invalid mapping (missing '='): '${line}'`);
      }

      const pathTemplate = line.slice(0, eqIndex).trim();
      const envVarName = line.slice(eqIndex + 1).trim();

      if (!pathTemplate) {
        throw new Error(`Invalid mapping (empty path): '${line}'`);
      }
      if (!envVarName) {
        throw new Error(`Invalid mapping (empty env var name): '${line}'`);
      }

      return { pathTemplate, envVarName };
    });
}
