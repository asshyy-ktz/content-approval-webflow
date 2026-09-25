import { NextFunction, Request, RequestHandler, Response } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function toHttpError(err: unknown): HttpError | null {
  return err instanceof HttpError ? err : null;
}

export function intParam(value: unknown, name: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
  return n;
}

export function strParam(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${name} is required`);
  return value.trim();
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dayParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !DAY_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return value;
}
