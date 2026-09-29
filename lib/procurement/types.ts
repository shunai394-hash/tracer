import "server-only";

export type SupplierProduct = {
  supplierProductId: string;
  supplierName: string;
  title: string;
  currency: string;
  unitCost: number | null;
  shippingCost: number | null;
  available: boolean | null;
  orderable: boolean | null;
  trackingAvailable: boolean | null;
};

export type SupplierVariant = {
  supplierVariantId: string;
  supplierProductId: string;
  sku: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  inventory: number | null;
  orderable: boolean | null;
};

export type SupplierInventory = {
  supplierProductId: string;
  supplierVariantId: string | null;
  quantity: number | null;
  available: boolean | null;
  observedAt: string;
};

export type SupplierPrice = {
  supplierProductId: string;
  supplierVariantId: string | null;
  amount: number | null;
  currency: string | null;
  observedAt: string;
};

export type SupplierShippingContext = {
  destinationCountryCode?: string;
  destinationPostalCode?: string;
  quantity?: number;
};

export type SupplierShipping = {
  supplierProductId: string;
  supplierVariantId: string | null;
  amount: number | null;
  currency: string | null;
  available: boolean | null;
  observedAt: string;
};

export type SupplierOrderInput = {
  supplierName?: string;
  orderNumber: string;
  supplierProductId: string;
  supplierVariantId: string;
  quantity: number;
  shippingCountryCode: string;
  shippingCountry?: string;
  shippingProvince: string;
  shippingCity: string;
  shippingAddress: string;
  shippingAddress2?: string;
  shippingZip: string;
  shippingPhone: string;
  shippingCustomerName: string;
  email?: string;
};

export type SupplierOrderResult = {
  succeeded: boolean;
  dryRun?: boolean;
  supplierOrderId: string | null;
  responseCode: string;
  responseMessage: string | null;
  trackingNumber: string | null;
  raw: unknown;
};

export type SupplierOrder = {
  supplierOrderId: string;
  supplierName: string;
  status: string | null;
  createdAt: string | null;
};

export type SupplierTracking = {
  supplierOrderId: string;
  trackingNumber: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
};

export interface TracerSupplierAdapter {
  readonly name: string;

  getProduct(
    supplierProductId: string,
  ): Promise<SupplierProduct | null>;

  search(query: string): Promise<SupplierProduct[]>;

  getVariant(
    supplierProductId: string,
    supplierVariantId: string,
  ): Promise<SupplierVariant | null>;

  getInventory(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierInventory | null>;

  getPrice(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierPrice | null>;

  getShipping(
    supplierProductId: string,
    supplierVariantId?: string,
    context?: SupplierShippingContext,
  ): Promise<SupplierShipping | null>;

  createOrder(
    input: SupplierOrderInput,
  ): Promise<SupplierOrderResult>;

  getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null>;

  getTracking(supplierOrderId: string): Promise<SupplierTracking | null>;
}

