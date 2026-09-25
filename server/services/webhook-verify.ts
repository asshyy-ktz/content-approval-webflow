import crypto from "crypto";
import { safeEqual } from "./auth";

const TOLERANCE_MS = 5 * 60 * 1000;

/** Webflow signs `${timestamp}:${rawBody}` with HMAC-SHA256 using the app client secret. */
export function verifyWebflowSignature(rawBody: Buffer, signature: string | undefined, timestamp: string | undefined, secret: string): boolean {
  if (!signature || !timestamp || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TOLERANCE_MS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${rawBody.toString("utf8")}`).digest("hex");
  return safeEqual(expected, signature);
}

export function hmacHex(secret: string, body: string | Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyBodySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  return safeEqual(hmacHex(secret, rawBody), signature.replace(/^sha256=/, ""));
}
