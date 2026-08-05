'use client';

import { AdminDemoPanel } from '@/components/AdminDemoPanel';
import { ActivityFeed } from '@/components/ActivityFeed';

export default function AdminPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 motion-safe:animate-fade-up">
        <span className="kicker">Operator console</span>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">
          Demo &amp; Admin
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink-soft">
          Owner-only lifecycle cranks, the mock oracle, and demo swaps. The contract enforces
          ownership regardless of what is shown here.
        </p>
      </header>
      <div className="grid items-start gap-5 lg:grid-cols-[1fr_340px]">
        <div className="motion-safe:animate-fade-up" style={{ animationDelay: '60ms' }}>
          <AdminDemoPanel />
        </div>
        <div className="motion-safe:animate-fade-up" style={{ animationDelay: '120ms' }}>
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}
