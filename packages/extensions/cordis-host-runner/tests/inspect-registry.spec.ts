import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'
import { AGENT_A, setup } from './helpers.ts'

/**
 * The Host inspect registry is process-global while the plugin that fills it
 * is a row in an agent preset, so it holds one registrant per mounted Session.
 * These cases mount the same provider from sibling fibers, the way two
 * Sessions on one preset do, and follow what each unload leaves behind.
 */

/** A provider whose one method reports which registrant answered. */
function provider(answer: string): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id: 'Service',
      description: 'Progressive Host Service discovery.',
      methods: [{
        name: 'listService',
        description: 'Return the Service directory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { description: 'Service directory.' },
      }],
    },
    query: (_method, _input, _context) => Promise.resolve({ answered: answer } as unknown as JsonValue),
  }
}

/** Mount one registrant on its own fiber, as a preset row does. */
function session(ctx: Context, answer: string): { dispose: () => Promise<void> } {
  const fiber = ctx.plugin({
    name: `session-${answer}`,
    inject: ['cordisInspect'],
    apply(inner: Context) {
      inner.effect(() => inner.cordisInspect.register(provider(answer)), 'spec: inspect provider')
    },
  })
  return { dispose: async () => { await fiber.dispose() } }
}

async function answered(ctx: Context): Promise<unknown> {
  const result = await ctx.cordisInspect.query(
    'host', 'Service', 'listService', undefined, AGENT_A, AbortSignal.timeout(1000),
  )
  return (result as { answered: unknown }).answered
}

describe('Host inspect provider registry', () => {
  it('lets two Sessions hold one provider id and keeps it until the last unloads', async () => {
    const { ctx } = await setup()
    const first = session(ctx, 'first')
    await ctx.fiber.await()

    // The second Session mounting the same preset is the case that used to
    // fail the whole mount, taking session resume down with it.
    const second = session(ctx, 'second')
    await ctx.fiber.await()
    expect(ctx.cordisInspect.list().filter(row => row.id === 'Service')).toHaveLength(1)

    // The newest registrant answers: a registration can capture the Session
    // context it was mounted under, so the oldest is the wrong one to keep.
    expect(await answered(ctx)).toBe('second')

    // Unloading one Session leaves the id serving the other, in both directions.
    await second.dispose()
    expect(await answered(ctx)).toBe('first')
    const third = session(ctx, 'third')
    await ctx.fiber.await()
    expect(await answered(ctx)).toBe('third')
    await first.dispose()
    expect(await answered(ctx)).toBe('third')

    await third.dispose()
    expect(ctx.cordisInspect.list().filter(row => row.id === 'Service')).toEqual([])
    await expect(answered(ctx)).rejects.toThrow('is not registered')
  })

  it('still refuses a second provider declaring the id differently', async () => {
    const { ctx } = await setup()
    const held = session(ctx, 'first')
    await ctx.fiber.await()

    const conflicting = provider('other')
    expect(() => ctx.cordisInspect.register({
      ...conflicting,
      manifest: { ...conflicting.manifest, description: 'Something else entirely.' },
    })).toThrow('already registered with a different manifest')

    // The refusal leaves the live registrant untouched.
    expect(await answered(ctx)).toBe('first')
    await held.dispose()
  })

  it('shares one id across manifests that differ only in key order', async () => {
    const { ctx } = await setup()
    const base = provider('first')
    const dispose = ctx.cordisInspect.register(base)

    // The same declaration, written with every object key in another order:
    // two Sessions build their manifests independently, so equality by
    // serialization has to be order-insensitive.
    expect(() => ctx.cordisInspect.register({
      ...base,
      manifest: {
        description: 'Progressive Host Service discovery.',
        id: 'Service',
        methods: [{
          outputSchema: { description: 'Service directory.' },
          inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
          description: 'Return the Service directory.',
          name: 'listService',
        }],
      },
    })).not.toThrow()

    dispose()
    expect(ctx.cordisInspect.list().filter(row => row.id === 'Service')).toHaveLength(1)
  })
})
