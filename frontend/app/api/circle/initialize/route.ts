// POST /api/circle/initialize { userToken } — provision the EOA wallet on ARC-TESTNET; returns challengeId.
import { NextResponse } from 'next/server';
import { initializeWallet } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const userToken = reqStr((await readJson(req)).userToken);
  if (!userToken) return badRequest('userToken is required.');
  try {
    return NextResponse.json(await initializeWallet(userToken));
  } catch (e) {
    return errorJson(e);
  }
}
