'use client';

// components/wallet/QrCode.tsx — a crisp SVG QR for a wallet address. Rendered on a white card so it
// stays scannable on the dark theme. Generated from our own address string (no remote/user input).

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { cn } from '@/lib/cn';

export function QrCode({ value, className }: { value: string; className?: string }) {
  const html = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  }, [value]);

  return (
    <div
      className={cn('overflow-hidden rounded-2xl bg-white p-3 [&_svg]:block [&_svg]:h-full [&_svg]:w-full', className)}
      aria-label="Wallet address QR code"
      role="img"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
