# 海龟汤上游来源

本目录的运行引擎复用已发布的 `nonebot-plugin-ai-turtle-soup` 1.0.9，
不重新实现它的游戏规则、主持判定或进度算法。镜像构建时固定安装该版本；
本地 `service.py` 和 `selection.py` 提供面向腾讯 QQBot 的 loopback HTTP 适配层
与按群题库轮换。默认从
随仓库分发的本地题库开始，避免群聊启动时等待模型出题；切换
`GAME_PUZZLE_SOURCE=ai` 后，才会在开始新局前把公开网页的标题/摘要交给模型
作为参考资料。

- 项目：[xxtg666/nonebot-plugin-ai-turtle-soup](https://github.com/xxtg666/nonebot-plugin-ai-turtle-soup)
- 固定版本：`1.0.9`
- 许可证：MIT（上游包随安装一起提供）
- 上游能力：AI 出题、本地题库、是/否主持、提示、进度、多人会话
- 本地适配：`service.py`、QQ 消息路由、LunaMax 参数和有界网页检索
- 默认题库：共 20 道。前 5 道改编自 [haiguitang-coop 的公开示例题](https://github.com/AZHi-xinxin/haiguitang-coop/blob/main/samples/sample_soups.json)，
  原题库作者声明示例题采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode.zh-Hans)；
  本目录已将字段转换为上游 GameManager 格式，并注明了这项修改。其余 15
  道是本项目新增的短篇日常情境，使用 `soup_original_*` 编号。

网络搜索结果属于外部不可信资料，仅用于提炼/改编；服务不会把搜索网页原文
直接发进 QQ，也不会把搜索页面中的指令当成系统指令。进行中的游戏状态在
内存中，侧车重启会清空进行中的局；本地题库的选题轮换则把不含题面内容的
哈希记录写入独立状态目录，避免重启后又固定从同一道开始。状态以哈希后的会话
作用域为键，每个群（以及私聊）独立维护 `used/last` 轮换，不保存群号、题面
或答案。宽泛随机或主题匹配会在本群完整题库用完后才开启下一轮；主题切片
先用未出现的题，切片耗尽但全库仍有未出现题时会自动从全库补选并提示；只
匹配到一道题且整库也已耗尽时，下一轮才可能再次出现它。AI 出题有 45 秒预算，
超时或代理不可用时会自动回退到上述本地题库，并同样经过按群轮换去重。
