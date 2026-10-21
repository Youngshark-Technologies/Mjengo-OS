import {
  Boxes,
  ClipboardCheck,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

type Pillar = {
  title: string;
  description: string;
  icon: LucideIcon;
};

const PILLARS: Pillar[] = [
  {
    title: 'Procurement',
    icon: ShoppingCart,
    description: 'Raise purchase orders with line-item clarity and supplier history in one place.',
  },
  {
    title: 'Inventory',
    icon: Boxes,
    description: 'Every bag, ton and pallet tracked per site with a full movement ledger.',
  },
  {
    title: 'Workforce',
    icon: Users,
    description: 'Assign crews, take daily attendance and know who was on site.',
  },
  {
    title: 'Deliveries',
    icon: Truck,
    description: 'Record incoming deliveries and verify quantities before they hit stock.',
  },
  {
    title: 'Site evidence',
    icon: ClipboardCheck,
    description: 'Field reports flow into a verification queue reviewed by named supervisors.',
  },
  {
    title: 'Payments',
    icon: Wallet,
    description: 'Owner-approved payments with a full audit trail from PO to payout.',
  },
];

export function ProductPillars() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16 md:px-8 md:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold tracking-widest text-amber-600">THE PLATFORM</p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">
          Everything a site needs. Nothing it doesn&rsquo;t.
        </h2>
        <p className="mt-4 text-pretty text-base leading-relaxed text-stone-600 md:text-lg">
          Procurement, inventory, workforce, deliveries, site evidence and payments all write to one
          shared record of your project. No re-keying, no reconciliation — every team works from the
          same connected source of truth.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16 lg:grid-cols-3 lg:gap-6">
        {PILLARS.map((pillar) => (
          <div
            key={pillar.title}
            className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10">
              <pillar.icon className="h-5 w-5 text-amber-600" aria-hidden="true" />
            </div>
            <h3 className="mt-4 font-semibold text-stone-900">{pillar.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">{pillar.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
