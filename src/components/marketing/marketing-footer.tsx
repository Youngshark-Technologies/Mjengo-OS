'use client';

import { CtaLink } from './cta-link';

type MarketingFooterProps = {
  onGetStarted: () => void;
  /** MJG-028 — when set, Get Started CTAs navigate to the app instead of toggling in-page auth. */
  getStartedHref?: string | null;
};

export function MarketingFooter({ onGetStarted, getStartedHref = null }: MarketingFooterProps) {
  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-12 md:px-8 md:pb-16">
      {/* CTA band */}
      <div className="relative overflow-hidden rounded-3xl bg-stone-950 p-8 text-center md:p-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_90%_at_50%_0%,rgba(245,158,11,0.14),transparent_70%)]"
        />
        <div className="relative">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-stone-50 md:text-4xl">
            Ready to build with evidence?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-base leading-relaxed text-stone-400">
            Start with one site — record real deliveries, stock and attendance, and let named
            supervisors verify every report before it counts.
          </p>
          <CtaLink
            href={getStartedHref}
            onActivate={onGetStarted}
            className="mt-8 inline-flex h-11 items-center justify-center rounded-lg bg-amber-500 px-6 text-sm font-semibold text-stone-950 shadow-[0_12px_28px_-12px_rgba(245,158,11,0.65)] transition-colors hover:bg-amber-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          >
            Get Started
          </CtaLink>
        </div>
      </div>

      {/* Footer row */}
      <div className="mt-12 border-t border-stone-200 pt-8">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <p className="font-bold tracking-tight text-stone-900">MjengoOS</p>
            <p className="mt-1 text-sm text-stone-500">
              The evidence-backed operating system for construction.
            </p>
          </div>
          <nav aria-label="Footer" className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => scrollToSection('pillars')}
              className="text-sm text-stone-500 transition-colors hover:text-stone-900"
            >
              Features
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('how')}
              className="text-sm text-stone-500 transition-colors hover:text-stone-900"
            >
              How it works
            </button>
            <CtaLink
              href={getStartedHref}
              onActivate={onGetStarted}
              className="text-sm text-stone-500 transition-colors hover:text-stone-900"
            >
              Get started
            </CtaLink>
          </nav>
        </div>
        <p className="mt-8 text-xs text-stone-400">
          © 2026 MjengoOS — Built for real construction teams.
        </p>
      </div>
    </footer>
  );
}
