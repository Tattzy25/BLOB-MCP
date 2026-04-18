/**
 * MCP tool registrations for Vercel Blob.
 *
 * Four tools: vercel_blob_put, vercel_blob_get, vercel_blob_list, vercel_blob_copy.
 *
 * Contract:
 *   - No silent defaults. Tool inputs map 1:1 to blob-client params.
 *   - `access` is required on put and copy (matches Vercel's public/private store model).
 *   - On `get`, `encoding` is required ("utf-8" or "base64") — no auto-detection.
 *   - No response truncation. If a download exceeds MAX_INLINE_DOWNLOAD_BYTES,
 *     the call fails with a clear error pointing at `downloadUrl`.
 *   - Responses are JSON (tool text content) + the same object as structuredContent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BlobClient } from "./blob-client.js";

/**
 * Hard ceiling on inline download size exposed via vercel_blob_get.
 * Base64-encoding inflates by ~33%, so 1 MB of bytes becomes ~1.33 MB of JSON text.
 * Blobs larger than this must be fetched by the client directly via downloadUrl.
 */
const MAX_INLINE_DOWNLOAD_BYTES = 1 * 1024 * 1024;

// ---------- Zod schemas ----------

const AccessSchema = z
  .enum(["public", "private"])
  .describe(
    "Access mode of the target blob store. Must match the store's actual type (stores are either public or private; immutable after creation)."
  );

const PutInputBase = z
  .object({
    pathname: z
      .string()
      .min(1, "pathname is required and cannot be empty")
      .describe(
        "Destination pathname inside the blob store, e.g. 'images/logo.png'. Determines the final URL."
      ),
    access: AccessSchema,
    text: z
      .string()
      .optional()
      .describe(
        "Raw text content to upload. Exactly one of `text`, `content_base64`, or `source_url` must be provided."
      ),
    content_base64: z
      .string()
      .optional()
      .describe(
        "Base64-encoded bytes to upload (no data-URL prefix). Exactly one of `text`, `content_base64`, or `source_url` must be provided."
      ),
    source_url: z
      .string()
      .url("source_url must be a valid URL")
      .optional()
      .describe(
        "Public URL to fetch and upload. The server downloads the bytes then uploads them. Exactly one of `text`, `content_base64`, or `source_url` must be provided."
      ),
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "MIME type for the blob (e.g., 'image/png'). Pass-through to Vercel — when omitted, Vercel applies its own default."
      ),
    add_random_suffix: z
      .boolean()
      .optional()
      .describe(
        "If true, Vercel appends a random suffix to the pathname. Pass-through to Vercel; omit to use Vercel's default."
      ),
    allow_overwrite: z
      .boolean()
      .optional()
      .describe(
        "If true, allow overwriting an existing blob at the same pathname. Pass-through; omit to use Vercel's default (rejects overwrite)."
      ),
    cache_control_max_age: z
      .number()
      .int()
      .optional()
      .describe(
        "Cache-Control max-age in seconds. Pass-through to Vercel; omit to use Vercel's default."
      ),
  })
  .strict();

const PutInputSchema = PutInputBase.refine(
  (v) =>
    [v.text, v.content_base64, v.source_url].filter((x) => x !== undefined).length === 1,
  {
    message:
      "Provide exactly one of `text`, `content_base64`, or `source_url` — not zero, not multiple.",
  }
);

const GetInputSchema = z
  .object({
    url: z
      .string()
      .url("url must be a valid URL")
      .describe("Full URL of the blob (the `url` field returned by put/list)."),
    encoding: z
      .enum(["utf-8", "base64"])
      .describe(
        "How to return the downloaded bytes. 'utf-8' for text-like content, 'base64' for binary. The tool returns exactly what is requested; no auto-detection."
      ),
  })
  .strict();

const ListInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .optional()
      .describe(
        "Maximum number of blobs to return. Pass-through to Vercel (Vercel caps per-request internally)."
      ),
    prefix: z
      .string()
      .optional()
      .describe(
        "Filter to blobs whose pathname starts with this prefix (e.g., 'images/')."
      ),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor returned in a previous list response."),
    mode: z
      .enum(["expanded", "folded"])
      .optional()
      .describe(
        "'folded' collapses subfolders into single entries; 'expanded' returns all blobs flat. Pass-through; omit to use Vercel's default."
      ),
  })
  .strict();

const CopyInputSchema = z
  .object({
    from_url: z
      .string()
      .url("from_url must be a valid URL")
      .describe("Full URL of the source blob."),
    to_pathname: z
      .string()
      .min(1, "to_pathname is required and cannot be empty")
      .describe("Destination pathname inside the same blob store."),
    access: AccessSchema,
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe("MIME type for the destination. Pass-through; omit to use Vercel's default."),
    add_random_suffix: z
      .boolean()
      .optional()
      .describe("Append a random suffix to the destination. Pass-through; omit for default."),
    cache_control_max_age: z
      .number()
      .int()
      .optional()
      .describe("Cache-Control max-age in seconds for the destination. Pass-through."),
  })
  .strict();

// ---------- Helpers ----------

function toolError(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function toolOk<T extends Record<string, unknown>>(
  structured: T
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------- Tool registrations ----------

export function registerBlobTools(server: McpServer, client: BlobClient): void {
  // -------- vercel_blob_put --------
  server.registerTool(
    "vercel_blob_put",
    {
      title: "Upload a blob to Vercel Blob",
      description: `Upload a file to Vercel Blob. DESTRUCTIVE — creates or overwrites a blob.

Required:
  - pathname: destination path, e.g. "images/logo.png"
  - access: "public" or "private" (must match the target store's type)
  - exactly one content source: text | content_base64 | source_url

Optional (pass-through to Vercel Blob; omit for Vercel's own defaults):
  - content_type: MIME type
  - add_random_suffix: append random suffix
  - allow_overwrite: permit overwriting existing pathname
  - cache_control_max_age: seconds

Returns (both text content and structuredContent):
  {
    "url": string,
    "downloadUrl": string,
    "pathname": string,
    "contentType": string,
    "contentDisposition": string
  }`,
      inputSchema: PutInputBase.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (raw: unknown) => {
      const parsed = PutInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(`Invalid arguments: ${parsed.error.message}`);
      }
      const params = parsed.data;

      let bodyBytes: Uint8Array;
      if (params.text !== undefined) {
        bodyBytes = new TextEncoder().encode(params.text);
      } else if (params.content_base64 !== undefined) {
        try {
          bodyBytes = new Uint8Array(Buffer.from(params.content_base64, "base64"));
        } catch (err) {
          return toolError(`content_base64 is not valid base64: ${errMessage(err)}`);
        }
      } else if (params.source_url !== undefined) {
        try {
          const fetched = await client.downloadBytes(params.source_url);
          bodyBytes = fetched.bytes;
        } catch (err) {
          return toolError(`Failed to fetch source_url: ${errMessage(err)}`);
        }
      } else {
        // Guaranteed unreachable by refine(), but explicit is better than clever.
        return toolError(
          "Exactly one of text, content_base64, or source_url must be provided."
        );
      }

      try {
        const result = await client.put({
          pathname: params.pathname,
          body: bodyBytes,
          access: params.access,
          contentType: params.content_type,
          addRandomSuffix: params.add_random_suffix,
          allowOverwrite: params.allow_overwrite,
          cacheControlMaxAge: params.cache_control_max_age,
        });
        return toolOk(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toolError(errMessage(err));
      }
    }
  );

  // -------- vercel_blob_get --------
  server.registerTool(
    "vercel_blob_get",
    {
      title: "Download a blob from Vercel Blob",
      description: `Download the bytes of a blob and return them inline in the requested encoding.

Required:
  - url: full blob URL (from put or list)
  - encoding: "utf-8" or "base64" — how the returned bytes are represented

Hard limit: blobs larger than ${MAX_INLINE_DOWNLOAD_BYTES} bytes are rejected with an error. For larger blobs, fetch \`downloadUrl\` directly from your application.

Returns (both text content and structuredContent):
  {
    "url": string,
    "size": number,
    "contentType": string,             // as reported by the server ("" if absent)
    "encoding": "utf-8" | "base64",
    "data": string                     // the blob bytes in the chosen encoding
  }`,
      inputSchema: GetInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (raw: unknown) => {
      const parsed = GetInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(`Invalid arguments: ${parsed.error.message}`);
      }
      const params = parsed.data;

      let downloaded: { bytes: Uint8Array; contentType: string; size: number };
      try {
        downloaded = await client.downloadBytes(params.url);
      } catch (err) {
        return toolError(errMessage(err));
      }

      if (downloaded.size > MAX_INLINE_DOWNLOAD_BYTES) {
        return toolError(
          `Blob size ${downloaded.size} bytes exceeds inline limit of ${MAX_INLINE_DOWNLOAD_BYTES} bytes. ` +
            `Use the blob's downloadUrl directly from your application instead of this tool.`
        );
      }

      let data: string;
      if (params.encoding === "utf-8") {
        // fatal: true — if the bytes aren't valid UTF-8, fail loudly.
        try {
          data = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.bytes);
        } catch {
          return toolError(
            `Blob bytes are not valid UTF-8. Re-call with encoding="base64" to retrieve binary content.`
          );
        }
      } else {
        data = Buffer.from(downloaded.bytes).toString("base64");
      }

      return toolOk({
        url: params.url,
        size: downloaded.size,
        contentType: downloaded.contentType,
        encoding: params.encoding,
        data,
      });
    }
  );

  // -------- vercel_blob_list --------
  server.registerTool(
    "vercel_blob_list",
    {
      title: "List blobs in Vercel Blob",
      description: `List blobs in the store. READ-ONLY.

All parameters are optional pass-throughs to Vercel Blob. Omit any to use Vercel's own behavior.
  - limit: max blobs per page
  - prefix: filter by pathname prefix (e.g. "images/")
  - cursor: pagination cursor from a prior response
  - mode: "expanded" or "folded"

Returns (both text content and structuredContent):
  {
    "blobs": [{ "url": string, "downloadUrl": string, "pathname": string, "size": number, "uploadedAt": string }],
    "cursor": string | undefined,
    "hasMore": boolean,
    "folders": string[] | undefined
  }`,
      inputSchema: ListInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (raw: unknown) => {
      const parsed = ListInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(`Invalid arguments: ${parsed.error.message}`);
      }
      try {
        const result = await client.list(parsed.data);
        return toolOk(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toolError(errMessage(err));
      }
    }
  );

  // -------- vercel_blob_copy --------
  server.registerTool(
    "vercel_blob_copy",
    {
      title: "Copy a blob within Vercel Blob",
      description: `Copy an existing blob to a new pathname inside the same store. DESTRUCTIVE — creates/overwrites at the destination.

Required:
  - from_url: full URL of the source blob
  - to_pathname: destination pathname
  - access: "public" or "private" (must match the target store)

Optional (pass-through; omit for Vercel defaults):
  - content_type
  - add_random_suffix
  - cache_control_max_age

Returns (both text content and structuredContent):
  {
    "url": string,
    "downloadUrl": string,
    "pathname": string,
    "contentType": string,
    "contentDisposition": string
  }`,
      inputSchema: CopyInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (raw: unknown) => {
      const parsed = CopyInputSchema.safeParse(raw);
      if (!parsed.success) {
        return toolError(`Invalid arguments: ${parsed.error.message}`);
      }
      const params = parsed.data;
      try {
        const result = await client.copy({
          fromUrl: params.from_url,
          toPathname: params.to_pathname,
          access: params.access,
          contentType: params.content_type,
          addRandomSuffix: params.add_random_suffix,
          cacheControlMaxAge: params.cache_control_max_age,
        });
        return toolOk(result as unknown as Record<string, unknown>);
      } catch (err) {
        return toolError(errMessage(err));
      }
    }
  );
}
