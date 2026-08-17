# Agent Note: Seat collisions name their holder

Status: implemented

English | [中文](2026-08-16-seat-collisions-name-their-holder.zh.md)

## Problem

A dynamic Cordis package registered a webserver route and dropped the disposer. Its fiber unwound; the route did not. Every later activation — a new Package of the same Plugin, and a second Plugin in another Session — died at start with `webserver: duplicate prefix route "/waitv/stream"`, and nothing in that message distinguished the three states it can report: another live plugin owns the path, another Session's plugin owns it, or a dead plugin's registration outlived it and no teardown will ever release it. The Agent spent six activations moving the route to fresh paths, leaking one more seat each time a Package failed after its `register` call but before its `apply` returned.

The host runner had a recipe for exactly this and could not deliver it. `startHostHalf` matched the substring `already registered`, which the tool registry and the fallback seat emit but the route tables do not, so the whole family of route collisions arrived as a bare conflict. The recipe it would have printed named `cordis_runtime_inspect what:"temporary"`, a tool that no longer exists, and taught only the stop-then-rerun sequence — the one action that cannot fix a leaked seat.

## Decision

Every `WebServer` seat records the fiber that claimed it. `register`, `registerUpgrade`, and `registerFallback` funnel through one private `claim(seat, collision)`, which rejects a taken seat with the holder's fiber name and, when that fiber is already disposed, says the registrant dropped this disposer and the seat stays claimed until the process restarts. Disposal is read as `holder.uid === null`, which is how cordis itself derives `FiberState.DISPOSED`, so the package needs no runtime mirror of a const enum. Each seat's claim is released by the same disposer that removes the registration, so the holder table has exactly the seats the route tables and the fallback slot do.

The seat is not reclaimable. A leaked registration keeps serving its dead plugin's handler, and this change reports that rather than repairing it: the registration is the caller's to own, and a registry that evicted holders it judged dead would guess about a fiber it does not manage.

`startHostHalf` matches the collision family instead of one registry's wording — `already registered`, `has been registered at`, and `duplicate ` — deliberately wide, because appending a recipe to an unrelated failure costs one sentence while missing a real collision leaves the Agent unable to tell a taken name from broken code. The recipe now names all three causes with their different actions, cites `cordis_inspect_self` and notes that it is Session-scoped, and teaches `ctx.effect` retention.

## Alternatives considered

- **Auto-registering returned disposers as effects inside the sandbox guard.** `guardedService` already wraps every injected service's return value, so it could hand any returned function to `ctx.effect` and make a bare `ctx.webServer.register(...)` safe for model-written packages. Refused: the guard cannot tell a disposer from any other returned function, and a package that also calls its disposer would have it called twice. It also hides the one lifecycle rule a package author must learn, on a surface whose failures are otherwise loud.
- **`WebServer.register` calling `ctx.effect` on the caller's fiber itself.** The caller's context is reachable through cordis's service tracker — this is how the holder name is captured — so the service could bind every route to the registering fiber and end this class of leak at the source. Deferred rather than rejected: it inverts the repo-wide convention that a registry returns a disposer and the caller owns the effect, so it belongs to every registry at once or to none, and a registration made from a long-lived context would silently never be released. The holder report is what this change buys until that decision is made.
- **Rejecting a duplicate path when the Package is defined.** Define time holds only source text, so the check would be a lexical guess at model-written JavaScript: it cannot see a computed path, and a false positive refuses a valid definition. Activation is the earliest point the real path is known.
- **Naming the holder without its liveness.** The name alone still cannot separate "stop the other run" from "this path is gone for the life of the process", which is the decision the Agent was repeatedly getting wrong.

## Consequences

Both collision messages grew a parenthetical clause; their existing prefixes are unchanged, so callers matching `duplicate exact route` or `fallback already registered` still match. The disposed-holder branch depends on cordis's `uid` field remaining the disposed signal, which the vendoring procedure re-checks.

The wide collision match means an unrelated startup failure containing the word `duplicate` also carries the recipe. That is the accepted cost of not enumerating registry phrasings the runner does not own.

## Testing

The webserver's real-Loader composition test claims a seat from a named child fiber and asserts the collision names it, disposes that fiber and re-registers to prove the effect-bound path releases, then mounts a plugin that drops its disposer, disposes it, and shows the dead plugin's handler still answering before the reclaim attempt reports the leak. The runner's suite pins the recipe for the two registry wordings a live composition cannot produce, while the existing tool-name collision keeps covering the live-holder case through a real composition; an unrelated host-half failure is asserted to pass through without the recipe.

## Related

The same investigation found `cordis_runtime_inspect` and `cordis_package_inspect` in the Web client's tool-row variant and title maps, where they had outlived the tools. All three current inspect tools rendered as untitled generic rows; the maps and their tests now name `cordis_inspect_list`, `cordis_inspect_query`, and `cordis_inspect_self`.
