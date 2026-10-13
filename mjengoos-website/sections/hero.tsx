import { HeroAnimation } from "@/components/hero/hero-animation";

/**
 * Homepage hero — the 6-scene animated construction story (issue #402).
 * The whole section (copy column, captions, CTAs, animated canvas) lives
 * in HeroAnimation so the timeline, visibility handling and static
 * fallback stay in one place.
 */
export function Hero() {
  return <HeroAnimation />;
}
