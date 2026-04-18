/**
 * vercel-blob-mcp-server entrypoint.
 *
 * Exposes four Vercel Blob tools over MCP's streamable-HTTP transport.
 *
 * Endpoints:
 *   POST /mcp      — MCP streamable-HTTP transport (stateless, JSON response)
 *   GET  /health   — liveness probe; calls Vercel Blob list({limit:1}) every request
 *   GET  /         — service info
 *
 * Required environment:
 *   BLOB_READ_WRITE_TOKEN   Vercel Blob read/write token.
 *   MCP_SERVER_TOKEN        Bearer token required on every POST /mcp request.
 *   PORT                    TCP port to bind (1-65535).
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { BlobClient } from "./blob-client.js";
import { registerBlobTools } from "./tools.js";

const SERVER_NAME = "vercel-blob-mcp-server";
const SERVER_VERSION = "1.0.0";

/** Max JSON body size for POST /mcp. content_base64 uploads travel through this. */
const BODY_LIMIT = "50mb";

function logJson(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>
): void {
  process.stderr.write(
    JSON.stringify({
      level,
      msg,
      service: SERVER_NAME,
      ts: new Date().toISOString(),
      ...extra,
    }) + "\n"
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    logJson("error", `Required environment variable ${name} is not set. Exiting.`);
    process.exit(1);
  }
  return v;
}

function requirePortEnv(): number {
  const raw = requireEnv("PORT");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    logJson("error", `PORT must be an integer between 1 and 65535. Got: ${raw}. Exiting.`);
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const blobToken = requireEnv("BLOB_READ_WRITE_TOKEN");
  const mcpServerToken = requireEnv("MCP_SERVER_TOKEN");
  const port = requirePortEnv();

  const client = new BlobClient(blobToken);

  function buildServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerBlobTools(server, client);
    return server;
  }

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));

  // Bearer middleware — always enforced. No "if unset, skip" branch.
  function requireBearer(req: Request, res: Response, next: NextFunction): void {
    const auth = req.header("authorization") ?? "";
    const expected = `Bearer ${mcpServerToken}`;
    if (auth !== expected) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="mcp"')
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: missing or invalid Bearer token" },
          id: null,
        });
      return;
    }
    next();
  }

  // Health: actually pings upstream. 200 only when upstream responded; 503 otherwise.
  app.get("/health", async (_req: Request, res: Response) => {
    const result = await client.healthCheck();
    if (result.ok) {
      res.status(200).json({
        status: "ok",
        service: SERVER_NAME,
        version: SERVER_VERSION,
        upstream: "vercel-blob",
      });
    } else {
      res.status(503).json({
        status: "unhealthy",
        service: SERVER_NAME,
        version: SERVER_VERSION,
        upstream: "vercel-blob",
        upstream_status: result.status,
        error: result.message,
      });
    }
  });

  // Service info.
  app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      mcp_endpoint: "/mcp",
      health_endpoint: "/health",
      tools: [
        "vercel_blob_put",
        "vercel_blob_get",
        "vercel_blob_list",
        "vercel_blob_copy",
      ],
    });
  });

  // MCP endpoint.
  app.post("/mcp", requireBearer, async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logJson("error", "MCP request handling failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Non-POST methods on /mcp.
  app.all("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed — use POST /mcp" },
      id: null,
    });
  });

  app.listen(port, () => {
    logJson("info", `${SERVER_NAME} listening`, {
      port,
      mcp_endpoint: `http://0.0.0.0:${port}/mcp`,
    });
  });
}

main().catch((err) => {
  logJson("error", "Fatal error starting server", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
