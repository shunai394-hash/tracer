# Dropship order-gate hardening finding

Audit date: 2026-10-11
Scope: read-only inspection of lib/ordering/dropship-gate.ts and its caller lib/ordering/supplier-execution.ts.
No supplier requests or database writes were made for this audit.

## Confirmed code-level gaps

The current evaluateDropshipOrderGate implementation calculates estimatedProfit, but its canExecuteLive result is based only on missing fields, blocked fields and the live-ordering flag. It does not add a blocked reason when estimatedProfit is zero, negative, NaN or otherwise non-finite.

Numeric validation also has gaps:
- quantity checks null and <= 0 but not Number.isFinite, so NaN can pass the initial check.
- sourceCost and shippingCost check null but do not reject negative or non-finite values.
- sellingPrice checks null but does not reject non-positive or non-finite values.
- inventoryQty checks null and compares against quantity, but a non-finite value such as NaN can pass the comparison.
- the supplier execution caller recomputes the execution decision from the gate missing/blocked arrays, so the arrays must themselves encode all invalid-economics cases; returning estimatedProfit alone is insufficient.

These gaps are code findings, not proof that any live supplier order was placed. Current production purchase_orders and supplier_order_attempts were both observed at zero rows.

## Required fail-closed behavior

Before this gate may authorize a live supplier order:
- quantity must be finite and greater than zero;
- source cost and shipping cost must be finite and non-negative;
- selling price must be finite and greater than zero;
- FX rate must be finite and greater than zero;
- inventory must be finite and sufficient for the requested quantity;
- estimated profit must be finite and strictly positive;
- all existing identity, address, duplicate-order, supplier configuration, kill-switch and live-ordering checks must remain enforced.

## Regression cases to add

1. Complete valid input can execute and produces the expected profit.
2. Negative and zero estimated profit cannot execute.
3. Missing price/cost/shipping/FX cannot execute.
4. Negative or non-finite cost/shipping/price/FX cannot execute.
5. NaN, infinite, zero or negative quantity cannot execute.
6. NaN/infinite/negative/insufficient inventory cannot execute.
7. Missing supplier variant, incomplete address, duplicate order, active kill switch, disabled live ordering and unconfigured supplier remain blocked.
8. Tests call the same pure gate function used by supplier execution.

## Rollout safety

This is a safety hardening candidate, not permission to enable live ordering. Implement and test on an isolated branch, verify CI, then shadow-check decisions. Keep production supplier writes disabled until the gate tests and Shopify read-only auth are independently verified.
