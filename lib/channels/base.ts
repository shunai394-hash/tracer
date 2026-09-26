import "server-only";

type BaseItemInput = {
  title: string;
  detail: string;
  price: number;
  stock?: number;
  visible?: boolean;
};

type BaseItemResponse = {
  item?: {
    item_id?: string | number;
  };
  item_id?: string | number;
  [key: string]: unknown;
};

const BASE_API_URL = process.env.BASE_API_URL?.trim() || "https://api.thebase.in/1";
const BASE_ACCESS_TOKEN = process.env.BASE_ACCESS_TOKEN?.trim() || "";

function requireBaseToken() {
  if (!BASE_ACCESS_TOKEN) {
    throw new Error("BASE_ACCESS_TOKEN is not configured");
  }
  return BASE_ACCESS_TOKEN;
}

export async function createBaseItem(input: BaseItemInput) {
  const token = requireBaseToken();

  const body = new URLSearchParams({
    title: input.title,
    detail: input.detail,
    price: String(Math.round(input.price)),
    stock: String(Math.max(0, Math.floor(input.stock ?? 1))),
    visible: input.visible === false ? "0" : "1",
  });

  const response = await fetch(`${BASE_API_URL}/items/add`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  let data: BaseItemResponse | null = null;

  try {
    data = JSON.parse(text) as BaseItemResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`BASE API HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return data ?? { raw: text };
}
