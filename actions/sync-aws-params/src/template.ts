export interface TemplateVars {
  ENV: string;
  SERVICE: string;
}

/**
 * Expands {{var.ENV}} and {{var.SERVICE}} tokens in a template string.
 * Throws on unrecognised tokens so typos are caught at pipeline time.
 */
export function expandTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, token: string) => {
    const trimmed = token.trim();
    if (trimmed === 'var.ENV') return vars.ENV;
    if (trimmed === 'var.SERVICE') return vars.SERVICE;
    throw new Error(`Unknown template token: '${match}'`);
  });
}
