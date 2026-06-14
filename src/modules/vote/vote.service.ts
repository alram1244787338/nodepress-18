/**
 * @file Vote service
 * @module module/vote/service
 * @author Surmon <https://github.com/surmon-china>
 */

import type { QueryFilter } from 'mongoose'
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { MongooseModel } from '@app/interfaces/mongoose.interface'
import { InjectModel } from '@app/transformers/model.transformer'
import { PaginateOptions, PaginateResult } from '@app/utils/paginate'
import { GlobalEventKey } from '@app/constants/events.constant'
import { User } from '@app/modules/user/user.model'
import { Vote, VoteDocWithUser, NormalizedVote } from './vote.model'
import { createLogger } from '@app/utils/logger'
import { isDevEnv } from '@app/app.environment'

const logger = createLogger({ scope: 'VoteService', time: isDevEnv })

@Injectable()
export class VoteService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Vote) private readonly voteModel: MongooseModel<Vote>
  ) {}

  public countDocuments(filter: QueryFilter<Vote>): Promise<number> {
    return this.voteModel.countDocuments(filter).lean().exec()
  }

  public paginate<T = Vote>(filter: QueryFilter<Vote>, options: PaginateOptions): Promise<PaginateResult<T>> {
    return this.voteModel.paginateRaw<T>(filter, { ...options, lean: { virtuals: true } })
  }

  public async create(vote: NormalizedVote): Promise<VoteDocWithUser> {
    // Duplicate guard: prevent the same user/IP from voting on the same target twice.
    // This protects against concurrent submissions and retry-induced double-counting.
    const duplicateFilter: QueryFilter<Vote> = {
      target_type: vote.target_type,
      target_id: vote.target_id
    }
    if (vote.user) {
      duplicateFilter.user = vote.user
    } else if (vote.ip) {
      duplicateFilter.ip = vote.ip
    }
    // Only check when we have a meaningful identifier
    if (vote.user || vote.ip) {
      const existing = await this.voteModel.findOne(duplicateFilter).lean().exec()
      if (existing) {
        throw new ConflictException('Duplicate vote: a vote from this user/IP already exists for this target.')
      }
    }

    const created = await this.voteModel.create(vote)
    const populated = await created.populate<{ user: User | null }>('user')
    this.eventEmitter.emit(GlobalEventKey.VoteCreated, populated.toObject())
    return populated
  }

  public async delete(voteId: number): Promise<Vote> {
    const deleted = await this.voteModel.findOneAndDelete({ id: voteId }).exec()
    if (!deleted) throw new NotFoundException(`Vote '${voteId}' not found`)
    return deleted
  }

  /** Fetch votes by their IDs — used before batch deletion to recalculate target counters. */
  public findByIds(voteIds: number[]): Promise<Vote[]> {
    if (!voteIds.length) return Promise.resolve([])
    return this.voteModel
      .find({ id: { $in: voteIds } })
      .lean()
      .exec()
  }

  public batchDelete(voteIds: number[]) {
    return this.voteModel.deleteMany({ id: { $in: voteIds } }).exec()
  }
}
