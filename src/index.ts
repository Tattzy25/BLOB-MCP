import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { put, list, del } from "@vercel/blob";

// ─────────────────────────────────────────────
// BLOB OPERATIONS — fetch & upload
// ─────────────────────────────────────────────

async function downloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download from URL: ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

// ─────────────────────────────────────────────
// MCP SERVER — Bare Metal Blob Tools
// ─────────────────────────────────────────────

function createBlobServer(): McpServer {
  const server = new McpServer({
    name: "vercel-blob-mcp",
    version: "1.0.0",
  });

  // 1. Upload (Put) - Just pass a URL and a destination name
  server.tool(
    "vercel_blob_put",
    "Upload a file to Vercel Blob and get a public URL back.",
    {
      source_url: z.string().url().describe("The URL of the image/file you want to upload."),
      pathname: z.string().min(1).describe("What to name it in Vercel (e.g., 'image.png')."),
      access: z.enum(["public", "private"]).describe("public or private"),
    },
    async (params) => {
      try {
        const fileBytes = await downloadBytes(params.source_url);
        const result = await put(params.pathname, fileBytes, {
          access: params.access,
          // Vercel auto-detects the MIME type from the pathname extension
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  // 2. List Blobs
  server.tool(
    "vercel_blob_list",
    "List all files currently in Vercel Blob.",
    {
      limit: z.number().int().default(100).describe("Max files to return."),
    },
    async (params) => {
      try {
        const result = await list({ limit: params.limit });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  // 3. Delete Blob
  server.tool(
    "vercel_blob_delete",
    "Delete a file from Vercel Blob using its URL.",
    {
      url: z.string().url().describe("The exact Vercel Blob URL to delete."),
    },
    async (params) => {
      try {
        await del(params.url);
        return { content: [{ type: "text", text: `Successfully deleted: ${params.url}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  return server;
}

// ─────────────────────────────────────────────
// EXPRESS — Streamable HTTP Transport
// ─────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vercel-blob-mcp-server" });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = createBlobServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`MCP Error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

const port = parseInt(process.env.PORT || "3002");
app.listen(port, () => {
  console.log(`Vercel Blob MCP running on :${port}`);
});