# 销售事实表对账工作台

订单、支付、退款三套数据源的对账流程：接入源数据 → 分类差异 → 提出并审批调整 → 按范围重算。所有金额在入库时一次性解析为**整数分**，此后的加减乘除不出现浮点数。

无运行时依赖，仅需 Node.js ≥ 22.5（使用内置 `node:sqlite`）。

```bash
npm run seed:reset     # 建库 + 灌入演示数据 + 跑一次全量对账
npm start              # http://localhost:7788
npm test               # 33 条规则测试，全部在内存库上跑
```

演示数据覆盖 2026-11-02 至 11-05：导出内重复、跨批次重复、分笔支付、跨日退款、缺失支付文件、来源修订、订单号录错、退款超过收款等情况。`RECON_SEED_REVISION=0` 会清空数据库并去掉订单修订批次，用于对比（默认是 `1`）。

## 核心约定

### 证据只增不改

源行一旦入库就不再修改。任何修正都写入 `override_register`，主键是 **(source, source_row_id, field)**：

- 修复支付侧的订单号，只会新增一条 `source='payments'` 的覆盖记录，订单与退款表的原始行、原始 `raw` 报文、原始批次号都保持原样；
- 界面的订单追溯（`GET /api/orders/:orderNo`）同时展示原始行与生效值，并标出被哪条覆盖、由哪次审批产生；
- 调整单提交时必须引用该差异**已记录的**证据（`source|row_id|batch_id` 三元组），引用未记录的证据会被 422 拒绝——避免事后补一段不存在的凭据。

### 批次与修订

同一 `(source, source_ref, business_date, revision)` 重复投递且内容一致 → 幂等返回；内容不同 → 409。新修订必须严格大于旧修订，加载后旧批次置为 `superseded`。**只有非 superseded 的批次参与对账**，但旧批次及其行永久保留，所以修订导致的金额差可以被追溯为「可解释差异」而不是「真实冲突」。

### 三类差异

| 分类 | 含义 | 允许的调整动作 |
|---|---|---|
| 可解释差异 `explainable` | 差异有明确成因，不需要人工判断金额 | `accept_diff` 接受差异、`remap_key` 修正键值 |
| 待补数据 `pending_data` | 数据尚未到齐（支付在途、当日支付文件缺失） | `defer_cutoff` 挂起至下期 |
| 真实冲突 `conflict` | 两边都有数据但无法相互解释 | `write_off` 核销、`manual_entry` 手工补录、`accept_diff` |

动作与分类的对应关系写死在 `ACTION_RULES`，跨类提交直接 422。可解释差异即使被接受，也保留为 `accepted` 状态进入结果，不会从审计链里消失。

### 判定口径

对每个订单号：

- `expected = gross − discount`（取当前有效订单行，重复行只计一次）
- `paid = 已捕获支付之和`（`captured` 计入，`pending` 只作为在途证据）
- `delta = paid − expected`
- 退款单独核对：`refunded > paid` 的部分为超出收款的冲突

逐类处理：

- **重复**：按 `自然键 + 日期 + 金额 + 状态` 识别，重复行标记 `is_duplicate`/`duplicate_of` 并保留，对账金额影响为 0；
- **部分支付**：差额若恰好能被在途支付解释，归为待补数据并给出准确差额；否则按欠款冲突处理；
- **跨日退款**：退款业务日与支付业务日不同，作为可解释差异引用两天的凭证；
- **来源修订**：若被 superseded 的批次净额与当前净额之差正好等于 delta，归为可解释差异，同时引用当前与历史两份凭证；
- **订单号录错**：仅当候选订单号与现订单号是数字换位或编辑距离 ≤ 2、且**唯一**时才给出重映射建议（存在同样接近的第二个候选则拒绝猜测）。在审批前，这笔支付不计入任何订单的已收金额；
- **在途支付 / 退款**、**作废支付**、**取消订单**、**有支付无订单**、**有订单无支付** 分别有独立子类型与金额。

### 重算范围

审批通过会写入一条 `recompute_scope`（订单级），多次审批会合并。`POST /api/recompute` 只重算范围内订单，其余订单从上一轮结果**原样结转**（`carried`），因此任何一次局部重算得到的都是一份完整快照，而不是半张表。范围消费后置 `consumed_at`，重复提交返回 409 `no_pending_scope`；全量重算会清空所有未消费范围。

审批要求操作人与提交人**不同**（`allow_self_approval: true` 仅用于演示/测试）。提出、审批、驳回都会连同操作人、动作与影响范围写入 `audit_log`。

## HTTP 接口

操作人通过请求头 `x-actor` 传入（URL 编码）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 最新一轮汇总、分类计数与金额、批次日覆盖矩阵 |
| GET | `/api/batches` | 批次列表（含 superseded）与按来源/日期的覆盖情况 |
| POST | `/api/batches` | 整批载入一个源文件；整批校验失败返回 422，不落任何行 |
| POST | `/api/batches/:id/status` | 批次状态流转 |
| GET | `/api/runs`、`/api/runs/:id` | 对账运行历史与明细 |
| POST | `/api/runs` | 触发对账，可带 `scope: {type: full\|order\|source_date\|batch}` |
| GET | `/api/findings` | 差异列表，支持 `category`、`status`、`q` 过滤 |
| GET | `/api/findings/:id` | 单条差异及其证据、可执行动作、关联调整 |
| GET | `/api/orders/:orderNo` | 订单追溯：原始行、生效值、覆盖、重复、调整、最新结论 |
| GET | `/api/adjustments`、`/api/adjustments/:id` | 调整单列表与明细 |
| POST | `/api/findings/:id/adjustments` | 提出调整（动作、金额、原因、证据） |
| POST | `/api/adjustments/:id/approve`、`/reject` | 审批 / 驳回 |
| GET | `/api/recompute` | 待重算范围预览 |
| POST | `/api/recompute` | 消费全部待重算范围并重算 |
| GET | `/api/audit` | 审计日志 |

## 目录

```
server/db.js            表结构、事务、审计
server/money.js         金额解析与格式化（整数分）
server/ingest.js        整批校验、幂等、修订、重复标记
server/reconcile.js     对账引擎：上下文、分类、调整应用、范围重算
server/adjustments.js   调整单提出/审批/驳回、待重算范围
server/index.js         HTTP 路由与静态资源
server/seed.js          演示数据
server/seed-cli.js      建库/重置入口
public/                 单页界面（总览、差异分类、调整审批、重算范围、批次）
test/                   node:test 规则测试
```

数据文件写在 `data/recon.db`，可用 `RECON_DATA_DIR` 指定其他目录。
