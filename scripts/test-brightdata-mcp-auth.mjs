import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const env = await readFile(new URL("../lib/config/env.ts", import.meta.url), "utf8");
const client = await readFile(new URL("../lib/sources/mcp/client.ts", import.meta.url), "utf8");
const remote = await readFile(new URL("../lib/sources/mcp/remote-client.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert.match(env, /mcpApiKey:\s*readEnv\("BRIGHTDATA_MCP_API_KEY"\)/);
assert.match(client, /https:\/\/mcp\.brightdata\.com\/mcp/);
assert.match(client, /endpoint\.searchParams\.set\("token", mcpApiKey\)/);
assert.match(client, /if \(!mcpUrl && !mcpApiKey\) return null/);
assert.match(client, /return getConfiguredEndpoint\(\) !== null/);
assert.doesNotMatch(client, /console\.(?:log|info|warn|error).*endpoint/i, "the MCP endpoint contains the API token and must never be logged");
assert.match(remote, /new URL\(options\.endpoint\)/);
assert.match(packageJson.scripts.prebuild, /test:brightdata-mcp-auth/);
console.log("Bright Data MCP auth contract checks passed");
