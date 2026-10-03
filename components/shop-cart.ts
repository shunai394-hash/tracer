"use client";

import { useEffect, useState } from "react";

export type ShopCartItem = {
  listingId: string;
  slug: string;
  title: string;
  unitPrice: number;
  currency: string;
  imageUrl: string | null;
  qty: number;
};

const KEY = "tracer-shop-cart";

function readCart(): ShopCartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ShopCartItem[]) : [];
  } catch {
    return [];
  }
}

function writeCart(items: ShopCartItem[]) {
  window.localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event("tracer-cart"));
}

export function useShopCart() {
  const [items, setItems] = useState<ShopCartItem[]>([]);

  useEffect(() => {
    const sync = () => setItems(readCart());
    sync();
    window.addEventListener("tracer-cart", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("tracer-cart", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  function add(item: Omit<ShopCartItem, "qty">, qty = 1) {
    const current = readCart();
    const existing = current.find((row) => row.listingId === item.listingId);
    const next = existing
      ? current.map((row) =>
          row.listingId === item.listingId
            ? { ...row, qty: row.qty + qty }
            : row,
        )
      : [...current, { ...item, qty }];
    writeCart(next);
    setItems(next);
  }

  function setQuantity(listingId: string, qty: number) {
    const next = qty <= 0
      ? readCart().filter((row) => row.listingId !== listingId)
      : readCart().map((row) => row.listingId === listingId ? { ...row, qty } : row);
    writeCart(next);
    setItems(next);
  }

  function remove(listingId: string) {
    setQuantity(listingId, 0);
  }

  function clear() {
    writeCart([]);
    setItems([]);
  }

  return { items, add, setQuantity, remove, clear };
}
