import { jsonResponse } from "./money";

/** RFC 7807 problem+json responses. */
export function problem(status: number, title: string, detail?: string, extra: Record<string, unknown> = {}) {
  return jsonResponse(
    { type: `https://httpstatuses.io/${status}`, title, status, detail, ...extra },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

export function requestId(req: Request): string {
  return req.headers.get("x-request-id") ?? crypto.randomUUID();
}
