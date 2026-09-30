import { setupTestDatabase } from '@test-helpers/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'

const runtime = vi.hoisted(() => ({
  assertSessionWritable: vi.fn(),
  assertOrphanedStorageCapacity: vi.fn(),
  isSessionBusy: vi.fn(),
  beginTurn: vi.fn(),
  enqueueUserMessage: vi.fn()
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({ AgentSessionRuntimeService: runtime } as Parameters<typeof mockApplicationFactory>[0])
})

const { AgentChatContextProvider } = await import('../AgentChatContextProvider')

describe('Agent dispatch storage backpressure', () => {
  const dbh = setupTestDatabase()
  const provider = new AgentChatContextProvider()
  const subscriber = {
    id: 'test',
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onPaused: vi.fn(),
    isAlive: () => true
  }
  const request = { topicId: 'agent-session:session', trigger: 'submit-message' as const, userMessageParts: [] }

  beforeEach(async () => {
    vi.resetAllMocks()
    runtime.beginTurn.mockImplementation(() => runtime.assertOrphanedStorageCapacity())
    runtime.enqueueUserMessage.mockImplementation(() => runtime.assertOrphanedStorageCapacity())
    await dbh.db.insert(userProviderTable).values({ providerId: 'test', name: 'Test', orderKey: 'a0' })
    await dbh.db.insert(userModelTable).values({
      id: 'test::model',
      providerId: 'test',
      modelId: 'model',
      presetModelId: 'model',
      name: 'Model',
      orderKey: 'a0'
    })
    await dbh.db
      .insert(agentTable)
      .values({ id: 'agent', type: 'claude-code', name: 'Agent', instructions: '', orderKey: 'a0' })
    await dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: 'workspace', name: 'Workspace', path: '/tmp/backpressure', type: 'user', orderKey: 'a0' })
    await dbh.db
      .insert(agentSessionTable)
      .values({ id: 'session', agentId: 'agent', workspaceId: 'workspace', name: 'Session', orderKey: 'a0' })
    vi.spyOn(provider, 'validateDispatch').mockResolvedValue({
      sessionId: 'session',
      topicId: request.topicId,
      agentId: 'agent',
      agentType: 'claude-code',
      agentName: 'Agent',
      agentUpdatedAt: '2026-01-01T00:00:00.000Z',
      uniqueModelId: 'test::model',
      reasoningEffort: 'default',
      serviceTier: 'standard',
      headless: false,
      userMessageId: '018f6ed6-73b8-7f40-8d0d-9bb2f8f1d100',
      userMessageParts: [{ type: 'text', text: 'Keep my request' }],
      shouldAutoNameInitialTurn: false,
      messageSnapshot: {
        id: 'agent',
        name: 'Agent',
        emoji: '🤖',
        model: { id: 'model', name: 'Model', provider: 'test' }
      }
    })
  })

  it.each([false, true])('does not persist rejected input or a pending reply (busy: %s)', async (busy) => {
    runtime.isSessionBusy.mockReturnValue(busy)
    runtime.assertOrphanedStorageCapacity.mockImplementation(() => {
      throw new Error('storage backlog')
    })
    await expect(provider.prepareDispatch(subscriber, request)).rejects.toThrow('storage backlog')
    expect(dbh.db.select().from(agentSessionMessageTable).all()).toEqual([])
  })

  it('marks a persisted reply failed when capacity changes before activation', async () => {
    runtime.beginTurn.mockImplementation(() => {
      throw new Error('storage backlog')
    })
    await expect(provider.prepareDispatch(subscriber, request)).rejects.toThrow('storage backlog')
    const rows = dbh.db.select().from(agentSessionMessageTable).all()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.role === 'assistant')?.status).toBe('error')
    expect(rows.find((row) => row.role === 'user')?.data.parts).toEqual([{ type: 'text', text: 'Keep my request' }])
  })

  it('rechecks capacity inside the transaction before saving either message', async () => {
    runtime.assertOrphanedStorageCapacity
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('storage backlog')
      })
    await expect(provider.prepareDispatch(subscriber, request)).rejects.toThrow('storage backlog')
    expect(dbh.db.select().from(agentSessionMessageTable).all()).toEqual([])
  })
})
