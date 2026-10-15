import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const env = await readFile(new URL("../lib/config/env.ts", import.meta.url), "utf8");
const client = await readFile(new URL("../lib/sources/mcp/client.ts", import.meta.url), "utf8");
const remote = await readFile(new URL("../lib/sources/mcp/remote-client.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const collector = await readFile(new URL("../lib/sources/brightdata/client.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/tracer/persist-brightdata.ts", import.meta.url), "utf8");
const ingestRoute = await readFile(new URL("../app/api/intelligence/brightdata-ingest/route.ts", import.meta.url), "utf8");

assert.match(env, /mcpApiKey:\s*readEnv\("BRIGHTDATA_MCP_API_KEY"\)/);
assert.match(client, /https:\/\/mcp\.brightdata\.com\/mcp/);
assert.match(client, /endpoint\.searchParams\.set\("token", mcpApiKey\)/);
assert.match(client, /if \(!mcpUrl && !mcpApiKey\) return null/);
assert.match(client, /return getConfiguredEndpoint\(\) !== null/);
assert.doesNotMatch(client, /console\.(?:log|info|warn|error).*endpoint/i, "the MCP endpoint contains the API token and must never be logged");
assert.match(remote, /new URL\(options\.endpoint\)/);
assert.match(collector, /getMcpToolConsumer, isMcpConfigured/);
assert.match(collector, /consumer\.listTools\(\)/, "product collection must discover the real Bright Data MCP tools");
assert.match(collector, /consumer\.callTool\(call\)/, "product collection must invoke a discovered Bright Data MCP tool");
assert.match(collector, /provider: "brightdata_mcp"/, "ingest results must identify successful MCP-backed collection");
assert.ok(collector.includes('const preferred = ["scrape_as_markdown", "search_engine"];'), "search results must use tools that accept query/search URLs, not a product-detail scraper on a search URL");
assert.ok(collector.includes("const lines = unwrapped.split(/\\r?\\n/);"), "Markdown product cards must be parsed from Bright Data results");
assert.ok(collector.includes("if (!priceMatch) continue;"), "generic navigation links without a price must not become product candidates");
assert.ok(collector.includes("Continue to the next supported MCP tool"), "one unavailable MCP tool must not abort the remaining tool attempts");
assert.match(collector, /export function isBrightDataFetchConfigured\(\): boolean/);
assert.match(collector, /function normalizeCurrency\(/, "Google Shopping currency must be preserved rather than inferred as USD");
assert.match(collector, /currency: string \| null/);
assert.match(collector, /brand: string \| null/);
assert.match(collector, /productRecords = unwrapped\.filter/, "MCP product arrays must be parsed instead of discarded");
assert.match(collector, /replace\(\/\\s\+\/g, " "\)/, "product titles must collapse actual whitespace");
assert.match(persistence, /candidate\.brand/, "only source-provided brand values may be used as brand evidence");
assert.match(persistence, /\\p\{L\}/, "Japanese titles must remain distinct in identity keys");
assert.match(persistence, /const amount = currency \? parsedAmount : null/, "unknown-currency amounts must not enter normalized prices");
assert.doesNotMatch(persistence, /currency:\s*"USD"/, "Japanese Google Shopping prices must never be hardcoded as USD");
assert.match(ingestRoute, /requireAutomationAuth\(request\)/, "Bright Data ingest writes must require automation authentication");
assert.ok(ingestRoute.indexOf("requireAutomationAuth(request)") < ingestRoute.indexOf("searchGoogleProducts(query)"),
  "authorization must be checked before calling the paid MCP provider or persisting products");
assert.match(ingestRoute, /result\.products\.slice\(0, 30\)/, "each ingest call must have a bounded database-write batch");
assert.match(ingestRoute, /persistBrightDataProducts\(result\.query, candidates, result\.provider\)/,
  "the actual transport must be passed into persistence");
assert.match(persistence, /provider_family: PROVIDER/, "the persisted offer must preserve transport provenance separately from provider family");
assert.match(collector, /candidate\.name === "scrape_as_html"/, "marketplace detail pages must use MCP raw HTML for child-variant parsing");
assert.match(collector, /Bright Data MCP raw HTML tool is unavailable/, "do not silently claim collection succeeded when MCP HTML and API fallback are unavailable");
assert.match(client, /mcp\.brightdata\.com\/mcp\?pro=1/, "default hosted endpoint must expose advanced scraping tools");
assert.match(packageJson.scripts.prebuild, /test:brightdata-mcp-auth/);
console.log("Bright Data MCP auth and product-collection contract checks passed");
