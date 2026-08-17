# Agent Note：席位冲突会指明占用者

Status: implemented

[English](2026-08-16-seat-collisions-name-their-holder.md) | 中文

## 问题

一个动态 Cordis 包注册了 webserver route，却丢弃了 disposer。它的 fiber 已经卸载，route 却没有。此后每一次激活——同一 Plugin 的新 Package，以及另一个 Session 中的第二个 Plugin——都在启动时以 `webserver: duplicate prefix route "/waitv/stream"` 失败；而这条消息无法区分它可能报告的三种状态：另一个存活的插件占着该路径、另一个 Session 的插件占着它，或者某个已死插件的注册比它自己活得更久、任何 teardown 都不会再释放它。Agent 为此换了六次激活、把 route 挪到新的路径上；每当一个 Package 在 `register` 调用之后、`apply` 返回之前失败，就又泄漏一个席位。

host runner 本就为这种情况准备了处置办法，却送不出去。`startHostHalf` 匹配的是子串 `already registered`——工具注册表与 fallback 席位会这样措辞，route 表却不会——于是整整一类 route 冲突都以裸的冲突信息抵达。而它本该打印的处置办法里写着 `cordis_runtime_inspect what:"temporary"`，那是一个已经不存在的工具；它也只教了「先 stop 再重新运行」这一条，恰恰是唯一无法修复已泄漏席位的动作。

## 决策

`WebServer` 的每个席位都记录认领它的 fiber。`register`、`registerUpgrade` 与 `registerFallback` 统一走一个私有的 `claim(seat, collision)`：席位被占用时，拒绝信息给出占用者的 fiber 名称；若该 fiber 已经 dispose（资源释放），还会说明注册方丢弃了这个 disposer，该席位在进程重启前一直被占用。是否已释放通过 `holder.uid === null` 判断——cordis 自身就是据此推导 `FiberState.DISPOSED` 的——因此本包无需为一个 const enum 再做一份运行时镜像。释放席位的正是移除注册的那个 disposer，所以占用表中的席位与 route 表、fallback 槽位中的完全一致。

席位不可回收。泄漏的注册会继续用已死插件的 handler 提供服务，本次变更只如实报告，而不去修复它：注册的所有权属于调用方，一个自行判定 fiber 已死并驱逐占用者的注册表，等于对它并不管理的 fiber 作猜测。

`startHostHalf` 改为匹配整类冲突，而不是某一个注册表的措辞——`already registered`、`has been registered at` 与 `duplicate `。这个匹配刻意放宽：给无关失败附上一句处置办法只多一句话，而漏掉一次真实冲突，会让 Agent 无从分辨「名字被占」与「自己的代码有问题」。处置办法现在列出三种原因及各自不同的动作，指明 `cordis_inspect_self` 并说明它以 Session 为范围，同时讲清 `ctx.effect` 的 disposer 保留写法。

## Alternatives considered

- **在沙箱 guard 中自动把返回的 disposer 注册为 effect。** `guardedService` 已经包装了每个被注入服务的返回值，因此它可以把任何返回的函数交给 `ctx.effect`，让裸写的 `ctx.webServer.register(...)` 对模型编写的包也安全。已否决：guard 无法把 disposer 与其他返回函数区分开，而一个自己也会调用 disposer 的包会让它被调用两次。它还会藏起包作者必须学会的那一条生命周期规则，而这个面的其他失败都是响亮的。
- **由 `WebServer.register` 自己在调用方 fiber 上调用 `ctx.effect`。** 调用方的 context 可经 cordis 的 service tracker 取得——占用者名称正是这样拿到的——因此该服务可以把每个 route 绑定到注册它的 fiber，从源头终结这类泄漏。这里是推迟而非否决：它颠倒了「注册表返回 disposer、调用方拥有 effect」这条全仓库通行的约定，因而要么所有注册表一起改、要么都不改；而且从长生命周期 context 发起的注册会变成永远不被释放，且无声无息。在那个决定作出之前，占用者报告就是本次变更买到的东西。
- **在 Package 定义时就拒绝重复路径。** 定义期只有源码文本，这种检查只能是对模型所写 JavaScript 的词法猜测：它看不见计算得出的路径，而一次误报会拒绝一个合法定义。激活是真实路径最早可知的时点。
- **只给出占用者名称、不给存活状态。** 仅有名称仍然无法区分「去停掉另一个 run」与「这条路径在本进程内已经彻底没了」，而这正是 Agent 反复判断错的那个决定。

## Consequences

两条冲突消息各自多了一段括号内容，前缀保持不变，因此按 `duplicate exact route` 或 `fallback already registered` 匹配的调用方仍然匹配得上。「占用者已释放」这一分支依赖 cordis 的 `uid` 字段继续作为已释放信号，vendoring 同步流程会重新核对这一点。

宽匹配意味着一个消息中含有 `duplicate` 字样的无关启动失败也会带上处置办法。这是不去枚举 runner 并不拥有的各注册表措辞所接受的代价。

## Testing

webserver 的 real-Loader 组合测试从一个具名子 fiber 认领席位并断言冲突信息指明了它，随后 dispose 该 fiber 并重新注册，以证明绑定到 effect 的路径确实会释放；接着挂载一个丢弃 disposer 的插件，将其 dispose，先展示已死插件的 handler 仍在应答，再由重新注册的尝试报出泄漏。runner 的测试针对真实组合无法产生的两种注册表措辞钉住处置办法，而既有的工具名冲突用例继续以真实组合覆盖「占用者存活」这一情形；另有一个无关的 host half 失败被断言原样透传、不带处置办法。

## Related

同一次排查还发现，Web 客户端的工具行 variant 与标题映射里仍留着 `cordis_runtime_inspect` 与 `cordis_package_inspect`，它们比对应的工具活得更久。当前三个 inspect 工具因此都渲染成没有标题的通用行；这些映射及其测试现已改为 `cordis_inspect_list`、`cordis_inspect_query` 与 `cordis_inspect_self`。
