# 保存与运行时生效分开，使用宿主公开的 location reload

> Source: oc2cpa-bya (D6, D11), oc2cpa-bya.13 (Q4 B), oc2cpa-bya.16 (Q5 A); design snapshot retained at commit `8bc28d0a766bf610e1424f3a0d4580f7adc88146`

OpenCode 2.0.26 在 location boot/reload 编译已有 provider binding；重新发布目录不等于运行时已按新参数分发。采用机器可读的 `applied` / `reloadRequired` 两阶段契约，而不另建热更新或脚本框架：TUI 自动调用公开 `location.reload()` 后重读快照，无界面调用方读同一标志自行 reload；相同 binding 不要求 reload。空 boot registry 的首次成功接入可立即生效，这是隔离宿主验证过的例外，不是插件热更新能力。

等待 apply 时，已编译 binding 若会发送当前已保存目录/偏好撤回的 priority，则拒绝该模型的新请求，已在飞请求不动。该检查只读按 provider 与连接 fingerprint 索引的进程内共享目录规则，因为同一 provider 的 global/location 插件实例可能不同；不从持久缓存逐请求仲裁。目录提交按发出顺序串行收敛，不保留补偿性重存或重发机制；缓存只作启动优化，不能因缓存写入失败改变实际参数。这保留真实参数和凭证隔离要求，同时避免恢复机制叠加成状态框架。

代价是已有 binding 的改变需要 reload；reload 清除内存统计并取消暂停中的请求，而不是偷偷放行。调用方须区分已保存偏好与 `fastEffectiveModels` 描述的实际效果。公开用法及首次接入边界见 [README](../../README.md#applying-a-connection-or-directory-change)。
