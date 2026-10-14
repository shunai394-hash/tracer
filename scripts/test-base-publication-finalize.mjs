import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const finalization = publisher.match(/const \{ error: finalizeError \} = await supabase\.from\("shop_listings"\)\.update\(\{ base_item_id: baseItemId, base_published_at: new Date\(\)\.toISOString\(\), base_publication_status: "published"[\s\S]*?\.eq\("id", listingId\);/);
assert.ok(finalization, "BASE final status update must capture its database error");
assert.match(finalization[0], /pipeline_status: "published"/);
assert.match(publisher, /identifier: `TRC-\$\{listingId\}`/, "new BASE items must carry a stable internal listing identifier");
assert.match(publisher, /if \(finalizeError\) throw new Error\(\`base_publication_finalize_failed: \$\{finalizeError\.message\}\`\);/);
const successPush = publisher.indexOf('results.push({ listingId, ok: true, baseItemId });');
assert.ok(successPush > publisher.indexOf("if (finalizeError)"), "success must be recorded only after final DB update succeeds");
assert.match(publisher, /addBaseItemImageWithFallback/, "BASE image format failures must have a compatible image fallback");
assert.match(publisher, /product\(id: \$id\) \{ featuredImage \{ url \} \}/, "the fallback must use Shopify's accepted CDN image");
assert.match(publisher, /このファイル形式はご利用できません/, "the fallback should be limited to BASE format-rejection errors");
console.log("BASE publication finalization and image fallback contract: 7 assertions passed");
