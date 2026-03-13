import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  serviceAccountKeyPath: string;
}

export interface ConfigError {
  variable: string;
  message: string;
}

export function getConfigErrors(): ConfigError[] {
  const errors: ConfigError[] = [];
  const keyPath = process.env.GPLAY_SERVICE_ACCOUNT_KEY;

  if (!keyPath) {
    errors.push({
      variable: 'GPLAY_SERVICE_ACCOUNT_KEY',
      message: 'Not set. Must be an absolute path to a Google Cloud service account JSON key file.',
    });
  } else {
    const resolvedPath = resolve(keyPath);
    if (!existsSync(resolvedPath)) {
      errors.push({
        variable: 'GPLAY_SERVICE_ACCOUNT_KEY',
        message: `File not found at: ${resolvedPath}`,
      });
    }
  }

  return errors;
}

export function loadConfig(): Config | null {
  const errors = getConfigErrors();
  if (errors.length > 0) return null;

  const keyPath = process.env.GPLAY_SERVICE_ACCOUNT_KEY!;
  return { serviceAccountKeyPath: resolve(keyPath) };
}
