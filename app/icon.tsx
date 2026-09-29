import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

function Mark() {
  return (
    <svg width="512" height="512" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#07152f"/><stop offset="55%" stopColor="#02040b"/><stop offset="100%" stopColor="#0b0a1f"/></linearGradient>
        <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#22d3ee"/><stop offset="45%" stopColor="#2563eb"/><stop offset="72%" stopColor="#8b5cf6"/><stop offset="100%" stopColor="#ec4899"/></linearGradient>
      </defs>
      <rect x="20" y="20" width="472" height="472" rx="105" fill="url(#bg)"/>
      <path d="M102 150 H410 L388 184 H125 Z" fill="url(#mark)"/>
      <path d="M246 181 C208 194 180 224 174 259 C169 288 180 318 198 342 L224 376 L224 405 C224 416 235 421 245 416 L281 398 C290 394 296 385 296 375 V231 C296 207 309 190 334 181 Z" fill="url(#mark)"/>
      <path d="M327 242 L398 284 C408 290 408 303 398 309 L327 351 C317 357 305 350 305 338 V255 C305 243 317 236 327 242 Z" fill="url(#mark)"/>
    </svg>
  );
}

export default function Icon() {
  return new ImageResponse(<Mark />, { ...size });
}
