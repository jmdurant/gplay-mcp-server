import { GoogleAuth } from 'google-auth-library';
import { GooglePlayError } from './errors.js';
import type { Config } from './config.js';

const BASE_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

export class GooglePlayClient {
  private auth: GoogleAuth;

  constructor(config: Config) {
    this.auth = new GoogleAuth({
      keyFilename: config.serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  }

  async request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    rawBody?: Buffer;
    contentType?: string;
  }): Promise<T> {
    const client = await this.auth.getClient();
    const method = options?.method ?? 'GET';

    let url = `${BASE_URL}${path}`;
    if (options?.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) searchParams.set(key, value);
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {};
    const accessToken = await client.getAccessToken();
    if (accessToken.token) {
      headers['Authorization'] = `Bearer ${accessToken.token}`;
    }

    let body: string | Uint8Array | undefined;
    if (options?.rawBody) {
      body = new Uint8Array(options.rawBody);
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
    } else if (options?.body) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, { method, headers, body: body as BodyInit | undefined });

    if (!response.ok) {
      interface ErrorResponse { error?: { code?: number; message?: string; status?: string } }
      let errorInfo: ErrorResponse | null = null;
      try {
        errorInfo = await response.json() as ErrorResponse;
      } catch { /* response wasn't JSON */ }

      if (errorInfo?.error) {
        throw new GooglePlayError(
          errorInfo.error.code ?? response.status,
          errorInfo.error.status ?? 'UNKNOWN',
          errorInfo.error.message ?? 'No error message'
        );
      }
      throw new GooglePlayError(
        response.status,
        'UNKNOWN',
        await response.text().catch(() => 'No response body')
      );
    }

    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  async uploadRequest<T>(url: string, fileBuffer: Buffer, contentType: string, token: string): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(fileBuffer) as unknown as BodyInit,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GooglePlayError(response.status, 'UPLOAD_FAILED', text);
    }

    return response.json() as Promise<T>;
  }

  async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error('Failed to get access token');
    return token.token;
  }
}
