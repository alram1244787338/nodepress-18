/**
 * @file Auth state service
 * @module module/account/auth/service.state
 * @author Surmon <https://github.com/surmon-china>
 */

import { randomUUID } from 'crypto'
import { Injectable, BadRequestException } from '@nestjs/common'
import { getUserAuthStateCacheKey } from '@app/constants/cache.constant'
import { CacheService } from '@app/core/cache/cache.service'

export enum AuthIntent {
  Login = 'login',
  Link = 'link'
}

export type AuthStatePayload =
  | { intent: AuthIntent.Login }
  | {
      intent: AuthIntent.Link
      uid: number
    }

@Injectable()
export class UserAuthStateService {
  constructor(private readonly cacheService: CacheService) {}

  /** Generate a unique state */
  public async generateCallbackState(payload: AuthStatePayload) {
    const state = randomUUID()
    const stateKey = getUserAuthStateCacheKey(state)
    // Store state in cache for 5 minutes to prevent CSRF
    await this.cacheService.set(stateKey, payload, 5 * 60)
    return state
  }

  /** Verify the callback state to ensure the request is legitimate */
  public async verifyCallbackState(state: string): Promise<AuthStatePayload> {
    if (!state) {
      throw new BadRequestException('Missing required authorization state parameter.')
    }

    const stateKey = getUserAuthStateCacheKey(state)
    // Atomic GETDEL: prevents concurrent OAuth callbacks from both succeeding with the same state.
    // The same error message is used for both expired and consumed states to avoid leaking
    // whether the state was already used or simply timed out.
    const statePayload = await this.cacheService.getAndDelete<AuthStatePayload>(stateKey)
    if (!statePayload) {
      throw new BadRequestException('Invalid or expired authorization state. Please try logging in again.')
    }

    return statePayload
  }
}
