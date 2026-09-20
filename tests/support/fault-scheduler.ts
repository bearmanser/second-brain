import type { MutationReceipt, PlannedWrite } from '../../src/core/types.js';
import type {
  AuditEvent,
  AuditEventRecord,
  FeedbackEntry,
  FeedbackWrite,
  FeedbackWriteResult,
  Journal,
  OperationRecord,
  OperationReservation,
  OperationState,
  ReceiptAvailability,
  ReservationResult,
  RetrievalEvent,
  RetrievalEventInput
} from '../../src/storage/journal.js';

export type FaultPoint = 'reserve' | 'save_plan' | 'mark' | 'refresh_receipt';

export interface FaultOptions {
  state?: OperationState;
  error?: unknown;
  times?: number;
}

interface ArmedFault {
  point: FaultPoint;
  state?: OperationState;
  error: unknown;
  remaining: number;
}

export class FaultScheduler {
  private readonly faults: ArmedFault[] = [];

  arm(point: FaultPoint, options: FaultOptions = {}): void {
    this.faults.push({
      point,
      ...(options.state === undefined ? {} : { state: options.state }),
      error: options.error ?? new Error(`injected fault at ${point}`),
      remaining: options.times ?? 1
    });
  }

  take(point: FaultPoint, state?: OperationState): unknown | undefined {
    for (const fault of this.faults) {
      if (fault.point !== point) continue;
      if (fault.state !== undefined && fault.state !== state) continue;
      fault.remaining -= 1;
      const { error } = fault;
      if (fault.remaining <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return error;
    }
    return undefined;
  }
}

export function wrapJournal(journal: Journal, scheduler: FaultScheduler): Journal {
  const maybeThrow = (point: FaultPoint, state?: OperationState): void => {
    const error = scheduler.take(point, state);
    if (error !== undefined) throw error;
  };
  const wrapper = {
    reserve(input: OperationReservation): ReservationResult {
      maybeThrow('reserve');
      return journal.reserve(input);
    },
    savePlan(id: string, plan: PlannedWrite): void {
      maybeThrow('save_plan');
      journal.savePlan(id, plan);
    },
    mark(id: string, state: OperationState, receipt?: MutationReceipt): void {
      maybeThrow('mark', state);
      journal.mark(id, state, receipt);
    },
    get(id: string): OperationRecord | undefined {
      return journal.get(id);
    },
    pending(): OperationRecord[] {
      return journal.pending();
    },
    abort(id: string): void {
      journal.abort(id);
    },
    refreshReceiptAvailability(id: string, availability: ReceiptAvailability): OperationRecord {
      maybeThrow('refresh_receipt');
      return journal.refreshReceiptAvailability(id, availability);
    },
    pruneTerminalPayloads(now: Date): number {
      return journal.pruneTerminalPayloads(now);
    },
    recordRetrieval(input: RetrievalEventInput): RetrievalEvent {
      return journal.recordRetrieval(input);
    },
    getRetrieval(retrieval_id: string): RetrievalEvent | undefined {
      return journal.getRetrieval(retrieval_id);
    },
    pruneRetrievalEvents(now: Date): number {
      return journal.pruneRetrievalEvents(now);
    },
    recordFeedback(input: FeedbackWrite): FeedbackWriteResult {
      return journal.recordFeedback(input);
    },
    getFeedback(feedback_id: string): FeedbackEntry | undefined {
      return journal.getFeedback(feedback_id);
    },
    listFeedback(scope?: string): FeedbackEntry[] {
      return journal.listFeedback(scope);
    },
    purgeFeedback(scope: string): number {
      return journal.purgeFeedback(scope);
    },
    appendAudit(event: AuditEvent): AuditEventRecord {
      return journal.appendAudit(event);
    },
    listAudit(): AuditEventRecord[] {
      return journal.listAudit();
    },
    pruneAuditEvents(now: Date): number {
      return journal.pruneAuditEvents(now);
    },
    close(): void {
      journal.close();
    }
  };
  return wrapper as unknown as Journal;
}
