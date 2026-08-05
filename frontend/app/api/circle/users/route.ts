// POST /api/circle/users - create a Circle user; returns a generated userId. (Server holds the API key.)
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createUser } from '@/lib/server/circleServer';
import { errorJson, setUidCookie } from '../_lib';

export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  const userId = randomUUID(); // ≤ 50 chars; opaque per-browser identity, bound to an HttpOnly cookie.
  try {
    await createUser(userId);
    // The userId is returned to the client for reference only - it is NOT trusted as input later;
    // /token reads it from the HttpOnly cookie set here, so sessions can't be minted for another user.
    return setUidCookie(NextResponse.json({ userId }), userId);
  } catch (e) {
    return errorJson(e);
  }
}
