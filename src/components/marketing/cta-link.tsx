'use client';

import type { ReactNode } from 'react';

// MJG-028 — conversion CTAs are real anchors when an app URL is configured
// (navigation between website and app), and keep the historical in-page button
// behavior otherwise. Styling is passed through unchanged so the visuals are
// byte-identical in both modes.
type CtaLinkProps = {
  href: string | null;
  onActivate: () => void;
  className: string;
  children: ReactNode;
};

export function CtaLink({ href, onActivate, className, children }: CtaLinkProps) {
  if (href) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onActivate} className={className}>
      {children}
    </button>
  );
}
