/** Detect common Amazon robot-check responses; HTTP 200 alone is not a usable product page. */
export function isAmazonChallengeHtml(html: string | null, url: string): boolean {
  if (!html) return false;
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (hostname !== "amazon.co.jp" && !hostname.endsWith(".amazon.co.jp")) return false;
  return /(?:validateCaptcha|captcha[.]amazon|robot check|sorry, we just need to make sure you['’]?re not a robot|enter the characters you see below|automated access to amazon|api-services-support@amazon[.]com|ロボットではないことを確認)/i.test(html);
}
