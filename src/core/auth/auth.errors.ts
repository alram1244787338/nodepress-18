/**
 * @file Auth error types
 * @module core/auth/errors
 */

import { UnauthorizedException } from '@nestjs/common'

export enum TokenVerificationError {
  /** Token was found in the blacklist (logout or post-refresh invalidation) */
  Revoked = 'token_revoked',
  /** Token signature is valid but the `exp` claim has passed */
  Expired = 'token_expired',
  /** Token is malformed, signature invalid, or issuer/audience mismatch */
  Malformed = 'token_malformed'
}

export class TokenVerificationException extends UnauthorizedException {
  constructor(
    public readonly code: TokenVerificationError,
    message: string
  ) {
    super(message)
  }
}
