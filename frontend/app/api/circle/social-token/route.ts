// POST /api/circle/social-token { deviceId } - mint a social-login (Google) device token.
import { NextResponse } from 'next/server';
import { createSocialDeviceToken } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const deviceId = reqStr((await readJson(req)).deviceId);
  if (!deviceId) return badRequest('deviceId is required.');
  try {
    return NextResponse.json(await createSocialDeviceToken(deviceId));
  } catch (e) {
    return errorJson(e);
  }
}
