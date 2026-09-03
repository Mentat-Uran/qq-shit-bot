# 文字小游戏上游来源

本目录新增的两种文字游戏面向 QQ 群聊设计：成语接龙和共享答案的猜成语。
规则适配层在 `chat_games.py`，不依赖 QQ、模型或文件系统，因此可以用固定词库
fixture 单独测试。进行中的房间只保存在 `qqbot-game` 进程内，侧车重启后清空；
不会把群号、玩家 OpenID、猜测或答案写入持久化状态目录。

## 直接运行依赖

- 项目：[sfyc23/China-idiom](https://github.com/sfyc23/China-idiom)
- 固定提交：`78606b0294a22e798633c4469a4009b78ad60f26`
- 许可证：MIT（以上游仓库的 `LICENSE` 为准）
- 用途：加载四字成语、判断成语有效性、按末字或末字同音查找接龙候选，
  并提供猜成语结束时的释义。
- 接入方式：`Dockerfile` 通过该提交的 GitHub 源码归档安装；未使用当前较旧的
  PyPI 同名版本，也没有把整份成语 CSV 再复制进本仓库。

## 规则参考

- 项目：[noneplugin/nonebot-plugin-handle](https://github.com/noneplugin/nonebot-plugin-handle)
- 固定参考提交：`61ba1243d15e5f7b173146b8c6f2d122c51d69a7`
- 许可证：MIT（以上游仓库的 `LICENSE` 为准）
- 用途：参考其中文 Wordle 的十次猜测、四字输入、重复字的
  exact/present/absent 两遍计分思路。
- 本项目没有直接复制它的 NoneBot matcher、Pillow 图片渲染或会话实现；QQ 适配层
  改为纯文字棋盘，以免用户还需要点图或加载额外图像依赖。

成语接龙的会话隔离、重复检查、同字/同音模式、群内排行榜和提示是本项目的
`chat_games.py` 规则代码。猜成语的答案仍来自同一个 MIT 词库；提示只揭示一个
位置，不扣猜测次数，重复提交不扣次数。

## 为什么本轮不接入狼人杀或阿瓦隆

公开的 [nonebot-plugin-werewolf](https://pypi.org/project/nonebot-plugin-werewolf/)
和 [nonebot-plugin-avalon](https://pypi.org/project/nonebot-plugin-avalon/) 都是
可用的开源方向，但它们需要身份分发、夜间/任务阶段、多人计时以及更复杂的私聊
或权限交互。官方 QQ Bot 的私聊能力还存在平台限制；在当前“尽量靠聊天、不要太
复杂”的目标下先不引入，避免做出表面能开始、实际无法完整跑完的半成品。

海龟汤仍由本目录既有的
[`nonebot-plugin-ai-turtle-soup`](https://github.com/xxtg666/nonebot-plugin-ai-turtle-soup)
适配层负责；它和本批纯文字游戏共用一个 CPU-only sidecar，但每个 QQ 会话同时
只允许一局游戏。
