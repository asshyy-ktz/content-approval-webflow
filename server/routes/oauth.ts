import { Router } from "express";
import { asyncHandler } from "../services/errors";
import { completeInstall } from "../services/install";
import { buildAuthorizeUrl, consumeState } from "../services/oauth-service";

const router = Router();

router.get("/authorize", (_req, res) => {
  res.redirect(buildAuthorizeUrl());
});

router.get("/callback", asyncHandler(async (req, res) => {
  const code = req.query.code;
  if (typeof code !== "string" || !code) return void res.status(400).send("Missing authorization code");
  if (!consumeState(typeof req.query.state === "string" ? req.query.state : undefined)) {
    return void res.status(400).send("Invalid or expired OAuth state; restart the install from /oauth/authorize");
  }
  try {
    const [first] = await completeInstall(code);
    // Credentials travel in the URL fragment so they never reach server logs or Referer headers.
    res.redirect(`/designer-extension/index.html#site=${encodeURIComponent(first.siteId)}&token=${encodeURIComponent(first.adminToken)}`);
  } catch (err) {
    res.status(502).send(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}));

export default router;
