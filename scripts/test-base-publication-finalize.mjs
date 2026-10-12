import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const finalization = publisher.match(/const \{ error: finalizeError \} = await supabase\.from\("shop_listings"\)\.update\(\{ base_item_id: baseItemId, base_published_at: new Date\(\)\.toISOString\(\), base_publication_status: "published"[\s\S]*?\.eq\("id", listingId\);/);
assert.ok(finalization, "BASE final status update must capture its database error");
assert.match(finalization[0], /pipeline_status: "published"/);
assert.match(publisher, /if \(finalizeError\) throw new Error\(\`base_publication_finalize_failed: \$\{finalizeError\.message\}\`\);/);
const successPush = publisher.indexOf('results.push({ listingId, ok: true, baseItemId });');
assert.ok(successPush > publisher.indexOf("if (finalizeError)"), "success must be recorded only after final DB update succeeds");
console.log("BASE publication finalization failure contract: 4 assertions passed");
