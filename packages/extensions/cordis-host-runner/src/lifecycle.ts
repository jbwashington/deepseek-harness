/**
 * Host-half fiber lifecycle over the `cordis-dynamic` group: settle a
 * sandbox-produced plugin as a child fiber (never leaving a failed fiber
 * mounted), and report the services a settled-but-pending fiber still waits
 * for. Stopping needs no helper — a host half unwinds through an ordinary
 * awaited `fiber.dispose()`, which reverses every registration the plugin made
 * an effect on its fiber. A registration whose disposer the package dropped is
 * not one of them and survives the fiber, so a startup name collision names
 * that cause alongside the live-holder ones ({@link nameCollisionRecipe}).
 * @module @deepseek-ai/dsh-cordis-host-runner/lifecycle
 */

import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { guardedPlugin } from './guard.ts'

/**
 * Startup failures that mean "this process-global name already has a holder".
 * Each registry words its own rejection, so the recipe matches the family
 * rather than one phrasing: cordis services reject with `has been registered
 * at <fiber>`, the tool registry and the webserver fallback seat with `already
 * registered`, and the webserver route tables and client-module tables with
 * `duplicate <what>`. The match is deliberately wide — appending the recipe to
 * an unrelated failure costs one sentence, while missing a real collision
 * leaves the Agent with no way to tell a taken name from broken code.
 */
const NAME_COLLISION = /already registered|has been registered at|duplicate /

/**
 * Append the recovery recipe to a name-collision startup failure.
 *
 * Three causes reach the same message and need different actions, so the
 * recipe names all three: a live run of this Plugin still holds the name, a
 * run in another Session holds it (invisible to `cordis_inspect_self`, which is
 * Session-scoped), or a Package registered the name without `ctx.effect` and
 * leaked it when its fiber unwound. The third is unreclaimable short of a
 * process restart, so the recipe teaches disposer retention rather than only a
 * stop-then-rerun sequence.
 * @param message - the failure the host half's fiber rejected with.
 * @returns the message plus the recipe, or undefined when it is not a collision.
 */
function nameCollisionRecipe(message: string): string | undefined {
  if (!NAME_COLLISION.test(message)) return undefined
  return `${message} — one holder per process owns that name, and something already holds it. `
    + 'If a run of this Plugin holds it, cordis_stop that run and retry; cordis_inspect_self lists this Session\'s runs. '
    + 'Otherwise the holder is a run in another Session, or a Package that registered the name without ctx.effect and '
    + 'leaked it when its fiber unwound — no stop reclaims a leaked name, so register a different one. '
    + 'Wrap every registration as ctx.effect(() => service.register(...)) so stop, update, and undefine free it.'
}

/**
 * Await the group, start and settle one guarded child, and dispose it before rethrowing any
 * startup failure so a failed run never lingers. A valid unresolved inject may remain pending.
 * @param group - the `cordis-dynamic` group fiber every host half hangs under.
 * @param plugin - the plugin the sandbox returned; wrapped with the registration guard before starting.
 * @param reportGuardFailure - reports post-activation Host guard rejections to the owning Agent.
 * @returns the settled child fiber (possibly pending on unsatisfied `inject`).
 */
export async function startHostHalf(
  group: Fiber,
  plugin: Plugin,
  reportGuardFailure: (error: Error) => void,
): Promise<Fiber> {
  await group.await()
  const fiber = group.ctx.plugin(guardedPlugin(plugin, reportGuardFailure))
  try {
    await fiber.await()
  } catch (error) {
    await fiber.dispose()
    const message = error instanceof Error ? error.message : String(error)
    const collision = nameCollisionRecipe(message)
    if (collision !== undefined) throw new Error(collision)
    throw error instanceof Error ? error : new Error(message)
  }
  return fiber
}

/**
 * The services a fiber declared in `inject` that do not exist yet — a settled
 * fiber that is not active is waiting on exactly these (legal cordis
 * semantics: it activates when the service appears).
 * @param ctx - the context to resolve service existence against.
 * @param fiber - the host-half fiber whose `inject` declarations are checked.
 * @returns the missing service names, in declaration order.
 */
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
