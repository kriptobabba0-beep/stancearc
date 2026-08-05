// POST /api/circle/execute - create a contract-execution challenge for the user's embedded wallet.
// Body: { userToken, walletId, contractAddress, abiFunctionSignature, abiParameters[], amount?, feeLevel? }
import { NextResponse } from 'next/server';
import { contractExecution, type FeeLevel } from '@/lib/server/circleServer';
import { readJson, errorJson, badRequest, reqStr } from '../_lib';

export const runtime = 'nodejs';

const FEE_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);

export async function POST(req: Request): Promise<NextResponse> {
  const b = await readJson(req);
  const userToken = reqStr(b.userToken);
  const walletId = reqStr(b.walletId);
  const contractAddress = reqStr(b.contractAddress);
  const callData = reqStr(b.callData);
  const abiFunctionSignature = reqStr(b.abiFunctionSignature);
  const hasAbi = !!abiFunctionSignature && Array.isArray(b.abiParameters);
  if (!userToken || !walletId || !contractAddress || (!callData && !hasAbi)) {
    return badRequest(
      'userToken, walletId, contractAddress, and (callData OR abiFunctionSignature+abiParameters) are required.',
    );
  }
  const feeLevel = reqStr(b.feeLevel);
  try {
    return NextResponse.json(
      await contractExecution(userToken, {
        walletId,
        contractAddress,
        callData: callData || undefined,
        abiFunctionSignature: hasAbi ? abiFunctionSignature : undefined,
        abiParameters: hasAbi ? (b.abiParameters as unknown[]) : undefined,
        amount: b.amount != null ? String(b.amount) : undefined,
        feeLevel: feeLevel && FEE_LEVELS.has(feeLevel) ? (feeLevel as FeeLevel) : undefined,
      }),
    );
  } catch (e) {
    return errorJson(e);
  }
}
