/**
 * Ports between TRACER's policy core and I/O adapters.
 *
 * These are interfaces only. Existing production routes are not wired to them
 * in this foundation change; implementations must be added behind shadow tests.
 */
import type {
  ExternalWriteOutcome,
  OrderExecutionDecision,
  OrderDisposition,
  PublicationDecision,
  PublicationEvidence,
  ProviderProbe,
} from "./contracts";

export type ApprovedPublicationDecision = {
  eligible: true;
  blockers: [];
  expectedUnitMargin: number;
};

/** Only a fully eligible, positive-margin policy result can cross the write port. */
export function approvePublicationDecision(
  decision: PublicationDecision,
): ApprovedPublicationDecision | null {
  if (
    decision.eligible !== true ||
    decision.blockers.length !== 0 ||
    decision.expectedUnitMargin === null ||
    !Number.isFinite(decision.expectedUnitMargin) ||
    decision.expectedUnitMargin <= 0
  ) return null;

  return {
    eligible: true,
    blockers: [],
    expectedUnitMargin: decision.expectedUnitMargin,
  };
}

export type ApprovedOrderExecutionDecision = {
  eligible: true;
  blockers: [];
  estimatedUnitProfit: number;
  attemptDisposition: Extract<OrderDisposition, { action: "process" }>;
};

/** Unknown, unprofitable, duplicate, or ambiguous order decisions cannot authorize procurement. */
export function approveOrderExecutionDecision(
  decision: OrderExecutionDecision,
): ApprovedOrderExecutionDecision | null {
  if (
    decision.eligible !== true ||
    decision.blockers.length !== 0 ||
    decision.estimatedUnitProfit === null ||
    !Number.isFinite(decision.estimatedUnitProfit) ||
    decision.estimatedUnitProfit <= 0 ||
    decision.attemptDisposition.action !== "process"
  ) return null;

  return {
    eligible: true,
    blockers: [],
    estimatedUnitProfit: decision.estimatedUnitProfit,
    attemptDisposition: decision.attemptDisposition,
  };
}

export type ChannelName = "base" | "shopify";

export type ListingPayload = {
  title: string;
  description: string;
  imageUrl: string;
  sku: string | null;
  sellingPrice: number;
  currency: string;
  inventoryAvailable: number;
};

export type ChannelPublishCommand = {
  listingId: string;
  idempotencyKey: string;
  decision: ApprovedPublicationDecision;
  payload: ListingPayload;
};

export type ChannelUnpublishCommand = {
  listingId: string;
  externalProductId: string;
  idempotencyKey: string;
  reason: string;
};

export type RemoteListingSnapshot = {
  exists: boolean;
  externalProductId: string | null;
  externalVariantIds: string[];
  published: boolean | null;
  title: string | null;
  imageUrl: string | null;
};

export interface ChannelPublicationPort {
  readonly channel: ChannelName;
  probe(): Promise<ProviderProbe>;
  publish(command: ChannelPublishCommand): Promise<ExternalWriteOutcome>;
  unpublish(command: ChannelUnpublishCommand): Promise<ExternalWriteOutcome>;
  reconcile(input: {
    listingId: string;
    externalProductId: string | null;
  }): Promise<RemoteListingSnapshot | null>;
}

export type NormalizedExternalOrder = {
  channel: ChannelName;
  externalOrderId: string;
  paymentStatus: string | null;
  paymentMethod: string | null;
  currency: string | null;
  totalAmount: number | null;
  lineItems: Array<{
    externalLineItemId: string;
    channelProductId: string | null;
    sku: string | null;
    quantity: number | null;
    unitPrice: number | null;
    currency: string | null;
  }>;
};

export type ExternalOrderPage = {
  orders: NormalizedExternalOrder[];
  nextCursor: string | null;
};

export interface OrderIngestionPort {
  readonly channel: ChannelName;
  listOrders(input: { cursor: string | null; limit: number }): Promise<ExternalOrderPage>;
  getOrder(externalOrderId: string): Promise<NormalizedExternalOrder | null>;
}

export type SupplierVariantSnapshot = {
  supplierProductId: string;
  supplierVariantId: string;
  identityVerified: boolean;
  inventoryKnown: boolean;
  inventoryAvailable: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  currency: string | null;
  orderable: boolean;
  trackingAvailable: boolean;
};

export type SupplierOrderReceipt = {
  supplierOrderId: string | null;
  status: "submitted" | "confirmed" | "failed" | "unknown";
  providerRequestId?: string | null;
};

export interface SupplierProcurementPort {
  readonly supplier: string;
  inspectVariant(input: {
    supplierProductId: string;
    supplierVariantId: string;
    destinationCountryCode: string;
    destinationPostalCode: string;
  }): Promise<SupplierVariantSnapshot>;
  placeOrder(input: {
    purchaseOrderId: string;
    idempotencyKey: string;
    supplierProductId: string;
    supplierVariantId: string;
    quantity: number;
    decision: ApprovedOrderExecutionDecision;
  }): Promise<ExternalWriteOutcome>;
  reconcileOrder(input: {
    idempotencyKey: string;
    supplierOrderId: string | null;
  }): Promise<SupplierOrderReceipt | null>;
}

export interface CommerceRepositoryPort {
  loadPublicationEvidence(listingId: string): Promise<PublicationEvidence | null>;
  recordPublicationDecision(input: {
    listingId: string;
    decision: PublicationDecision;
    evaluatedAt: string;
  }): Promise<void>;
  recordExternalWriteOutcome(input: {
    channel: ChannelName;
    listingId: string;
    outcome: ExternalWriteOutcome;
    recordedAt: string;
  }): Promise<void>;
}
