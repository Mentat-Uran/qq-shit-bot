# QQ 群小游戏与行测题库

这套功能把“游戏规则”和“题库内容”分开：规则由本仓库的确定性代码执行，题干、选项、答案和解析从本地 JSON 读取，不让 LLM 生成题目或替用户判分。已有的海龟汤仍复用上游 AI 引擎，成语接龙和猜成语继续复用现有成语词库。

## 入口

```text
菜单
小游戏
小游戏 规则
小游戏 题库
行测帮助

数字炸弹       直接开始
24点           直接开始
猜人物         直接开始
行测 常识      按指定模块开始
小游戏 1       按总目录编号开始
小游戏 题库 2页 查看题库分组的第 2 页
```

保留的旧入口包括 `开始海龟汤`、`开始成语接龙`、`猜成语`、`提示`、`查看进度` 和 `放弃`。所有文字游戏共享同一会话房间、玩家积分、排行榜、空闲过期和结束逻辑；同一群同一时间只运行一局，不引入私密身份、私聊发牌或图片交互。

## 游戏目录

- 规则类：数字炸弹、24 点、飞花令、诗词接龙、线索竞拍。
- 题库类：成语接龙、猜成语、猜人物、猜作品、知识抢答、真假判断、找不同、词语分类、一句话推理、脑筋急转弯、谜语、排序题。
- 行测类：常识判断、言语理解、判断推理、数量关系、资料分析。
- AI 增强：海龟汤继续使用已有的模型出题和主持；基础文字游戏、行测出题和判分不依赖模型。

通用控制是 `提示`、`查看进度`、`答案`/`解析`、`下一题`、`放弃`。答题型游戏支持群友共享一题、先答先得分；行测会记录每名玩家的答题数、答对数、得分和正确率。

## 行测题库导入

导入脚本不联网、不调用 LLM，只接受明确指定的上游 `questions/questions.json`：

```bash
python tools/import_exam_bank.py \
  --input /path/to/civil-service-exam-prep/questions/questions.json \
  --output deploy/openclaw/games/ai-turtle-soup/exam_bank.json
```

当前导入快照的统计是：源数据 5000 条，保留 4148 条可用的文字题，按模块为常识 994、言语 1200、判断 1157、数量 618、资料 179。当前复现使用的上游快照提交为 `3aa81a5c9e2f73615c9eed19870f0475442a0dfc`。被排除的 852 条是带图片/图表标记，或题干明确依赖图、示意图、数独等视觉题面；不是用 LLM 判断题目内容。

导入记录了 `source`、题型、难度、坑点和 `public_safe` 元数据。完整的文字题先保存在本地题库；QQ 公开运行时仍会按运行时内容规则选择可公开题目，避免把不应在群聊中公开的题面直接发出去。这一层与“题目是否由 LLM 生成”是两个不同边界。

题库文件较大，重新同步时应重新运行导入脚本，不要手工改生成的 JSON。容器通过 Dockerfile 直接复制 `structured_games.py`、`game_bank.json` 和 `exam_bank.json`，侧车启动时一次性加载。

## 复用与来源

- 旧游戏继续使用仓库已有的 `chat_games.py`、`China-idiom` 和海龟汤适配层。
- 行测导入格式复用 [fei98/civil-service-exam-prep](https://github.com/fei98/civil-service-exam-prep) 的 `questions/questions.json`，不重新设计一套题目生成器。
- 上游应用代码仓库声明为 MIT；其 README 说明远程真题数据来自 `mpbfx/gongkao`（AGPL-3.0）并提示题面、解析版权归原作者。这里保留来源字段和个人学习用途说明，不能把题面/解析误宣称为本项目原创或由 MIT 代码许可证自动覆盖。

## 验证

```bash
.venv/bin/python -m pytest -q tests/games/test_chat_games.py
.venv/bin/python -m pytest -q tests/deploy/test_openclaw_docker.py
node --test tests/node/interactive-features.test.mjs
node --check deploy/openclaw/qqbot-interactive-features-patch.mjs
```

这些检查证明本地规则、部署文件和适配器路径；不等同于真实 QQ 客户端已经收发成功。真实群聊投递仍需要在部署后用 `菜单`、直接游戏名、`行测 常识` 和 `答案/解析` 做一次客户端确认。
