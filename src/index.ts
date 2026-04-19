import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { put, list, copy } from "@vercel/blob";
import { Buffer } from "node:buffer";

// ─────────────────────────────────────────────
// BLOB OPERATIONS — fetch & upload
// ─────────────────────────────────────────────

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download from URL: ${res.statusText}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer); 
}

// ─────────────────────────────────────────────
// MCP SERVER — Zero-Fallback Blob Tools
// ─────────────────────────────────────────────

function createBlobServer(): McpServer {
  const server = new McpServer({
    name: "mcp-server",
    version: "1.0.0",
  });

  // 1. Upload (Put) - Hardcoded public, no validation
  server.tool(
    "vercel_blob_put",
    "Upload a file to Vercel Blob.",
    {
      source_url: z.any().describe("Source URL."),
      pathname: z.any().describe("Vercel pathname."),
    },
    async (params) => {
      try {
        let cleanUrl = Array.isArray(params.source_url) 
          ? String(params.source_url[0]) 
          : String(params.source_url);
        cleanUrl = cleanUrl.replace(/^["']|["']$/g, ''); 

        let cleanPath = String(params.pathname).replace(/^["']|["']$/g, '');

        const fileBytes = await downloadBytes(cleanUrl);
        const result = await put(cleanPath, fileBytes, {
          access: "public", 
        });
        
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  // 2. List Blobs - RIPPED OUT DEFAULT LIMIT
  server.tool(
    "vercel_blob_list",
    "List files in Vercel Blob.",
    {
      limit: z.any().optional().describe("Optional limit."),
    },
    async (params) => {
      try {
        const result = await list(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  // 3. Copy Blob
  server.tool(
    "vercel_blob_copy",
    "Copy an existing blob.",
    {
      from_url: z.any().describe("Source URL."),
      to_pathname: z.any().describe("Destination pathname."),
    },
    async (params) => {
      try {
        let cleanUrl = Array.isArray(params.from_url) 
          ? String(params.from_url[0]) 
          : String(params.from_url);
        cleanUrl = cleanUrl.replace(/^["']|["']$/g, ''); 

        let cleanPath = String(params.to_pathname).replace(/^["']|["']$/g, '');

        const result = await copy(cleanUrl, cleanPath, {
          access: "public",
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.listen(process.env.PORT);