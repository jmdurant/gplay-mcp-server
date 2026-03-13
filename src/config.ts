import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  serviceAccountKeyPath: string;
}

export function loadConfig(): Config {
  const keyPath = process.env.GPLAY_SERVICE_ACCOUNT_KEY;

  if (!keyPath) throw new Error('GPLAY_SERVICE_ACCOUNT_KEY environment variable is required (path to service account JSON key file)');

  const resolvedPath = resolve(keyPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Service account key file not found: ${resolvedPath}`);
  }

  return { serviceAccountKeyPath: resolvedPath };
}
