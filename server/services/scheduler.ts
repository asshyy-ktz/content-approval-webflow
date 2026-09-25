import { config } from "../config";
import { sendDueReminders } from "./reviews";

function every(minutes: number, name: string, fn: () => void | Promise<void>): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[job:${name}] failed:`, err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, minutes * 60000).unref();
}

export function startJobs(): void {
  every(config.jobs.reminderMin, "reminders", () => {
    sendDueReminders();
  });
}
