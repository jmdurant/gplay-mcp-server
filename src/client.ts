import { GoogleAuth } from 'google-auth-library';
import { GooglePlayError } from './errors.js';
import type { Config } from './config.js';

const BASE_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/// Surface the real reason a Node fetch failed. undici buries it in
/// e.cause and exposes a useless top-level "fetch failed" TypeError.
function describeCause(e: unknown): string {
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (cause != null) return String(cause);
  if (e instanceof Error) return e.message;
  return String(e);
}

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
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body: new Uint8Array(fileBuffer) as unknown as BodyInit,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: unknown })?.cause;
      const causeMsg = cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : cause != null
        ? String(cause)
        : (e instanceof Error ? e.message : String(e));
      throw new GooglePlayError(
        0,
        'UPLOAD_FAILED',
        `fetch failed during buffer upload (size=${fileBuffer.length}, url=${url}): ${causeMsg}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GooglePlayError(response.status, 'UPLOAD_FAILED', text);
    }

    return response.json() as Promise<T>;
  }

  /// Chunked resumable upload to Google's upload endpoint for large files.
  ///
  /// Two-phase, with per-chunk recovery:
  ///   1. POST ...?uploadType=resumable to initiate a session → server
  ///      returns the session URL in the Location header.
  ///   2. Loop: PUT chunks of `chunkSize` bytes (default 16MB) to the
  ///      session URL with `Content-Range: bytes start-end/total`.
  ///      - 200/201 → final chunk, parse JSON body.
  ///      - 308 + `Range: bytes=0-N` → continue from N+1.
  ///      - 4xx/5xx or network error → query resume position, retry chunk
  ///        up to `maxRetriesPerChunk` times.
  ///
  /// This survives the mid-upload TCP close (`SocketError: other side
  /// closed`) we kept hitting on 300MB AABs — each chunk is small enough
  /// (~16MB) to complete in a few seconds, and a failed chunk only
  /// retransmits 16MB, not the whole 300MB.
  ///
  /// Callers pass the same `uploadType=media` URL the small-file path uses;
  /// this function swaps it to `uploadType=resumable` internally so the
  /// call sites don't need to change.
  async uploadFileRequest<T>(
    url: string,
    filePath: string,
    contentType: string,
    token: string,
    options?: {
      timeoutMs?: number;
      chunkSize?: number;
      maxRetriesPerChunk?: number;
    }
  ): Promise<T> {
    const { statSync, openSync, readSync, closeSync } = await import('node:fs');

    const totalSize = statSync(filePath).size;
    const chunkSize = options?.chunkSize ?? 16 * 1024 * 1024; // 16 MB default
    const maxRetries = options?.maxRetriesPerChunk ?? 3;
    // 10 min per chunk. Intermediate chunks finish in seconds; the final
    // chunk can take longer because Google validates the bundle (signature,
    // manifest, version checks) before responding with 200. We've seen
    // "other side closed" specifically on the final chunk when the timeout
    // was 3 min — giving validation more time fixes that.
    const perChunkTimeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;

    // Swap uploadType=media -> uploadType=resumable. Falls back gracefully
    // if the URL already has resumable or some other type.
    const sessionInitUrl = url.includes('uploadType=media')
      ? url.replace('uploadType=media', 'uploadType=resumable')
      : (url.includes('uploadType=') ? url : `${url}${url.includes('?') ? '&' : '?'}uploadType=resumable`);

    // --- Step 1: initiate resumable session ----------------------------
    let initResp: Response;
    try {
      initResp = await fetch(sessionInitUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(totalSize),
          'Content-Length': '0',
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new GooglePlayError(
        0,
        'UPLOAD_FAILED',
        `Resumable session init failed: ${describeCause(e)}`
      );
    }

    if (!initResp.ok) {
      const text = await initResp.text().catch(() => '');
      throw new GooglePlayError(
        initResp.status,
        'UPLOAD_FAILED',
        `Resumable session init returned ${initResp.status}: ${text}`
      );
    }

    const sessionUploadUrl = initResp.headers.get('Location');
    if (!sessionUploadUrl) {
      throw new GooglePlayError(
        0,
        'UPLOAD_FAILED',
        'Resumable session init did not return a Location header'
      );
    }

    // --- Step 2: chunked PUT loop ---------------------------------------
    const fd = openSync(filePath, 'r');
    try {
      let uploaded = 0;
      let finalResult: T | null = null;

      while (uploaded < totalSize) {
        const remaining = totalSize - uploaded;
        const thisChunkSize = Math.min(chunkSize, remaining);
        const start = uploaded;
        const end = uploaded + thisChunkSize - 1;

        // Read this chunk from disk into a buffer (16MB is comfortable).
        const buf = Buffer.alloc(thisChunkSize);
        readSync(fd, buf, 0, thisChunkSize, start);

        let chunkOk = false;
        let lastError = '';

        for (let attempt = 0; attempt < maxRetries && !chunkOk; attempt++) {
          try {
            const resp = await fetch(sessionUploadUrl, {
              method: 'PUT',
              headers: {
                'Content-Length': String(thisChunkSize),
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              },
              body: new Uint8Array(buf) as unknown as BodyInit,
              signal: AbortSignal.timeout(perChunkTimeoutMs),
            });

            if (resp.status === 200 || resp.status === 201) {
              // Final chunk; this carries the JSON result body.
              finalResult = (await resp.json()) as T;
              uploaded = totalSize;
              chunkOk = true;
            } else if (resp.status === 308) {
              // "Resume Incomplete" — server confirms what it has so far.
              const range = resp.headers.get('Range');
              if (range) {
                const m = /bytes=0-(\d+)/.exec(range);
                uploaded = m ? parseInt(m[1], 10) + 1 : end + 1;
              } else {
                uploaded = end + 1;
              }
              chunkOk = true;
            } else {
              const text = await resp.text().catch(() => '');
              lastError = `HTTP ${resp.status}: ${text}`;
              // Sync uploaded position from server in case server got more
              // than client thinks, then let the loop retry from there.
              try {
                uploaded = await this.queryResumePosition(
                  sessionUploadUrl,
                  totalSize,
                );
                if (uploaded > end) chunkOk = true; // server got it after all
              } catch { /* fall through to retry */ }
            }
          } catch (e) {
            lastError = describeCause(e);
            // Network blip — re-sync server position then retry.
            try {
              const serverHas = await this.queryResumePosition(
                sessionUploadUrl,
                totalSize,
              );
              if (serverHas > uploaded) {
                uploaded = serverHas;
                if (uploaded > end) chunkOk = true;
              }
            } catch { /* fall through to retry */ }
          }
        }

        if (!chunkOk) {
          throw new GooglePlayError(
            0,
            'UPLOAD_FAILED',
            `Chunk ${start}-${end}/${totalSize} failed after ${maxRetries} retries: ${lastError}`
          );
        }
      }

      if (finalResult === null) {
        // All bytes uploaded but we never saw 200/201 — query final state.
        throw new GooglePlayError(
          0,
          'UPLOAD_FAILED',
          'Upload reached totalSize but no final 200/201 response was observed'
        );
      }

      return finalResult;
    } finally {
      closeSync(fd);
    }
  }

  /// Query a resumable session for how many bytes the server actually has.
  /// Used between chunk retries so we don't blindly re-send what already
  /// landed. Returns the next byte offset to send (== totalSize means done).
  private async queryResumePosition(
    sessionUrl: string,
    totalSize: number,
  ): Promise<number> {
    const resp = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        'Content-Range': `bytes */${totalSize}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status === 200 || resp.status === 201) return totalSize;
    if (resp.status === 308) {
      const range = resp.headers.get('Range');
      if (range) {
        const m = /bytes=0-(\d+)/.exec(range);
        if (m) return parseInt(m[1], 10) + 1;
      }
      return 0; // 308 with no Range means nothing uploaded yet
    }
    return 0;
  }

  async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error('Failed to get access token');
    return token.token;
  }
}
