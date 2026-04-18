/**
 * Vercel Blob REST client.
 *
 * Direct HTTP against https://blob.vercel-storage.com. No SDK.
 *
 * Contract: no silent defaults. Every option is only sent when the caller
 * explicitly provided a value. When the caller omits an option, no header is
 * sent and Vercel Blob applies its own server-side behavior.
 *
 * Wire protocol (API v10):
 *   list:  GET  /                      ?limit&prefix&cursor&mode
 *   put:   PUT  /?pathname={path}      headers: access (required), optional
 *                                      x-content-type, x-cache-control-max-age,
 *                                      x-add-random-suffix, x-allow-overwrite
 *   copy:  PUT  /?pathname={to}&fromUrl={from}
 *   head:  GET  /?url={blob_url}       (metadata)
 *   get:   GET  {blob_url}             (direct fetch of the object bytes)
 *
 * Auth: Authorization: Bearer ${BLOB_READ_WRITE_TOKEN} + x-api-version: 10.
 */

export const BLOB_API_BASE_URL = "https://blob.vercel-storage.com";
export const BLOB_API_VERSION = "10";
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- Response types ----------

export interface BlobListItem {
  url: string;
  downloadUrl: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

export interface BlobListResponse {
  blobs: BlobListItem[];
  cursor?: string;
  hasMore: boolean;
  folders?: string[];
}

export interface BlobPutResponse {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
}

export interface BlobHeadResponse {
  url: string;
  downloadUrl: string;
  pathname: string;
  size: number;
  uploadedAt: string;
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
}

// ---------- Errors ----------

export class BlobApiError extends Error {
  public readonly status: number;
  public readonly body: string;
  constructor(status: number, body: string) {
    super(`Vercel Blob API ${status}: ${body.slice(0, 500)}`);
    this.name = "BlobApiError";
    this.status = status;
    this.body = body;
  }
}

// ---------- Client ----------

export type BlobAccess = "public" | "private";

export interface PutParams {
  pathname: string;
  body: Uint8Array;
  access: BlobAccess;
  contentType?: string;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  cacheControlMaxAge?: number;
}

export interface CopyParams {
  fromUrl: string;
  toPathname: string;
  access: BlobAccess;
  contentType?: string;
  addRandomSuffix?: boolean;
  cacheControlMaxAge?: number;
}

export interface ListParams {
  limit?: number;
  prefix?: string;
  cursor?: string;
  mode?: "expanded" | "folded";
}

export class BlobClient {
  private readonly token: string;

  constructor(token: string) {
    if (!token) {
      throw new Error("BlobClient: token is required");
    }
    this.token = token;
  }

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "x-api-version": BLOB_API_VERSION,
      ...extra,
    };
  }

  async list(params: ListParams): Promise<BlobListResponse> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.prefix !== undefined) qs.set("prefix", params.prefix);
    if (params.cursor !== undefined) qs.set("cursor", params.cursor);
    if (params.mode !== undefined) qs.set("mode", params.mode);

    const url = qs.toString()
      ? `${BLOB_API_BASE_URL}/?${qs.toString()}`
      : `${BLOB_API_BASE_URL}/`;

    const res = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    return this.parseJson<BlobListResponse>(res);
  }

  async put(params: PutParams): Promise<BlobPutResponse> {
    const extra: Record<string, string> = { access: params.access };
    if (params.contentType !== undefined) extra["x-content-type"] = params.contentType;
    if (params.cacheControlMaxAge !== undefined) {
      extra["x-cache-control-max-age"] = String(params.cacheControlMaxAge);
    }
    if (params.addRandomSuffix === true) extra["x-add-random-suffix"] = "1";
    if (params.allowOverwrite === true) extra["x-allow-overwrite"] = "1";

    const qs = new URLSearchParams({ pathname: params.pathname });
    const res = await this.fetchWithTimeout(`${BLOB_API_BASE_URL}/?${qs.toString()}`, {
      method: "PUT",
      headers: this.baseHeaders(extra),
      body: params.body,
    });
    return this.parseJson<BlobPutResponse>(res);
  }

  async copy(params: CopyParams): Promise<BlobPutResponse> {
    const extra: Record<string, string> = { access: params.access };
    if (params.contentType !== undefined) extra["x-content-type"] = params.contentType;
    if (params.cacheControlMaxAge !== undefined) {
      extra["x-cache-control-max-age"] = String(params.cacheControlMaxAge);
    }
    if (params.addRandomSuffix === true) extra["x-add-random-suffix"] = "1";

    const qs = new URLSearchParams({
      pathname: params.toPathname,
      fromUrl: params.fromUrl,
    });
    const res = await this.fetchWithTimeout(`${BLOB_API_BASE_URL}/?${qs.toString()}`, {
      method: "PUT",
      headers: this.baseHeaders(extra),
    });
    return this.parseJson<BlobPutResponse>(res);
  }

  async head(blobUrl: string): Promise<BlobHeadResponse> {
    const qs = new URLSearchParams({ url: blobUrl });
    const res = await this.fetchWithTimeout(`${BLOB_API_BASE_URL}/?${qs.toString()}`, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    return this.parseJson<BlobHeadResponse>(res);
  }

  /**
   * Download a blob's raw bytes by its URL.
   * Returns bytes and the content-type header exactly as the server sent it
   * (empty string if the server omitted it).
   */
  async downloadBytes(
    blobUrl: string
  ): Promise<{ bytes: Uint8Array; contentType: string; size: number }> {
    const res = await this.fetchWithTimeout(blobUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new BlobApiError(res.status, body);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, contentType, size: buf.byteLength };
  }

  /**
   * Health probe. Makes a minimal `list` call and reports the result.
   * Returns { ok: true } only when the upstream responded successfully.
   */
  async healthCheck(): Promise<
    { ok: true } | { ok: false; status: number; message: string }
  > {
    try {
      await this.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      if (err instanceof BlobApiError) {
        return { ok: false, status: err.status, message: err.body.slice(0, 500) };
      }
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: 0, message: "timeout contacting blob.vercel-storage.com" };
      }
      return {
        ok: false,
        status: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---------- Internal helpers ----------

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new BlobApiError(res.status, text);
    }
    if (!text) {
      throw new BlobApiError(
        res.status,
        "empty response body from blob.vercel-storage.com (expected JSON)"
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BlobApiError(res.status, `non-JSON response body: ${text.slice(0, 200)}`);
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
