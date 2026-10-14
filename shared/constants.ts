export const STATUSES = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pending', confirmed: 'Confirmed', checked_in: 'Checked in', in_progress: 'In progress',
  completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};

/** Allowed status transitions. Completed, cancelled and no-show are terminal. */
export const TRANSITIONS: Record<Status, Status[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [], cancelled: [], no_show: [],
};

/** Statuses that occupy the barber's calendar. */
export const ACTIVE_STATUSES: Status[] = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'];

export const SOURCES = ['website', 'phone', 'walk_in', 'whatsapp', 'in_person', 'other'] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABEL: Record<Source, string> = {
  website: 'Website', phone: 'Phone', walk_in: 'Walk-in', whatsapp: 'WhatsApp', in_person: 'In person', other: 'Other',
};

export const METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<Method, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };

export const COMP_MODELS = ['commission', 'fixed_per_service', 'salary', 'none'] as const;
export type CompModel = (typeof COMP_MODELS)[number];
export const COMP_LABEL: Record<CompModel, string> = {
  commission: 'Commission %', fixed_per_service: 'Fixed per service', salary: 'Fixed salary', none: 'No automatic compensation',
};
export const COMP_BASES = ['completed', 'paid'] as const;
export type CompBasis = (typeof COMP_BASES)[number];
export const COMP_BASIS_LABEL: Record<CompBasis, string> = {
  completed: 'Earned when the service is completed', paid: 'Earned once the completed service is paid in full',
};
