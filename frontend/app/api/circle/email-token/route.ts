// POST /api/circle/email-token { deviceId, email } - mint an email-OTP device token (Circle sends the OTP).
import { NextResponse } from 'next/server';
import { createEmailDeviceToken } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const b = await readJson(req);
  const deviceId = reqStr(b.deviceId);
  const email = reqStr(b.email);
  if (!deviceId || !email) return badRequest('deviceId and email are required.');
  try {
    return NextResponse.json(await createEmailDeviceToken(deviceId, email));
  } catch (e) {
    return errorJson(e);
  }
}
