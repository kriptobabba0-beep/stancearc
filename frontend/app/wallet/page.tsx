import { WalletExperience } from '@/components/wallet/WalletExperience';

export default function WalletPage() {
  return (
    <div className="relative">
      {/* ambient brand glow behind the wallet experience */}
      <div className="pointer-events-none absolute inset-x-0 -top-16 h-64 bg-glow" aria-hidden="true" />
      <div className="relative mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-12">
        <WalletExperience />
      </div>
    </div>
  );
}
