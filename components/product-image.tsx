"use client";

import { useEffect, useRef, useState } from "react";

// Supplier/CDN image URLs occasionally go stale; show a calm placeholder instead of a broken icon.
export function ProductImage({ src, alt, className, eager = false }: { src: string | null; alt: string; className: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // An SSR image can fail before hydration attaches onError, so re-check once mounted.
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  if (!src || failed) {
    return <div className={`${className} flex items-center justify-center text-sm text-neutral-400`}>画像準備中</div>;
  }
  return <img ref={ref} src={src} alt={alt} loading={eager ? "eager" : "lazy"} onError={() => setFailed(true)} className={className} />;
}
