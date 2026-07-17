import { conflict, ErrorCodes } from '@lemonize/shared';

const INTERNAL_ORIGIN = 'https://device-approval.internal';

interface ApprovalTokenRepository {
  tokens: { delete(rowId: string): Promise<unknown> };
  revokeToken(rowId: string): Promise<unknown>;
}

/** Deliver a one-time device token without leaving an unreachable active row. */
export async function storeDeviceApproval(input: {
  approvals: DurableObjectNamespace;
  repo: ApprovalTokenRepository;
  userCode: string;
  state: unknown;
  tokenId: string;
}): Promise<void> {
  try {
    const response = await input.approvals
      .getByName(`v1:${input.userCode}`)
      .fetch(`${INTERNAL_ORIGIN}/approval`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: input.state,
          tokenId: input.tokenId,
          userCode: input.userCode,
        }),
      });
    if (response.status === 409) {
      throw conflict(ErrorCodes.CONFLICT, 'Device code has already been approved.');
    }
    if (!response.ok) {
      throw new Error(`Device approval storage failed with HTTP ${response.status}.`);
    }
  } catch (deliveryError) {
    try {
      await input.repo.tokens.delete(input.tokenId);
    } catch {
      await input.repo.revokeToken(input.tokenId).catch(() => undefined);
    }
    throw deliveryError;
  }
}

/** Atomically consume an approved device login, returning it at most once. */
export async function consumeDeviceApproval<T>(
  approvals: DurableObjectNamespace,
  userCode: string,
): Promise<T | null> {
  const response = await approvals
    .getByName(`v1:${userCode}`)
    .fetch(`${INTERNAL_ORIGIN}/approval/consume`, {
      method: 'POST',
    });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Device approval consumption failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { state?: T; status?: string };
  if (body.status !== 'approved' || body.state === undefined) {
    throw new Error('Device approval storage returned an invalid response.');
  }
  return body.state;
}
