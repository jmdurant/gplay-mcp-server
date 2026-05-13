import { GoogleAuth } from 'google-auth-library';
import { GooglePlayError } from './errors.js';
import type { Config } from './config.js';

const BASE_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

export class GooglePlayClient {
  private auth: GoogleAuth;

  constructor(config: Config) {
    // Two scopes: androidpublisher for the standard Publishing API (edits,
    // bundles, listings, etc.) and playdeveloperreporting for the post-launch
    // Reporting API (crash rate, ANR rate, top error issues). The same
    // service account needs the Reporting API enabled in Google Cloud
    // Console for the second scope to actually work.
    this.auth = new GoogleAuth({
      keyFilename: config.serviceAccountKeyPath,
      scopes: [
        'https://www.googleapis.com/auth/androidpublisher',
        'https://www.googleapis.com/auth/playdeveloperreporting',
      ],
    });
  }

  async request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    rawBody?: Buffer;
    contentType?: string;
    /// Override the host when calling a non-Publishing API like the Play
    /// Developer Reporting API. Defaults to the Publishing API base.
    baseUrl?: string;
  }): Promise<T> {
    const client = await this.auth.getClient();
    const method = options?.method ?? 'GET';

    let url = `${options?.baseUrl ?? BASE_URL}${path}`;
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

  /// Buffer-based upload. Fine for small uploads (icons, short text bodies).
  /// For files >5MB (AABs, mapping.txt, screenshots) prefer uploadFileRequest
  /// which streams from disk + has an explicit timeout so 300MB+ uploads
  /// don't hit undici's default body timeout mid-upload.
  async uploadRequest<T>(
    url: string,
    fileBuffer: Buffer,
    contentType: string,
    token: string,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000; // 15 min default
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(fileBuffer) as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GooglePlayError(response.status, 'UPLOAD_FAILED', text);
    }

    return response.json() as Promise<T>;
  }

  /// Stream a file directly from disk to the upload URL. Avoids loading the
  /// whole file into memory (a 300MB AAB as Uint8Array is uncomfortable) and
  /// sets a generous abort timeout so slow connections don't hit fetch's
  /// default body timeout mid-upload. Used by upload_bundle, upload_mapping,
  /// and apply_default_settings's image paths.
  async uploadFileRequest<T>(
    url: string,
    filePath: string,
    contentType: string,
    token: string,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const { createReadStream, statSync } = await import('node:fs');
    const { Readable } = await import('node:stream');

    const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000; // 15 min default
    const size = statSync(filePath).size;

    // Web ReadableStream from a Node fs read stream; fetch + duplex='half'
    // streams it to the network without buffering the whole file in memory.
    const fileStream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(size),
      },
      body: fileStream,
      // duplex is required on Node fetch when body is a stream; not in the
      // standard RequestInit type yet, hence the cast.
      duplex: 'half',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { duplex: 'half' });

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
