/**
 * @file Vote controller
 * @module module/vote/controller
 * @author Surmon <https://github.com/surmon-china>
 */

import _isUndefined from 'lodash/isUndefined'
import type { QueryFilter } from 'mongoose'
import { Controller, Get, Post, Delete, Body, Query, BadRequestException } from '@nestjs/common'
import { Throttle, minutes, seconds } from '@nestjs/throttler'
import { OnlyIdentity, IdentityRole } from '@app/decorators/only-identity.decorator'
import { PaginateOptions, PaginateResult } from '@app/utils/paginate'
import { RequestContext, IRequestContext } from '@app/decorators/request-context.decorator'
import { SuccessResponse } from '@app/decorators/success-response.decorator'
import { resolveGeneralAuthor } from '@app/constants/author.constant'
import { ArticleSyncService } from '@app/modules/article/article.service.sync'
import { ArticleService } from '@app/modules/article/article.service'
import { CommentService } from '@app/modules/comment/comment.service'
import { UserService } from '@app/modules/user/user.service'
import { IPService } from '@app/core/helper/helper.service.ip'
import { CommentVoteDto, ArticleVoteDto, VotePaginateQueryDto, VoteIdsDto } from './vote.dto'
import { VoteTargetType, VoteType } from './vote.constant'
import { Vote, VoteWithUser } from './vote.model'
import { VoteService } from './vote.service'
import { createLogger } from '@app/utils/logger'
import { isDevEnv } from '@app/app.environment'

const logger = createLogger({ scope: 'VoteController', time: isDevEnv })

@Controller('votes')
export class VoteController {
  constructor(
    private readonly ipService: IPService,
    private readonly voteService: VoteService,
    private readonly userService: UserService,
    private readonly commentService: CommentService,
    private readonly articleService: ArticleService,
    private readonly articleSyncService: ArticleSyncService
  ) {}

  @Post('/article')
  @Throttle({ default: { ttl: minutes(1), limit: 10 } })
  @SuccessResponse('Vote article succeeded')
  async votePost(
    @Body() dto: ArticleVoteDto,
    @RequestContext() { visitor, identity }: IRequestContext
  ): Promise<number> {
    // 1. Validate that the target article exists and is publicly accessible
    try {
      await this.articleService.getDetail(dto.article_id, { lean: true, publicOnly: true })
    } catch {
      throw new BadRequestException(`Cannot vote on article ${dto.article_id}: article not found or not public.`)
    }

    // 2. Resolve author info
    const [user, ipLocation] = await Promise.all([
      identity.isUser ? this.userService.findOne(identity.payload!.uid!) : null,
      visitor.ip ? this.ipService.queryLocation(visitor.ip) : null
    ])

    // 3. Create vote record first — this includes duplicate detection.
    //    If the vote is a duplicate, this throws before the counter is touched.
    const voteRecord = await this.voteService.create({
      target_type: VoteTargetType.Article,
      target_id: dto.article_id,
      vote_type: dto.vote,
      ...resolveGeneralAuthor(dto, user),
      user_agent: visitor.agent,
      ip: visitor.ip,
      ip_location: ipLocation
    })

    // 4. Increment article counter — if this fails, roll back the vote record
    try {
      return await this.articleSyncService.incrementStatistics(dto.article_id, 'likes')
    } catch (error) {
      logger.warn('Article counter increment failed after vote creation, rolling back vote record.', error)
      await this.voteService.delete(voteRecord.id).catch(() => void 0)
      throw error
    }
  }

  @Post('/comment')
  @Throttle({ default: { ttl: seconds(30), limit: 10 } })
  @SuccessResponse('Vote comment succeeded')
  async voteComment(
    @Body() dto: CommentVoteDto,
    @RequestContext() { visitor, identity }: IRequestContext
  ): Promise<number> {
    const field = dto.vote === VoteType.Upvote ? 'likes' : 'dislikes'

    // 1. Validate that the target comment exists
    try {
      await this.commentService.getDetail(dto.comment_id)
    } catch {
      throw new BadRequestException(`Cannot vote on comment ${dto.comment_id}: comment not found.`)
    }

    // 2. Resolve author info
    const [user, ipLocation] = await Promise.all([
      identity.isUser ? this.userService.findOne(identity.payload!.uid!) : null,
      visitor.ip ? this.ipService.queryLocation(visitor.ip) : null
    ])

    // 3. Create vote record first — duplicate detection happens here
    const voteRecord = await this.voteService.create({
      target_type: VoteTargetType.Comment,
      target_id: dto.comment_id,
      vote_type: dto.vote,
      ...resolveGeneralAuthor(dto, user),
      user_agent: visitor.agent,
      ip: visitor.ip,
      ip_location: ipLocation
    })

    // 4. Increment comment counter — if this fails, roll back the vote record
    try {
      return await this.commentService.incrementVote(dto.comment_id, field)
    } catch (error) {
      logger.warn('Comment counter increment failed after vote creation, rolling back vote record.', error)
      await this.voteService.delete(voteRecord.id).catch(() => void 0)
      throw error
    }
  }

  @Get()
  @OnlyIdentity(IdentityRole.Admin)
  @SuccessResponse({ message: 'Get votes succeeded', usePaginate: true })
  getVotes(@Query() query: VotePaginateQueryDto): Promise<PaginateResult<VoteWithUser>> {
    const { sort, page, per_page, ...filters } = query
    const queryFilter: QueryFilter<Vote> = {}
    const paginateOptions: PaginateOptions = { page, perPage: per_page, dateSort: sort }

    // target type
    if (!_isUndefined(filters.target_type)) {
      queryFilter.target_type = filters.target_type
    }
    // target ID
    if (!_isUndefined(filters.target_id)) {
      queryFilter.target_id = filters.target_id
    }
    // vote type
    if (!_isUndefined(filters.vote_type)) {
      queryFilter.vote_type = filters.vote_type
    }
    // author type
    if (!_isUndefined(filters.author_type)) {
      queryFilter.author_type = filters.author_type
    }

    return this.voteService.paginate<VoteWithUser>(queryFilter, {
      ...paginateOptions,
      populate: 'user'
    })
  }

  @Delete()
  @OnlyIdentity(IdentityRole.Admin)
  @SuccessResponse('Delete votes succeeded')
  async deleteVotes(@Body() { vote_ids }: VoteIdsDto) {
    // Fetch votes before deletion so we can recalculate target counters
    const votes = await this.voteService.findByIds(vote_ids)
    const result = await this.voteService.batchDelete(vote_ids)

    // Recalculate affected article like counts
    const articleIds = [...new Set(votes.filter((v) => v.target_type === VoteTargetType.Article).map((v) => v.target_id))]
    for (const articleId of articleIds) {
      try {
        const upvoteCount = await this.voteService.countDocuments({
          target_type: VoteTargetType.Article,
          target_id: articleId,
          vote_type: VoteType.Upvote
        })
        await this.articleSyncService.updateStatsField(articleId, 'likes', upvoteCount)
      } catch (error) {
        logger.warn(`Failed to recalculate article ${articleId} likes after vote deletion.`, error)
      }
    }

    // Recalculate affected comment like/dislike counts
    const commentIds = [...new Set(votes.filter((v) => v.target_type === VoteTargetType.Comment).map((v) => v.target_id))]
    for (const commentId of commentIds) {
      try {
        const [upvotes, downvotes] = await Promise.all([
          this.voteService.countDocuments({ target_type: VoteTargetType.Comment, target_id: commentId, vote_type: VoteType.Upvote }),
          this.voteService.countDocuments({ target_type: VoteTargetType.Comment, target_id: commentId, vote_type: VoteType.Downvote })
        ])
        await this.commentService.recalculateVotes(commentId, upvotes, downvotes)
      } catch (error) {
        logger.warn(`Failed to recalculate comment ${commentId} votes after deletion.`, error)
      }
    }

    return result
  }
}
