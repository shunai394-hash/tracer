import { verifyCurrencyConfidenceInvariants } from "../lib/intelligence/currency-confidence";
import { verifyIdentityInvariants } from "../lib/intelligence/identity-confidence";
import { verifyProfitInvariants } from "../lib/intelligence/simulate-profit";
import { verifySellabilityInvariants } from "../lib/intelligence/sellability";

const results = {
  currency: verifyCurrencyConfidenceInvariants(),
  identity: verifyIdentityInvariants(),
  profit: verifyProfitInvariants(),
  sellability: verifySellabilityInvariants(),
};

console.log(JSON.stringify(results, null, 2));

if (!Object.values(results).every((result) => result.ok)) {
  process.exit(1);
}
