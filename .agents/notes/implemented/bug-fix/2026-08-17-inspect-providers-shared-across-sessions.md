# Agent Note: One inspect provider id, one registrant per Session

Status: implemented

English | [中文](2026-08-17-inspect-providers-shared-across-sessions.zh.md)

## Problem

Resuming a Session on the `cordis` preset failed the whole mount:

```
agent-presets: preset "cordis" failed to mount: failed to apply loader entry tool-cordis
(@deepseek-ai/dsh-tool-cordis): Host Cordis inspect provider "Service" is already registered
```

`tool-cordis` is a preset row, so it mounts once per Session, and its `apply` registers four Host inspect providers. The registry behind `ctx.cordisInspect` admitted one registrant per id and threw on the second, so a Session could only mount the preset when no other Session already had it. The second Session — a resume alongside a live one, or simply two agents on the same preset — lost its whole composition to a registry it never meant to contend for.

The other registries this row writes into layer per agent: `ctx.tools.register` and `systemPrompt.section` file into the mounting agent's scope, and two Sessions coexist because their registrations never meet. The preset mounter guards the adjacent hazard — it rejects a row that publishes a service into the root realm, "because such a service is process-global rather than per-session and the second session mounting the same preset collides with the first" — but a row that writes into an *existing* process-global registry publishes nothing, so nothing caught this.

## Decision

A provider id holds a list of live registrants rather than one. Registrants declaring the same id share it when their manifests match by value, each disposer removes only its own, and the id survives until the last one unloads — the counted-registrant arrangement `sessionProjections` already uses for the same reason.

Two details carry the fix:

- **The newest registrant answers `list` and `query`, not the first.** A registration may capture the context it was mounted under — the `Tool` provider closes over its `ctx` to reach `ctx.tools` — so pinning the first would leave an unloaded Session's context serving live ones. Registrants are stored newest-first, and the type is a non-empty tuple because an emptied id is deleted.
- **Manifest identity is by value, not by reference.** Every Session builds its own manifest objects from the same source, so equality is a canonical serialization with object keys sorted: two call sites writing the same declaration in different key orders describe the same provider. A manifest that differs from the live one is two providers claiming one name, and still throws.

Session scoping in the registry was not attempted. Its Client half routes page-global queries and its Host providers answer from generated catalogs, so the id is genuinely one directory entry; what varies per Session is only which live registrant serves it.

## Alternatives considered

- **Making the inspect registry per-agent, like `tools` and `systemPrompt`.** It removes the contention rather than counting it, and the `Tool` provider's answers are already agent-scoped through the `agent` its query receives. Refused for now: the same registry mirrors a page-global Client manifest and routes Client queries by request id, so per-agent scoping would split one directory into two lifetimes for a problem that only the Host half has.
- **Skipping registration when the id is already present.** Two lines in `tool-cordis`, and wrong in the same way the first-registrant-wins arrangement is: the surviving registrant belongs to whichever Session mounted first, and it keeps answering after that Session unloads.
- **Rejecting a preset row that writes into a process-global registry, as the root-realm guard rejects a published service.** There is nothing to detect: a registration is an ordinary method call on an injected service, indistinguishable from any other use of it. The registry is the only place that knows an id is contended.

## Consequences

The duplicate-id rejection now reads `is already registered with a different manifest` and fires only on a genuine conflict, so a caller matching the old message on any duplicate no longer matches. Manifest equality costs one canonical serialization per registration, at mount time only.

Two providers with accidentally identical manifests and different query behavior would now share an id instead of colliding, with the newest answering. Nothing in the repository registers such a pair, and a provider id is a declared name rather than a discovered one.

## Testing

The registry suite mounts the same provider from sibling fibers, the way two preset mounts do, and follows what each unload leaves: both Sessions hold the id, the newest answers, unloading either leaves the other serving, and the id disappears with the last. A conflicting manifest still throws and leaves the live registrant untouched, and manifests differing only in key order share the id. Above that, a real composition mounts `tool-cordis` twice under separate Session scopes and asserts the second mount succeeds — the case that produced the report; it fails with the exact reported message when the registry change is reverted.
