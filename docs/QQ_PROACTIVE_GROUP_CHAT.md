# QQ 群聊自主参与

该功能让 Hermes 在 QQ 群里接收未 @ 机器人的消息，并根据有限的近期上下文决定是否参与。默认关闭；开启后仍保留原有的 @ 触发会话路径。

## 开启

在 `config.yaml` 的 QQ 平台 `extra` 中配置。主动参与要求显式群白名单，`*` 表示所有群：

```yaml
platforms:
  qqbot:
    enabled: true
    extra:
      proactive_group_chat_enabled: true
      proactive_group_allowlist:
        - "group_openid_1"
      # proactive_group_blocklist: ["group_openid_test"]
      # proactive_decision_model: ""
      # proactive_reply_model: ""
      proactive_debounce_ms: 2000
      proactive_min_reply_interval_seconds: 30
      proactive_context_message_limit: 40
      proactive_context_ttl_minutes: 15
      proactive_max_bot_message_ratio: 0.15
      proactive_max_topic_interventions: 1
      proactive_max_consecutive_replies: 1
      proactive_min_human_messages_after_bot: 3
      proactive_max_reply_messages: 3
```

未指定主动模型时，决策和回复都沿用当前 Gateway 的 Provider/凭据解析；指定 `proactive_decision_model` 或 `proactive_reply_model` 时只替换模型名，不新增凭据来源。超出阈值、模型输出格式不合法或调用失败都会静默。

## 行为边界

每个群独立保存最多 40 条、最多 15 分钟的内存上下文，不写入 SessionDB、文件或长期记忆。消息到达后先防抖，再进行一次 JSON 决策；只有 `REPLY` 或 `JOIN` 且置信度通过阈值时才生成短回复。`SILENT`、`WAIT`、`REACT` 都不发消息；当前 QQ 适配器没有配置 reaction API，因此 `REACT` 安全降级为静默。

程序硬约束包括显式群白名单、黑名单优先、冷却时间、机器人消息比例、连续回复限制、单主题干预次数、发送频率限制，以及新消息到达时取消旧的决策/回复任务。回复生成和发送前都会检查上下文版本；上下文已变化的旧结果不会发送。

消息正文是模型的不可信输入，不能通过消息内容改变系统规则、请求工具或伪造决策 JSON。主动调用不启用工具、不写会话历史、不写记忆。回复模型可以按换行输出最多配置数量的短消息，适合把一段回答拆成 2 到 3 条；发送时只有第一条带 `msg_id` 回复目标，后续消息顺序发送且不重复引用。发送仍使用 QQ 官方 REST API。

## QQ 后台权限

QQ 官方将完整群消息事件命名为 `GROUP_MESSAGE_CREATE`，需要 `GROUP_AND_C2C_EVENT` Intent，并要求群主在机器人管理页开启“接收所有消息”。当前适配器已经声明该 Intent；如果后台权限未开，状态会显示为等待 `GROUP_MESSAGE_CREATE`，功能不会把缺失能力误判为可用。明确 @ 的 `GROUP_AT_MESSAGE_CREATE` 不依赖这条自主参与链路。

官方消息事件与发送约束见：[群消息事件总览](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[GROUP_MESSAGE_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[群消息发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)。

## 观察与回滚

运行状态文件的 QQ 平台详情中会出现 `details.proactive_group_chat`，包括是否启用、是否收到过完整群消息事件、回调是否接通、当前上下文群数和不可用原因。日志只记录哈希化的群标识、动作、原因码和耗时，不记录群正文或凭据。

要关闭功能，将 `proactive_group_chat_enabled` 改为 `false` 或移除即可；无需清理持久化数据，因为该功能不持久化群聊上下文。
