# vercel-blob-mcp-server

MCP server for **Vercel Blob**, built on the **raw REST API** — no `@vercel/blob` SDK.

Four tools, three required env vars, no silent fallbacks.

| Tool | What it does | Destructive? |
|---|---|---|
| `vercel_blob_put` | Upload a file from `text`, `content_base64`, or `source_url` | yes |
| `vercel_blob_get` | Download a blob's bytes in the requested encoding | no |
| `vercel_blob_list` | List blobs with optional `prefix`/`cursor`/`mode`/`limit` | no |
| `vercel_blob_copy` | Copy a blob to a new pathname | yes |

## Contract

The server has no silent defaults. Every tool parameter falls into one of three categories:

1. **Required.** Missing → the tool returns a validation error. No "assumed value."
2. **Optional and pass-through.** Omitting it means the header is not sent; Vercel Blob applies its own server-side behavior.
3. **Not sent at all** until the caller explicitly provides it.

The server does not guess content types. It does not auto-detect encodings. It does not truncate responses. It does not hide upstream errors behind a friendly facade.

## Environment (all required)

| Variable | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob RW token |
| `MCP_SERVER_TOKEN` | Bearer token enforced on every `POST /mcp` |
| `PORT` | TCP port to bind (1-65535) |

If any is missing or `PORT` isn't a valid integer in range, the process exits with a clear error at startup.

## Deploy to Railway

1. Push this folder to GitHub.
2. Railway → New Project → Deploy from repo.
3. Variables: set all three from the table above.
4. Railway uses `railway.json` automatically — it builds with the Dockerfile, health-checks `/health`, and restarts on failure up to 3 times.

`/health` calls `list({limit:1})` against Vercel Blob on every request. It only returns `200` when the upstream actually responded. A bad token → `503`, and Railway will mark the deployment unhealthy. Fix the token, redeploy.

## Local

```bash
cp .env.example .env
# fill in the three required vars
npm install
npm run build

set -a; source .env; set +a
npm start
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/mcp` | Bearer required | MCP streamable-HTTP transport |
| `GET` | `/health` | open | Pings upstream. 200 = ok, 503 = upstream failed |
| `GET` | `/` | open | Service info |

## Tool signatures

All tools return `structuredContent` with the shape shown below. The `content` field carries the same object as pretty-printed JSON text.

### `vercel_blob_put`

```
pathname        string, required
access          "public" | "private", required  (must match store type)

exactly one of:
  text            string
  content_base64  string    (no data-URL prefix)
  source_url      string    (URL — server fetches, then uploads)

optional (omit = Vercel default):
  content_type             string
  add_random_suffix        boolean
  allow_overwrite          boolean
  cache_control_max_age    integer seconds
```

Returns:
```json
{
  "url": "https://xxx.public.blob.vercel-storage.com/...",
  "downloadUrl": "...?download=1",
  "pathname": "...",
  "contentType": "...",
  "contentDisposition": "..."
}
```

### `vercel_blob_get`

```
url        string, required   (blob URL from put/list)
encoding   "utf-8" | "base64", required
```

Max inline download: **1 MB of raw bytes**. Larger blobs → error; fetch `downloadUrl` from your own code.

Returns:
```json
{
  "url": "...",
  "size": 1234,
  "contentType": "application/json",
  "encoding": "utf-8",
  "data": "..."
}
```

If `encoding: "utf-8"` is requested and the bytes aren't valid UTF-8, the tool errors. No silent lossy decode.

### `vercel_blob_list`

All parameters optional:
```
limit    integer
prefix   string
cursor   string
mode     "expanded" | "folded"
```

Returns:
```json
{
  "blobs": [
    { "url": "...", "downloadUrl": "...", "pathname": "...", "size": 0, "uploadedAt": "..." }
  ],
  "cursor": "...",
  "hasMore": true,
  "folders": ["..."]
}
```

### `vercel_blob_copy`

```
from_url       string (URL), required
to_pathname    string, required
access         "public" | "private", required

optional:
  content_type             string
  add_random_suffix        boolean
  cache_control_max_age    integer seconds
```

Returns the same shape as `put`.

## MCP client config

```json
{
  "mcpServers": {
    "vercel-blob": {
      "url": "https://your-service.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <your MCP_SERVER_TOKEN>"
      }
    }
  }
}
```

## Smoke test (curl)

```bash
URL=https://your-service.up.railway.app
TOKEN=your-mcp-server-token

curl -s $URL/health | jq .

curl -s -X POST $URL/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .

curl -s -X POST $URL/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"vercel_blob_put",
      "arguments":{
        "pathname":"smoke/hello.txt",
        "access":"public",
        "text":"hello from mcp",
        "content_type":"text/plain",
        "add_random_suffix":true
      }
    }
  }' | jq .
```

## Wire protocol (for audit)

Base URL: `https://blob.vercel-storage.com`
Every request: `Authorization: Bearer ${BLOB_READ_WRITE_TOKEN}` + `x-api-version: 10`.

| Op | Method | Path | Headers sent | Body |
|---|---|---|---|---|
| list | `GET` | `/?limit&prefix&cursor&mode` (only what caller provided) | — | — |
| put | `PUT` | `/?pathname={path}` | `access` (required); optional: `x-content-type`, `x-cache-control-max-age`, `x-add-random-suffix: 1`, `x-allow-overwrite: 1` | raw bytes |
| copy | `PUT` | `/?pathname={to}&fromUrl={from}` | same as put | — |
| head | `GET` | `/?url={blob_url}` | — | — |
| get | `GET` | `{blob_url}` (direct) | — | — |

Optional headers are sent **only** when the caller passed a value. Omit a field → the header is absent → Vercel's own default applies.

## Project layout

```
vercel-blob-mcp-server/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .dockerignore
├── railway.json
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── index.ts         # Express + MCP server + /health + Bearer auth
    ├── blob-client.ts   # Pure REST client for blob.vercel-storage.com
    └── tools.ts         # MCP tool registrations (Zod schemas)
```

## License

MIT.
