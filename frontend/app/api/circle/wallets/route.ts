// POST /api/circle/wallets { userToken } - list the user's wallets (to read the EVM address after creation).
import { NextResponse } from 'next/server';
import { listWallets } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const userToken = reqStr((await readJson(req)).userToken);
  if (!userToken) return badRequest('userToken is required.');
  try {
    return NextResponse.json({ wallets: await listWallets(userToken) });
  } catch (e) {
    return errorJson(e);
  }
}
