/**
 * Receiving-document status model (PRD §6, technical-spec §8). Pure functions — no I/O — so the whole
 * state machine is unit-testable and every transition goes through one table.
 */

export const DOCUMENT_STATUSES = ['OPEN', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'COMPLETED', 'CANCELLED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export type DocumentAction = 'RECEIPT' | 'COMPLETE' | 'CANCEL';

/** action -> statuses that may result, per current status. An action that is absent is not allowed (BR-07, BR-10..12). */
const TRANSITIONS: Record<DocumentStatus, Partial<Record<DocumentAction, readonly DocumentStatus[]>>> = {
  OPEN: { RECEIPT: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED'], CANCEL: ['CANCELLED'] },
  PARTIALLY_RECEIVED: { RECEIPT: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED'] },
  FULLY_RECEIVED: { COMPLETE: ['COMPLETED'] },
  COMPLETED: {},
  CANCELLED: {},
};

export const isTerminal = (status: DocumentStatus): boolean => status === 'COMPLETED' || status === 'CANCELLED';

export function isActionAllowed(status: DocumentStatus, action: DocumentAction): boolean {
  return TRANSITIONS[status][action] !== undefined;
}

export function isTransitionAllowed(from: DocumentStatus, to: DocumentStatus): boolean {
  return Object.values(TRANSITIONS[from]).some((targets) => targets?.includes(to));
}

/** Status after a receipt, derived from item quantities (BR-15). Users never set this directly. */
export function deriveReceivingStatus(
  items: ReadonlyArray<{ expectedQuantity: number; receivedQuantity: number }>,
): 'OPEN' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED' {
  if (items.length === 0) return 'OPEN';
  if (items.every((i) => i.receivedQuantity === i.expectedQuantity)) return 'FULLY_RECEIVED';
  if (items.some((i) => i.receivedQuantity > 0)) return 'PARTIALLY_RECEIVED';
  return 'OPEN';
}
