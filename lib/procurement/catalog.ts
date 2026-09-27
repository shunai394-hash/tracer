import "server-only";

export type ProcurementProductQuery = {
  productId?: string;
  identifier?: string;
  keyword?: string;
  countryCode?: string;
};

export type ProcurementProduct = {
  supplierProductId: string;
  supplierName: string;
  title: string;
  identifier: string | null;
  currency: string | null;
  unitCost: number | null;
  shippingCost: number | null;
  available: boolean | null;
  orderable: boolean | null;
  trackingAvailable: boolean | null;
  sourceUrl: string | null;
};

export interface ProcurementCatalog {
  readonly name: string;

  search(
    query: ProcurementProductQuery,
  ): Promise<ProcurementProduct[]>;

  getProduct(
    supplierProductId: string,
  ): Promise<ProcurementProduct | null>;
}
