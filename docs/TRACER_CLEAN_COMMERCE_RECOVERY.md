# TRACER clean-commerce recovery

Bounded recovery run for the production commerce pipeline.

- Wait for the production deployment to include the triggering commit.
- Run the CJ sandbox order lifecycle test.
- Import up to three Japan-destination supplier offers for women's handbags.
- Attempt bounded BASE and Shopify publication for up to three listings each.
- Poll BASE orders and run the procurement worker.
- Verify database counts after the run; do not claim public saleability from database publication status alone.

The recovery run is intentionally bounded. It must not create a real supplier purchase without a real paid customer order.