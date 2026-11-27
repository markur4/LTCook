import { createHmac, randomBytes } from 'node:crypto';

export class ServiceInferenceError extends Error {
  constructor(
    readonly kind: 'configuration' | 'authentication' | 'transient',
    message: string,
    readonly revision?: string,
  ) {
    super(message);
  }
}

const revisionKey = randomBytes(32);

/** Revisions are only compared inside the runtime that observed them. */
export function inferenceRevision(...values: unknown[]): string {
  return createHmac('sha256', revisionKey).update(JSON.stringify(values)).digest('hex');
}

export function providerInferenceFailure(
  correction: { authentication: string; model: string },
  status: number | undefined,
  providerMessage: string | undefined,
  revision?: string,
): ServiceInferenceError {
  const message = providerMessage ?? '';
  if (status === 429 || /(?:rate.limit|usage.limit|quota|usage.not.included)/i.test(message))
    return new ServiceInferenceError('transient', 'The provider reached a quota or rate limit.');
  if (
    status === 401 ||
    status === 403 ||
    /(?:unauthori[sz]ed|invalid.api.key|not.authenticated|provider is not configured|check codex login status|current codex sign-in)/i.test(
      message,
    )
  )
    return new ServiceInferenceError('authentication', correction.authentication, revision);
  if (status === 404 || /(?:model.not.found|model.*does not exist)/i.test(message))
    return new ServiceInferenceError('configuration', correction.model, revision);
  return new ServiceInferenceError('transient', 'The provider did not complete the request.');
}
