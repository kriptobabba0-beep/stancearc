// POST /api/circle/transactions { userToken } — list the user's recent transactions (history feed).
import { NextResponse } from 'next/server';
import { listTransactions } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const userToken = reqStr((await readJson(req)).userToken);
  if (!userToken) return badRequest('userToken is required.');
  try {
    return NextResponse.json({ transactions: await listTransactions(userToken) });
  } catch (e) {
    return errorJson(e);
  }
}
