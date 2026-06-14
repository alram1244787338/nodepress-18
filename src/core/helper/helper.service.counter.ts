/**
 * @file Global counter service
 * @module core/helper/counter.service
 * @author Surmon <https://github.com/surmon-china>
 */

import { Injectable } from '@nestjs/common'
import { CacheService } from '@app/core/cache/cache.service'
import { createLogger } from '@app/utils/logger'
import { isDevEnv } from '@app/app.environment'

const logger = createLogger({ scope: 'CounterService', time: isDevEnv })

@Injectable()
export class CounterService {
  constructor(private readonly cacheService: CacheService) {}

  public getGlobalCount = async (key: string) => {
    const count = await this.cacheService.get<number>(key)
    return count ? Number(count) : 0
  }

  // Atomic increment — safe under concurrent access (uses Redis INCR).
  public incrementGlobalCount = async (key: string) => {
    return this.cacheService.increment(key)
  }

  // Atomic decrement — used for rollback when a downstream operation fails.
  public decrementGlobalCount = async (key: string) => {
    return this.cacheService.decrement(key)
  }

  public resetGlobalCount = (key: string) => {
    return this.cacheService.set(key, 0)
  }
}
