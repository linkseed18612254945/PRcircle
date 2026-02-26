# Multi-Agent Analysis MVP

一个**最小可运行**的多智能体分析系统（MVP）：

- Agent A（AnalysisAgent）：负责分析与方案提出
- Agent B（ChallengeAgent）：负责质询、挑战与测试要求
- 统一检索工具：仅支持 Tavily
- 多轮对话编排：A/B 交替循环
- 简易 Web 前端：话题输入、参数设置、对话展示

---

## 1. 项目目标

用户输入一个分析话题后，系统执行多轮智能体互动分析：

1. A 给出结构化分析方案
2. B 基于 A 的输出进行批评和挑战，提出 required mutations 与 test cases
3. 下一轮 A 按 B 的要求继续修正与拓展
4. 最终返回完整对话过程（含消息内容、可选结构化字段与检索来源）

---

## 2. 系统架构

```text
Frontend (Web UI)
    |
    | REST API
    v
Backend Service (FastAPI)
    ├── DialogueEngine
    │       ├── AnalysisAgent (Agent A)
    │       ├── ChallengeAgent (Agent B)
    │       └── SearchTool (Tavily)
    │
    └── LLM Client (OpenAI-compatible API)
```

---

## 3. 功能特性

- **双 Agent 协同推理**：分析 + 质询，提升方案严谨性。
- **灵活输出**：A/B 可输出自然语言或 JSON；若响应可解析为 JSON，会在 `structured` 字段中展示。
- **检索增强**：通过 Tavily 引入外部信息与反例线索。
- **共享情报池**：每轮由Agent先基于当前问答与已有情报“规划高质量检索词”（方向+理解+验证意图），规划结果会先去重再执行检索，并将新证据沉淀到会话级共享池。
- **容错策略**：Tavily 失败时返回空结果，不中断主流程。
- **OpenAI-compatible**：可对接兼容 `/chat/completions` 的任意模型网关。
- **轻量前端**：开箱可用，支持话题输入、模型参数与 Agent 能力提示配置（格式/逻辑提示内置于后端）。

---

## 4. 代码结构

```text
.
├── app/
│   ├── __init__.py
│   ├── agents.py          # BaseAgent / AnalysisAgent / ChallengeAgent
│   ├── dialogue_engine.py # 多轮对话编排
│   ├── llm_client.py      # OpenAI-compatible LLM 调用
│   ├── main.py            # FastAPI 入口 + /api/run + /api/run/stream
│   ├── models.py          # Pydantic 数据模型
│   ├── prompts.py         # Agent 默认 System Prompt 配置
│   └── search_tool.py     # Tavily 检索适配
├── static/
│   ├── index.html         # Chat + Settings 页面
│   └── main.js            # 前端交互逻辑
├── requirements.txt
└── README.md
```

---

## 5. 核心模块说明

### 5.1 Agent 模块

#### BaseAgent

公共能力：

- `generate(state)` 抽象方法
- `call_llm(messages)` 统一 LLM 调用
- `maybe_call_search(query, topk)` 统一检索入口
- `_plan_search_queries(...)` 基于问答上下文动态规划关键检索词（支持结构化规划与兜底策略）
- `_select_intel_for_prompt(...)` 从共享池按当前轮相关性筛选证据用于提示

#### AnalysisAgent（A）

职责：分析问题并提出候选机制。输出目标结构：

```json
{
  "summary": "...",
  "candidates": [
    {
      "name": "...",
      "core_mechanism": "...",
      "assumptions": ["..."],
      "steps": ["..."],
      "verification": "..."
    }
  ]
}
```

关键规则：

- 首轮至少 2 个 candidate
- 若上一轮 B 提出 `required_mutations`，本轮需执行
- 可调用 Tavily 获取背景资料

#### ChallengeAgent（B）

职责：批评与挑战 A 的方案。输出目标结构：

```json
{
  "criticisms": ["..."],
  "required_mutations": ["ConstraintFlip"],
  "test_cases": ["..."],
  "questions": ["..."]
}
```

关键规则：

- 至少 2 个批评点
- 至少 1 个 mutation
- 至少 1 个 test case
- 可调用 Tavily 查找反例线索

---

### 5.2 SearchTool（Tavily）

统一接口：

```python
search(query: str, topk: int) -> List[RetrievalResult]
```

`RetrievalResult` 字段：

- `id`
- `title`
- `url`
- `content`
- `score`

Tavily 请求参数：

- `query`
- `max_results`（映射 topk）
- `include_answer=false`

> 注意：MVP 中不含本地向量库、不做缓存。

---

### 5.3 DialogueEngine

`DialogueState` 维护：

- `topic`
- `turn_index`
- `max_rounds`
- `messages[]`
- `intel_pool[]`（共享去重情报池）

循环逻辑：

```python
for round in range(max_rounds):
    A.generate()
    B.generate()
    if B.stop:
        break
```

终止条件：

- 达到 `max_rounds`
- 或 B 输出 `stop=true`

---

### 5.4 LLM 客户端

兼容 OpenAI Chat Completions：

- model
- base_url
- api_key
- temperature
- max_tokens

统一调用：

```python
call_llm(messages, config) -> str
```

---

## 6. API 说明

### `POST /api/run`

用于非流式一次性返回结果。

### `POST /api/run/stream`

用于流式返回（SSE）。每条事件以 `data: {...}` 下发，`type` 包含 `session_started` / `message` / `done`。

请求体示例：

```json
{
  "topic": "如何构建可解释的个性化学习路径系统",
  "max_rounds": 4,
  "agentA_config": {
    "model_name": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "api_key": "<YOUR_KEY>",
    "temperature": 0.7,
    "max_tokens": 800,
    "capability_prompt": "偏向给出可执行步骤、风险与验证方案。"
  },
  "agentB_config": {
    "model_name": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "api_key": "<YOUR_KEY>",
    "temperature": 0.7,
    "max_tokens": 800,
    "capability_prompt": "偏向挑战假设、提出反例与可复现实验。"
  },
  "tavily_api_key": "<TAVILY_KEY>",
  "search_topk": 5
}
```

响应体示例：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "..."
    },
    {
      "role": "A",
      "content": "{...}",
      "structured": {"...": "仅当模型输出可解析 JSON 时出现"},
      "retrievals": [...],
      "search_queries": ["...", "...", "..."],
      "timestamp": "..."
    },
    {
      "role": "B",
      "content": "{...}",
      "structured": {"...": "仅当模型输出可解析 JSON 时出现"},
      "retrievals": [...],
      "search_queries": ["...", "...", "..."],
      "timestamp": "..."
    }
  ]
}
```

---

## 7. 前端使用

页面包含两个 Tab：

1. **Chat**
   - 输入 Topic
   - 设置 `max_rounds`
   - 点击 Start 发起分析
   - 流式展示消息，支持查看 structured（若存在）与检索来源

2. **Settings**
   - Agent A 模型配置 + capability_prompt（能力偏好）
   - Agent B 模型配置 + capability_prompt（能力偏好）
   - Tavily API Key 与默认 topk

3. **多会话能力**
   - 支持创建多个分析会话并切换查看历史
   - 单会话运行中会锁定提交按钮，避免重复触发

---

## 8. 本地运行指南

### 8.1 环境要求

- Python 3.10+

### 8.2 安装依赖

```bash
python -m pip install -r requirements.txt
```

### 8.3 启动服务

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

启动后访问：

- 前端页面：`http://127.0.0.1:8000/`
- OpenAPI 文档：`http://127.0.0.1:8000/docs`

---

## 9. 快速调试（cURL）

```bash
curl -N -X POST 'http://127.0.0.1:8000/api/run/stream' \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "如何设计低成本在线实验验证商业假设",
    "max_rounds": 2,
    "agentA_config": {
      "model_name": "gpt-4o-mini",
      "base_url": "https://api.openai.com/v1",
      "api_key": "YOUR_OPENAI_KEY",
      "temperature": 0.7,
      "max_tokens": 600,
      "capability_prompt": "偏向给出可执行步骤、风险与验证方案。"
    },
    "agentB_config": {
      "model_name": "gpt-4o-mini",
      "base_url": "https://api.openai.com/v1",
      "api_key": "YOUR_OPENAI_KEY",
      "temperature": 0.7,
      "max_tokens": 600,
      "capability_prompt": "偏向挑战假设、提出反例与可复现实验。"
    },
    "tavily_api_key": "YOUR_TAVILY_KEY",
    "search_topk": 5
  }'
```

---

## 10. 异常与容错说明

- **Tavily 请求失败**：捕获异常并返回 `[]`，不会中断 A/B 推理流程。
- **模型输出非 JSON**：这是默认支持路径；仅在可解析 JSON 时填充 `structured`。
- **流式中断**：前端会在请求失败时提示错误；可重试当前会话。

---

## 11. 安全与生产建议（MVP 之外）

当前实现为快速验证版，生产化建议包括：

- API Key 不在前端明文传输，改为后端安全存储
- 增加鉴权/限流/审计日志
- 增加请求超时与重试策略配置
- 增加提示词注入防护与输出 schema 强校验
- 对后端消息持久化与会话隔离进行增强

---

## 12. 已知限制

- 未提供流式输出（当前为一次性返回）
- 未提供会话持久化存储
- 未提供自动评估指标（如一致性/新颖性评分）
- 未集成测试框架（建议后续补充单测与接口测试）

---

## 13. 后续可扩展方向

- 进一步增强 streaming 体验（token 级别推送 / 断线续传）
- 增加 Stop 策略（基于收敛度或置信评分）
- 引入更多角色（例如 JudgeAgent）
- 对 structured 输出做 JSON Schema 强校验
- 增加运行历史和结果导出（Markdown/JSON）

---

## 14. License

本仓库当前未显式提供 License 文件；如需开源发布，请补充 `LICENSE`。
