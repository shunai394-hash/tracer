import { verifyCurrencyConfidenceInvariants } from "../lib/intelligence/currency-confidence";
import { verifyIdentityInvariants } from "../lib/intelligence/identity-confidence";
import { verifyProfitInvariants } from "../lib/intelligence/simulate-profit";
import { verifySellabilityInvariants } from "../lib/intelligence/sellability";
import { verifyMarketGapInvariants } from "../lib/intelligence/market-gap";
import { verifyForecastInvariants } from "../lib/intelligence/sales-forecast";
import { verifySearchFitInvariants } from "../lib/intelligence/search-discovery-fit";
import { verifySelectionInvariants } from "../lib/intelligence/selection-score";
import { verifyRecommendationInvariants } from "../lib/intelligence/recommend-products";
import { verifyForecastLearningInvariants } from "../lib/intelligence/forecast-learning";
import { verifyCJSelectionInvariants } from "../lib/intelligence/cj-selection";
import { verifyDemandAnalysisInvariants } from "../lib/intelligence/analyze-demand";
import { verifyDemandLearningInvariants } from "../lib/intelligence/demand-learning";
import { verifyRankingVelocityInvariants } from "../lib/intelligence/ranking-velocity";
import { verifySellerCompetitionInvariants } from "../lib/intelligence/seller-competition";
import { verifyStockoutGapInvariants } from "../lib/intelligence/stockout-gap";
import { verifyAccountFitInvariants } from "../lib/intelligence/account-fit";
import { verifyAbsoluteFilterInvariants } from "../lib/intelligence/absolute-filter";
import { verifyRelatedProductInvariants } from "../lib/intelligence/related-products";
import { verifyImageMatchInvariants } from "../lib/intelligence/image-matching";
import { verifyPortfolioInvariants } from "../lib/intelligence/portfolio";
import { verifyAnomalyInvariants } from "../lib/intelligence/anomaly";
import { verifyInventoryForecastInvariants } from "../lib/ordering/inventory-forecast";
import { verifyReorderPointInvariants } from "../lib/ordering/reorder-point";
import { verifyOrderGateInvariants } from "../lib/ordering/gates";
import { verifyRecommendInvariants } from "../lib/ordering/recommend";
import { verifyIdentifierMatchInvariants } from "../lib/market/identifiers";
import { verifyBestsellerParseInvariants } from "../lib/market/parse-rankings";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate";
import { verifyHtmlEntityDecodingInvariants } from "../lib/market/html-entities";
import { verifyCharsetDecodingInvariants } from "../lib/market/charset";

const results = {
  currency: verifyCurrencyConfidenceInvariants(),
  identity: verifyIdentityInvariants(),
  profit: verifyProfitInvariants(),
  sellability: verifySellabilityInvariants(),
  marketGap: verifyMarketGapInvariants(),
  forecast: verifyForecastInvariants(),
  searchFit: verifySearchFitInvariants(),
  selection: verifySelectionInvariants(),
  recommendation: verifyRecommendationInvariants(),
  forecastLearning: verifyForecastLearningInvariants(),
  cjSelection: verifyCJSelectionInvariants(),
  demandAnalysis: verifyDemandAnalysisInvariants(),
  demandLearning: verifyDemandLearningInvariants(),
  ranking: verifyRankingVelocityInvariants(),
  seller: verifySellerCompetitionInvariants(),
  stockout: verifyStockoutGapInvariants(),
  accountFit: verifyAccountFitInvariants(),
  absoluteFilter: verifyAbsoluteFilterInvariants(),
  related: verifyRelatedProductInvariants(),
  imageMatch: verifyImageMatchInvariants(),
  portfolio: verifyPortfolioInvariants(),
  anomaly: verifyAnomalyInvariants(),
  inventoryForecast: verifyInventoryForecastInvariants(),
  reorderPoint: verifyReorderPointInvariants(),
  orderGates: verifyOrderGateInvariants(),
  recommendOrder: verifyRecommendInvariants(),
  identifiers: verifyIdentifierMatchInvariants(),
  bestsellerParse: verifyBestsellerParseInvariants(),
  salesTestGate: verifySalesTestGateInvariants(),
  htmlEntities: verifyHtmlEntityDecodingInvariants(),
  charsetDecoding: verifyCharsetDecodingInvariants(),
};

console.log(JSON.stringify(results, null, 2));

if (!Object.values(results).every((result) => result.ok)) {
  process.exit(1);
}
