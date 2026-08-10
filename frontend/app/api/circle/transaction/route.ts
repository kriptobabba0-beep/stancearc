// POST /api/circle/transaction { userToken, id } — poll a transaction's state. (POST keeps the token out of URLs.)
import { NextResponse } from 'next/server';
import { getTransaction } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const b = await readJson(req);
  const userToken = reqStr(b.userToken);
  const id = reqStr(b.id);
  if (!userToken || !id) return badRequest('userToken and id are required.');
  try {
    return NextResponse.json(await getTransaction(id, userToken));
  } catch (e) {
    return errorJson(e);
  }
}
