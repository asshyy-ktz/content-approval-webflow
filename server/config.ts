import "dotenv/config";

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, ""),
  webflow: {
    clientId: process.env.WEBFLOW_CLIENT_ID || "",
    clientSecret: process.env.WEBFLOW_CLIENT_SECRET || "",
    redirectUri: process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback",
    scopes: (process.env.WEBFLOW_SCOPES || "cms:read,cms:write,sites:read,authorized_user:read").split(",").map((s) => s.trim()).filter(Boolean),
  },
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || "dev-only-insecure-key",
  defaultReminderLeadHours: Math.max(1, Math.floor(num(process.env.DEFAULT_REMINDER_LEAD_HOURS, 24))),
  jobs: {
    reminderMin: Math.max(1, num(process.env.REMINDER_INTERVAL_MIN, 15)),
  },
};
