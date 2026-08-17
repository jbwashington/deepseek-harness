import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import DynamicCordisRunner from '@deepseek-ai/dsh-cordis-host-runner'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import * as ToolCordis from '../src/index.ts'

/**
 * `tool-cordis` is a row in an agent preset, so it mounts once per Session
 * while the Host inspect registry it fills is process-global. These cases
 * mount the package twice under separate Session scopes, the way two Sessions
 * on one preset do. The scope is what keeps the tool and prompt-section
 * registrations apart — those registries layer per agent, and the inspect
 * registry, which does not, is the one this exercises.
 */

/** A Host composition carrying the registries this package contributes to. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(DynamicCordisRunner, { vmTimeoutMs: 1000 })
  return ctx
}

/** Mount the package under its own Session scope, as one preset row does. */
function mount(ctx: Context): { await: () => Promise<unknown>; dispose: () => Promise<void> } {
  const scope = createScope(ctx, {})
  const fiber = scope.ctx.plugin(ToolCordis)
  return {
    await: () => fiber.await(),
    dispose: async () => { await scope.dispose() },
  }
}

const hostProviders = (ctx: Context): string[] =>
  ctx.cordisInspect.list().filter(row => row.platform === 'host').map(row => row.id).sort()

describe('tool-cordis mounted by two agent presets', () => {
  it('mounts for a second Session and keeps its providers until the last unloads', async () => {
    const ctx = await harness()
    const first = mount(ctx)
    await first.await()
    const providers = hostProviders(ctx)
    expect(providers).toContain('Service')

    // Before this was allowed, the second mount threw and took the whole
    // preset — and with it a session resume — down with it.
    const second = mount(ctx)
    await expect(second.await()).resolves.toBeDefined()
    expect(hostProviders(ctx)).toEqual(providers)

    await second.dispose()
    expect(hostProviders(ctx)).toEqual(providers)

    await first.dispose()
    expect(hostProviders(ctx)).toEqual([])
  })
})
