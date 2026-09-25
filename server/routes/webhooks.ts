import { Router } from "express";
import { WebflowItemWebhookPayload, WebflowWebhookEnvelope } from "../../shared/webflow-types";
import { config } from "../config";
import { db } from "../db";
import { asyncHandler } from "../services/errors";
import { purgeInstallation } from "../services/install";
import { handleItemChanged, handleItemDeleted } from "../services/items";
import { verifyWebflowSignature } from "../services/webhook-verify";

// Mounted behind express.raw() in index.ts so signatures are checked against the exact bytes received.
const router = Router();

function parsePayload(raw: Buffer): WebflowItemWebhookPayload {
  const json = JSON.parse(raw.toString("utf8")) as WebflowWebhookEnvelope<WebflowItemWebhookPayload> | WebflowItemWebhookPayload;
  return "payload" in json && json.payload && typeof json.payload === "object" ? (json.payload as WebflowItemWebhookPayload) : (json as WebflowItemWebhookPayload);
}

router.post("/:siteId/:event", asyncHandler(async (req, res) => {
  const { siteId, event } = req.params;
  const raw = req.body as Buffer;
  if (!verifyWebflowSignature(raw, req.header("x-webflow-signature"), req.header("x-webflow-timestamp"), config.webflow.clientSecret)) {
    return void res.status(401).json({ error: "Invalid signature" });
  }
  if (event === "app-uninstalled") {
    purgeInstallation(siteId);
    return void res.json({ ok: true });
  }
  if (!db.get(`SELECT 1 AS x FROM installations WHERE site_id = ?`, [siteId])) return void res.status(202).json({ ok: true, ignored: "site not installed" });

  if (event === "item-changed" || event === "item-created" || event === "item-deleted") {
    let payload: WebflowItemWebhookPayload;
    try {
      payload = parsePayload(raw);
    } catch {
      return void res.status(400).json({ error: "Invalid JSON body" });
    }
    // Acknowledge immediately; reconciling may call the (rate-limited) Data API.
    res.json({ ok: true });
    const work = event === "item-deleted" ? Promise.resolve(handleItemDeleted(siteId, payload)) : handleItemChanged(siteId, payload);
    work.catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[webhook] ${event} failed for ${siteId}:`, err);
    });
    return;
  }
  res.status(404).json({ error: "Unknown event" });
}));

export default router;
