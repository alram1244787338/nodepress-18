/**
 * @file Auth refresh token service tests
 * @module core/auth/auth.service.refresh-token.spec
 */

import { Test, TestingModule } from '@nestjs/testing'
import { AuthRefreshTokenService } from './auth.service.refresh-token'
import { CacheService } from '@app/core/cache/cache.service'
import { AuthRole } from '@app/constants/auth.constant'

describe('AuthRefreshTokenService', () => {
  let service: AuthRefreshTokenService
  let cacheService: { get: jest.Mock; set: jest.Mock; delete: jest.Mock; getAndDelete: jest.Mock }

  beforeEach(async () => {
    cacheService = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      getAndDelete: jest.fn()
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthRefreshTokenService,
        { provide: CacheService, useValue: cacheService }
      ]
    }).compile()

    service = module.get(AuthRefreshTokenService)
  })

  describe('consumeToken', () => {
    it('should atomically get and delete a valid token payload', async () => {
      const payload = { role: AuthRole.User, uid: 42 }
      cacheService.getAndDelete.mockResolvedValue(payload)

      const result = await service.consumeToken('valid-token')

      expect(result).toEqual(payload)
      expect(cacheService.getAndDelete).toHaveBeenCalledTimes(1)
      // Verify it does NOT call get or delete separately
      expect(cacheService.get).not.toHaveBeenCalled()
      expect(cacheService.delete).not.toHaveBeenCalled()
    })

    it('should return null when token does not exist (already consumed)', async () => {
      cacheService.getAndDelete.mockResolvedValue(undefined)

      const result = await service.consumeToken('already-consumed')

      expect(result).toBeNull()
    })

    it('should prevent race condition: second consume returns null', async () => {
      const payload = { role: AuthRole.User, uid: 42 }
      // Simulate: first call succeeds, second returns undefined (already deleted by GETDEL)
      cacheService.getAndDelete
        .mockResolvedValueOnce(payload)
        .mockResolvedValueOnce(undefined)

      const first = await service.consumeToken('race-token')
      const second = await service.consumeToken('race-token')

      expect(first).toEqual(payload)
      expect(second).toBeNull()
    })
  })

  describe('generateToken', () => {
    it('should generate a 64-character hex string', () => {
      const token = service.generateToken()
      expect(token).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should generate unique tokens', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => service.generateToken()))
      expect(tokens.size).toBe(100)
    })
  })

  describe('storeToken', () => {
    it('should store payload with TTL via cache service', async () => {
      const payload = { role: AuthRole.User, uid: 1 }
      await service.storeToken('my-token', payload, 3600)

      expect(cacheService.set).toHaveBeenCalledTimes(1)
      const [key, value, ttl] = cacheService.set.mock.calls[0]
      expect(key).toContain('auth:refresh-token:my-token')
      expect(value).toEqual(payload)
      expect(ttl).toBe(3600)
    })
  })

  describe('revokeToken', () => {
    it('should delete the token from cache', async () => {
      cacheService.delete.mockResolvedValue(true)

      await service.revokeToken('my-token')

      expect(cacheService.delete).toHaveBeenCalledTimes(1)
      expect(cacheService.delete.mock.calls[0][0]).toContain('auth:refresh-token:my-token')
    })
  })
})
