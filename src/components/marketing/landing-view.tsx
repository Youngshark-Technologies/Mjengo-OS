'use client';

import { useCallback } from 'react';
import { HardHat } from 'lucide-react';

import { Hero } from './hero';
import { MarketingFooter } from './marketing-footer';
import { ProductPillars } from './product-pillars';
import { WorkflowSection } from './workflow-section';
import { CtaLink } from './cta-link';

type LandingViewProps = {
  onExplore: () => void;
  onGetStarted: () => void;
  /** MJG-028 — when set, Get Started CTAs navigate to the app instead of toggling in-page auth. */
  getStartedHref?: string | null;
};

export default function LandingView({ onExplore, onGetStarted, getStartedHref = null }: LandingViewProps) {
  const scrollToPillars = useCallback(() => {
    document.getElementById('pillars')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  /**
   * In-view smooth scroll is the authoritative "Explore" behavior on the landing
   * page. The parent-provided onExplore stays as a defensive fallback for hosts
   * that render this view without the pillars anchor.
   */
  const handleExplore = useCallback(() => {
    const pillars = document.getElementById('pillars');
    if (pillars) {
      pillars.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    onExplore();
  }, [onExplore]);

  return (
    <div className="flex min-h-screen flex-col bg-stone-50 text-stone-900">
      <header className="sticky top-0 z-40 border-b border-stone-200/60 bg-stone-50/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <div aria-hidden="true" className="rounded-md bg-stone-950 p-1.5">
              <HardHat className="h-4 w-4 text-amber-500" />
            </div>
            <span className="font-bold tracking-tight text-stone-900">MjengoOS</span>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <button
              type="button"
              onClick={handleExplore}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-stone-300 bg-white/70 px-4 text-sm font-semibold text-stone-800 transition-colors hover:border-stone-400 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
            >
              Explore
            </button>
            <CtaLink
              href={getStartedHref}
              onActivate={onGetStarted}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-amber-500 px-4 text-sm font-semibold text-stone-950 transition-colors hover:bg-amber-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            >
              Get Started
            </CtaLink>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Hero onExplore={scrollToPillars} onGetStarted={onGetStarted} getStartedHref={getStartedHref} />
        <div id="pillars" className="scroll-mt-16">
          <ProductPillars />
        </div>
        <div id="how" className="scroll-mt-16">
          <WorkflowSection />
        </div>
      </main>

      <MarketingFooter onGetStarted={onGetStarted} getStartedHref={getStartedHref} />
    </div>
  );
}
