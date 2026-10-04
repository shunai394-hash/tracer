"use client";

import { useEffect, useRef } from "react";

export function HomeAtmosphere() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let x = 0.5;
    let y = 0.5;
    let targetX = 0.5;
    let targetY = 0.5;

    const onPointerMove = (event: PointerEvent) => {
      targetX = event.clientX / window.innerWidth;
      targetY = event.clientY / window.innerHeight;
    };

    const render = () => {
      x += (targetX - x) * 0.045;
      y += (targetY - y) * 0.045;
      node.style.setProperty("--pointer-x", `${x * 100}%`);
      node.style.setProperty("--pointer-y", `${y * 100}%`);
      node.style.setProperty("--pointer-shift-x", `${(x - 0.5) * 34}px`);
      node.style.setProperty("--pointer-shift-y", `${(y - 0.5) * 26}px`);
      frame = window.requestAnimationFrame(render);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    frame = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className="tracer-home-atmosphere" aria-hidden="true">
      <div className="tracer-home-atmosphere-glow" />
      <div className="tracer-home-atmosphere-beam" />
      <div className="tracer-home-atmosphere-marker tracer-home-atmosphere-marker-a">TRACE / 001</div>
      <div className="tracer-home-atmosphere-marker tracer-home-atmosphere-marker-b">TEST / NEXT</div>
      <div className="tracer-home-atmosphere-cursor" />
    </div>
  );
}
