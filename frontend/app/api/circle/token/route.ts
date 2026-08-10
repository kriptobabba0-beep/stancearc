// POST /api/circle/token — mint a per-user session (userToken + encryptionKey) for the SDK.
// The userId comes from the HttpOnly cookie set by /api/circle/users — NOT from the request body —
// so a caller can't mint a session for an arbitrary userId they don't own.
import { NextResponse } from 'next/server';
import { createUserToken } from '@/lib/server/circleServer';
import { errorJson, readCookie, UID_COOKIE } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const userId = readCookie(req, UID_COOKIE);
  if (!userId) {
    return NextResponse.json({ error: 'No wallet session. Create a wallet first.' }, { status: 401 });
  }
  try {
    return NextResponse.json(await createUserToken(userId));
  } catch (e) {
    return errorJson(e);
  }
}
