import { captureLocal } from './capture.js';
import { reviewLocal } from './review.js';
import { feedbackLocal } from './feedback.js';
import { projectEnsureLocal } from './project-ensure.js';
import { readLocal } from './read.js';
import { recallLocal } from './recall.js';
import { statusLocal } from './status.js';
import { buildLocalHandlerDeps, type LocalBrain } from './local-support.js';
import type {
  AuthenticatedContext,
  CaptureRequest,
  FeedbackRequest,
  FeedbackResult,
  MutationReceipt,
  ProjectEnsureRequest,
  ProjectEnsureResult,
  ReadRequest,
  ReadResult,
  RecallRequest,
  RecallResult,
  ReviewListResult,
  ReviewRequest,
  StatusRequest,
  StatusResult
} from '../core/types.js';

export type { LocalBrain } from './local-support.js';

export async function localCapture(
  ctx: AuthenticatedContext,
  input: CaptureRequest,
  brain: LocalBrain
): Promise<MutationReceipt> {
  return captureLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localReview(
  ctx: AuthenticatedContext,
  input: ReviewRequest,
  brain: LocalBrain
): Promise<MutationReceipt | ReviewListResult> {
  return reviewLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localFeedback(
  ctx: AuthenticatedContext,
  input: FeedbackRequest,
  brain: LocalBrain
): Promise<FeedbackResult> {
  return feedbackLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localProjectEnsure(
  ctx: AuthenticatedContext,
  input: ProjectEnsureRequest,
  brain: LocalBrain
): Promise<ProjectEnsureResult> {
  return projectEnsureLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localRead(
  ctx: AuthenticatedContext,
  input: ReadRequest,
  brain: LocalBrain
): Promise<ReadResult> {
  return readLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localRecall(
  ctx: AuthenticatedContext,
  input: RecallRequest,
  brain: LocalBrain
): Promise<RecallResult> {
  return recallLocal(ctx, input, await buildLocalHandlerDeps(brain));
}

export async function localStatus(
  ctx: AuthenticatedContext,
  input: StatusRequest,
  brain: LocalBrain
): Promise<StatusResult> {
  return statusLocal(ctx, input, await buildLocalHandlerDeps(brain));
}
