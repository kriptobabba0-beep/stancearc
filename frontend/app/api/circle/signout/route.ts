// POST /api/circle/signout — clear the HttpOnly uid cookie (PIN session). Email/Google keep no cookie.
import { NextResponse } from 'next/server';
import { UID_COOKIE } from '../_lib';

export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(UID_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/circle',
    maxAge: 0,
  });
  return res;
}
