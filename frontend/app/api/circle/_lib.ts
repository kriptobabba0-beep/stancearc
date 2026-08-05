// app/api/circle/_lib.ts - shared helpers for the Circle proxy route handlers (NOT a route itself).
import { NextResponse } from 'next/server';
import { circleHttpError } from '@/lib/server/circleServer';

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Map a thrown Circle/server error to a JSON response (never leaks the API key). */
export function errorJson(e: unknown): NextResponse {
  const { status, message } = circleHttpError(e);
  return NextResponse.json({ error: message }, { status });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export const reqStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

/** HttpOnly cookie that binds a browser to its server-generated Circle userId (so /token can't be
 *  minted for an arbitrary userId). Scoped to /api/circle, ~1 year. */
export const UID_COOKIE = 'fa_circle_uid';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function setUidCookie(res: NextResponse, userId: string): NextResponse {
  res.cookies.set(UID_COOKIE, userId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/circle',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
