# Agent Note：一个 inspect provider id，每个会话一个注册方

Status: implemented

[English](2026-08-17-inspect-providers-shared-across-sessions.md) | 中文

## 问题

在 `cordis` preset 上恢复一个会话，会让整次挂载失败：

```
agent-presets: preset "cordis" failed to mount: failed to apply loader entry tool-cordis
(@deepseek-ai/dsh-tool-cordis): Host Cordis inspect provider "Service" is already registered
```

`tool-cordis` 是 preset 中的一行，因此每个会话挂载一次，而它的 `apply` 会注册四个 Host inspect provider。`ctx.cordisInspect` 背后的注册表每个 id 只接纳一个注册方，第二个直接抛错；于是只有在没有其他会话持有该 preset 时，一个会话才挂得上去。第二个会话——与存活会话并行的一次 resume，或者只是两个 agent 用同一个 preset——就因为一个它从未打算争用的注册表，丢掉了自己的整份组合。

这一行写入的其他注册表都是按 agent 分层的：`ctx.tools.register` 与 `systemPrompt.section` 归档到挂载它的那个 agent 的作用域，两个会话因为注册彼此不相遇而共存。preset 挂载器守住了相邻的那个隐患——它拒绝把服务发布到 root realm 的行，「因为这样的服务是进程全局而非按会话的，第二个挂载同一 preset 的会话会与第一个冲突」——但一个写入*既有*进程全局注册表的行并没有发布任何东西，所以什么也没拦住。

## 决策

一个 provider id 持有一组存活注册方，而不是一个。声明同一 id 的注册方，在其 manifest 按值相等时共享该 id；每个 disposer 只移除自己那一份；id 一直存活到最后一个卸载为止——这正是 `sessionProjections` 出于同样理由已经在用的计数式注册方安排。

两个细节承载了这次修复：

- **由最新的注册方作答 `list` 与 `query`，而不是最初的那个。** 一次注册可能捕获它挂载时所在的 context——`Tool` provider 就闭包了自己的 `ctx` 以便访问 `ctx.tools`——因此钉住最初那个，会让一个已卸载会话的 context 继续为存活会话作答。注册方按最新在前存放，类型是非空元组，因为被清空的 id 会被删除。
- **manifest 的同一性按值判断，而不是按引用。** 每个会话都从同一份源码构建自己的 manifest 对象，因此相等性采用对象键排序后的规范化序列化：两处调用以不同键序写下的同一份声明，描述的是同一个 provider。与存活 manifest 不一致的 manifest，属于两个 provider 争用同一个名字，仍然抛错。

没有尝试给注册表加会话作用域。它的 Client 半路由的是页面全局的查询，它的 Host provider 从生成的 catalog 作答，因此这个 id 确实只是目录中的一项；按会话变化的只是由哪个存活注册方来服务它。

## Alternatives considered

- **像 `tools` 与 `systemPrompt` 那样让 inspect 注册表按 agent 分层。** 那是消除争用而不是对争用计数，而且 `Tool` provider 的回答本来就通过 query 收到的 `agent` 按 agent 限定。暂不采纳：同一个注册表还镜像着页面全局的 Client manifest，并按 request id 路由 Client 查询；为一个只存在于 Host 半的问题，按 agent 分层会把一份目录拆成两种生命周期。
- **id 已存在时跳过注册。** 在 `tool-cordis` 里只要两行，而且错法与「最初注册方胜出」如出一辙：幸存的那个注册方属于最先挂载的会话，并且在该会话卸载之后仍继续作答。
- **像 root realm 守卫拒绝已发布服务那样，拒绝写入进程全局注册表的 preset 行。** 没有东西可供检测：一次注册就是对被注入服务的一次普通方法调用，与该服务的任何其他用法无从区分。只有注册表自己知道某个 id 被争用。

## Consequences

重复 id 的拒绝信息现在是 `is already registered with a different manifest`，且只在真正冲突时触发，因此按旧消息匹配任意重复的调用方不再匹配得上。manifest 相等性的代价是每次注册一次规范化序列化，且只发生在挂载时。

两个 manifest 恰好完全相同、查询行为却不同的 provider，现在会共享一个 id 而不是冲突，由最新的那个作答。本仓库中不存在这样的一对，而 provider id 是被声明出来的名字，不是被发现的名字。

## Testing

注册表测试从兄弟 fiber 挂载同一个 provider——两次 preset 挂载正是这样——并追踪每次卸载留下的状态：两个会话同时持有该 id，最新的作答，卸载任一个后另一个继续服务，最后一个卸载时该 id 消失。冲突的 manifest 仍然抛错且不动存活的注册方；只有键序不同的 manifest 共享该 id。在其之上，一个真实组合在两个独立会话作用域下挂载 `tool-cordis` 两次，并断言第二次挂载成功——正是产生这份报告的那个情形；把注册表的改动还原后，它会以报告中一模一样的消息失败。
