import { Container } from "@/components/container";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/button";
import { Badge } from "@/components/badge";
import { ChevronDown } from "lucide-react";

/**
 * Project management (§20) — lifecycle from planning to handover.
 */
const LIFECYCLE = [
  "Planning", "BOQ", "Contractor", "Procurement", "Construction", "Inspection", "Payment", "Handover",
] as const;

export function ProjectManagement() {
  return (
    <section aria-labelledby="pm-heading" className="relative overflow-hidden border-b border-ink/10 bg-forest-950">
      <div className="absolute inset-0 bg-survey-grid-dark" aria-hidden />
      <div className="relative">
      <Container className="py-20 lg:py-28">
        <SectionHeading
          dark
          eyebrow="Project management"
          title={<span id="pm-heading">One project. One source of truth.</span>}
          description="Phases, tasks, milestones, variations, approvals — the operational spine of the build, kept in the same record as the evidence and the money."
        />

        {/* Lifecycle pipeline */}
        <Reveal delay={150} className="mt-12">
          <ol className="flex flex-wrap items-center gap-2" aria-label="Project lifecycle from planning to handover">
            {LIFECYCLE.map((stage, i) => (
              <li key={stage} className="flex items-center gap-2">
                <span
                  className={
                    i === LIFECYCLE.length - 1
                      ? "rounded-md border border-earth-400/50 bg-earth-500/15 px-3.5 py-2 font-display text-[13.5px] font-semibold text-earth-300"
                      : "rounded-md border border-forest-700 bg-forest-900/70 px-3.5 py-2 font-display text-[13.5px] font-semibold text-forest-50"
                  }
                >
                  {stage}
                </span>
                {i < LIFECYCLE.length - 1 && (
                  <ChevronDown className="h-3.5 w-3.5 rotate-[-90deg] text-forest-600" aria-hidden />
                )}
              </li>
            ))}
          </ol>
        </Reveal>

        {/* Feature grid */}
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: "Phases with budgets",
              text: "Every phase carries its own budget, progress and status — the BOQ made operational.",
            },
            {
              title: "Milestones tied to evidence",
              text: "Money releases when photo proof is attached and the client approves. Not before.",
            },
            {
              title: "Variations, documented",
              text: "Scope changes submitted, decided and priced — with the full decision history.",
            },
            {
              title: "Daily site record",
              text: "Attendance, deliveries, issues and photos assemble into the day's report.",
            },
            {
              title: "Approvals with a trail",
              text: "Who approved what, when, with what note. The ledger remembers everything.",
            },
            {
              title: "Handover = the record",
              text: "Completion hands over more than keys — the project's full, auditable history.",
            },
          ].map((f, i) => (
            <Reveal key={f.title} delay={i * 60}>
              <article className="h-full rounded-xl border border-forest-800 bg-forest-900/60 p-6">
                <h3 className="font-display text-[17px] font-semibold text-forest-50">{f.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-forest-300/85">{f.text}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={200} className="mt-10">
          <div className="flex flex-wrap items-center gap-4">
            <Button href="/platform" variant="outline-dark">
              Explore the platform
            </Button>
            <Badge tone="dark" className="border-forest-700">
              <span className="font-mono text-[10px] tracking-wider">PLANNING → HANDOVER</span>
            </Badge>
          </div>
        </Reveal>
      </Container>
      </div>
    </section>
  );
}
