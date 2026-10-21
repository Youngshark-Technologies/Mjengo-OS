import { ShieldCheck } from 'lucide-react';

type WorkflowStep = {
  number: string;
  title: string;
  description: string;
};

const STEPS: WorkflowStep[] = [
  {
    number: '01',
    title: 'Record',
    description:
      'Field teams capture materials, deliveries, workforce and work as it happens — from any device on site.',
  },
  {
    number: '02',
    title: 'Review',
    description:
      'Supervisors open the verification queue and inspect each report. Every check is a named human decision.',
  },
  {
    number: '03',
    title: 'Approve',
    description:
      'Owners release payments with full context: purchase orders, deliveries and verified evidence.',
  },
  {
    number: '04',
    title: 'Account',
    description:
      'The dashboard reflects verified facts only — progress you can defend in any audit.',
  },
];

export function WorkflowSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 md:px-8 md:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">
          How MjengoOS works
        </h2>
        <p className="mt-4 text-pretty text-base leading-relaxed text-stone-600 md:text-lg">
          One loop, run by your own team: record what happens on site, have it checked by a named
          person, then pay against verified facts.
        </p>
      </div>

      <ol className="mt-12 grid grid-cols-1 gap-10 sm:grid-cols-2 md:mt-16 lg:grid-cols-4 lg:gap-8">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative">
            {index < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute left-12 top-5 hidden h-px w-[calc(100%-1.5rem)] bg-stone-200 lg:block"
              />
            ) : null}
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500 text-sm font-semibold text-stone-950">
              {step.number}
            </div>
            <h3 className="mt-4 text-lg font-semibold tracking-tight text-stone-900">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">{step.description}</p>
          </li>
        ))}
      </ol>

      <div className="relative mt-12 overflow-hidden rounded-3xl bg-stone-950 p-8 text-stone-50 md:mt-16 md:p-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_85%_0%,rgba(245,158,11,0.16),transparent_70%)]"
        />
        <figure className="relative max-w-2xl">
          <ShieldCheck className="h-8 w-8 text-amber-500" aria-hidden="true" />
          <blockquote className="mt-5 text-balance text-xl font-medium tracking-tight md:text-2xl">
            &ldquo;Every verification is a named human decision — no black boxes.&rdquo;
          </blockquote>
          <figcaption className="mt-3 text-sm leading-relaxed text-stone-400 md:text-base">
            MjengoOS keeps accountability where it belongs: with your people, on your sites.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
