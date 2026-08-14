# PROGRESS

## Recovery and baseline

- 2026-08-13：原 D 盘误删后的完整分区镜像已保存为 `E:\D_DRIVE_RECOVERY_20260812\D_partition_before_recovery.raw`，813,012,348,928 字节，已设为只读。
- 2026-08-13：已从镜像 NTFS MFT 生成目录清单，位于 `C:\testdisk\D盘目录清单_20260813`；个人媒体恢复已按用户决定暂停，可未来继续。
- 2026-08-13：D 盘未格式化；仅解除人为只读状态，未删除旧文件。
- 2026-08-13：从 `desktop-pet-0.1.1.zip` 建立干净骨架 `D:\PetPackStudio-Rebuild-20260813`，182 个文件与 C 盘来源逐项 SHA-256 一致。
- 2026-08-13：Git 初始提交 `4de9b8e57bf5517be26896d80f8355730d2b2a68`。
- 2026-08-13：完整 Git bundle 备份：`C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-baseline-4de9b8e.bundle`；SHA-256 `4C43A9572CF8DE906777DB5B04748168A0A1482CFFE452DA55380AB3F3CF1721`。
- 2026-08-13：已将原任务源与后续用户裁定合并到 `PRODUCT_CONTRACT.md`。
- 2026-08-13：用户最终指定支付服务商为 Kaipay，并已完成支付申请；后续以 `https://app.kaipay.cn/api-debugger` 的正式接入参数为准，不再开发直连支付宝。
- 2026-08-13：已从 Codex 原始会话工具输出精确恢复 2026-08-02 版 `7个动作视频提示词.txt` 正文，保存于 `docs/prompts/7个动作视频提示词.original-20260802.txt`；该版实际含 6 段，最终七段老版稳定版继续追溯。
- 2026-08-13：已从 2026-08-06 原始 `apply_patch` 工具调用逐字符恢复七段 `动作提示词·原版动作感稳定对比版.txt`；正文与原调用完全相等，规范化 SHA-256 为 `461A63041D4D45B249E4DD563A997D8281559B9F6546F1EAAB4A7A9FA7BBD879`。
- 2026-08-13：已从双母图混合版 V4 的原始读取输出恢复正面、45°与睡姿三张母图的完整正向/反向提示词，规范化 SHA-256 为 `2786D3D16ADE784648D9E7167DCA464C1DC33C987CD321CD8E7AD986DC13831A`。
- 2026-08-13：客户端运行时第一阶段完成：IPC 明确区分 PetPack 切换、素材更新和普通配置更新；仅真实切包触发 `packageLoaded`；默认动画在生命周期动作前就绪；热更新复用同一动画控制器并立即刷新变化后的待机素材。
- 2026-08-13：空闲阈值改为 22 秒，悬停/空闲事件按一次交互会话只触发一次；拖拽、暂停恢复和实际交互会重建计时会话；循环 timer 使用有界集合，不再长期积累已执行的 timeout ID。
- 2026-08-13：不同事件类型不再互相共享 cooldown 屏障，悬停动作的冷却不会阻挡单击、双击、右键或 22 秒入睡。Windows 测试夹具已改为不依赖 Unix shell，符号链接拒绝测试在无开发者模式时使用 junction 继续验证。
- 2026-08-13：上述客户端改动全量单元回归 48 个测试文件、642 项全部通过；Vite 生产构建成功（65 modules）。Electron 31.7.7 与 FFmpeg 6.1.1 已从本机校验过的缓存恢复到依赖目录，未重新下载不可信二进制。
- 2026-08-13：建立 `hey-petpack-behavior/v1` canonical PetPack 契约和生成器：固定 7 个语义动作、6 条触发规则、22 秒入睡、2 秒悬停、20 秒同事件冷却、无随机计时/移动/消息/道具/掉落；生产打包必须传入后处理后 7 个 WebM 的实测时长。
- 2026-08-13：契约已证明入睡规则无需人工 delay：`sleep-transition` 播放时 `sleep-loop` 进入单槽 pending，过渡结束直接进入循环；睡眠中单击、双击、右键均通过 `interrupt` 立即唤醒并执行喷嚏、打滚、伸懒腰。
- 2026-08-13：新增显式 `cooldownScope: eventType`，只用于 Hey 悬停与默认空闲规则；旧 PetPack 未声明时继续沿用全局 cooldown。面板隐藏设置编辑会保留该字段，通用 validator 也限制 eventType scope 只能绑定一种条件类型。
- 2026-08-13：canonical 契约与兼容性改动全量单元回归 49 个测试文件、659 项全部通过；Vite 生产构建再次成功（65 modules）。
- 2026-08-13：逐像素透明区域穿透已接入真实桌宠运行时：普通/绿幕 WebM、PNG、GIF 和关键帧均可按当前帧采样；透明区域穿透，实体区域立即恢复交互，悬停 2 秒只累计在实体像素上。固定鼠标时素材帧或宠物窗口移动也会重新判定。
- 2026-08-13：客户端首页新增永久可见的 PetPack 导入主入口，完整复用原有文件选择、校验、原子安装、自动切换和异常恢复链路；资源、动画、规则、显示、系统五个高级页面保留并收进原生“设置”折叠菜单，窄窗口按钮自动换行。
- 2026-08-13：当前客户端全量回归 51 个测试文件、695 项全部通过；Vite 正式构建成功（66 modules）。客户端 UX 提交为 `8a7a4d0e05eb041510ccc2903de3bc679882cf87`；完整只读 Git bundle 为 `C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-client-import-8a7a4d0.bundle`，SHA-256 `82A482D68468DA9C8391D22BB427C891523EF8CB0F948CC6EA5B9D291CACE2AD`。
- 2026-08-13：已从 Lighthouse 校验恢复后端基线 `petpack-release-6f5434b.tar.gz`（232,832 字节，SHA-256 `92399017B6DEE80A436061DB054983EC673D63B9CB29D4FB0E90FCD7198301B9`），并只白名单取回最终短信登录验收版本的 4 个源码/配置文件；未把服务器密钥或 secrets 目录纳入 Git。
- 2026-08-13：修复云端打包器与客户端之间的行为契约断层：Studio PetPack 即使不携带通用 `triggerRules`，客户端也会从已校验的 `studioBehavior` 生成启动伸懒腰、单击喷嚏、双击打滚、右键唤醒、22 秒入睡与 2 秒悬停六条规则。跨“真实打包器 → 客户端运行时”测试通过，相关聚焦测试 65 项通过，Vite 构建成功（67 modules）。
- 2026-08-13：本机 `0812_1.zip` 已确认只含 3 张测试照片；Lighthouse 也没有网站 `code.zip` 或 `apps/web` 源码。因此不再等待不存在的压缩包，网站按线上页面合同、部署日志和成功补丁证据重建。
- 2026-08-13：最新版网站源码第一阶段已在 `apps/web` 重建完成：恢复首页猫狗选择、3–4 槽照片草稿/逐张替换删除/内容哈希去重、CloudBase 手机验证码登录边界、项目列表、Kaipay 购买入口、照片上传、正面与 45° 母图确认/分别重生成、生成进度、PetPack 下载、客户端下载、管理入口及备案页脚。服务端网关只允许受限同源路径，生产 API 强制 HTTPS，转发 HttpOnly 会话 Cookie，并在业务后端或登录门未配置时 fail-closed。网站 4 个测试文件、13 项通过；Next.js 正式构建完成 21 条路由；本地逐页 HTTP 冒烟 17 条全部返回预期页面，未配置业务网关明确返回 503。
- 2026-08-13：后端核心合同已升级为 3–4 张来源照（两张正面必填、一至两张约 45°）、正面/45°/睡姿三张母图、正侧母图各最多 2 次用户主动重生成、睡姿自动生成，以及 7 个 Seedance 任务一次性并发释放；每个动作同时冻结提示词版本、分辨率、模型端点、首尾帧和正侧身份参考。
- 2026-08-13：新增 `character_canvas_480p_v1`，正式画布为 854×480、24 fps；历史 `character_canvas_v1` 仅保留用于识别旧记录。生产配置若不是 480p 会 fail-closed，提示词分辨率与冻结模型分辨率不一致也会拒绝创建视频任务，不再发生“请求 480p、后处理放大到 720p”。
- 2026-08-13：新增迁移 `012_dual_character_masters.sql`，已在独立 PostgreSQL 18.4 空库中按 001–012 顺序真实执行成功，建立 39 张业务表；关键约束确认来源照只能 3–4 张、画布仅允许历史/480p 两个版本、提示词兼容 480p/历史 720p。真实数据库事务测试证明已付款订单会原子写入冻结模型版本、运行状态和仅含 ID 的 outbox 任务，重复回调不创建第二个运行记录。
- 2026-08-13：从恢复的三母图原文和老版稳定七动作派生 `docs/prompts/正式发布候选·三母图七动作·480p-v1.txt`。解析器确认恰好 3 个图片段和 7 个视频段，时长 4/6/6/7/4/6/7 秒；已去除第三方动画品牌、音频要求、720p/1280×720 遗留，保留老版动作节奏并加入睡眠单周期呼吸、固定镜头、身份花色和首尾静止约束。原始恢复文件未改写。
- 2026-08-13：本里程碑全量回归 53 个测试文件、708 项通过；新增后端合同测试 9 项及可选 PostgreSQL 集成测试 1 项，平台全部 JavaScript 语法检查通过；桌宠 Vite 与网站 Next.js 生产构建均成功。
- 2026-08-13：历史支付宝运行时代码已替换为 Kaipay 单一支付合同。开发模拟支付与真实 Kaipay provider 分离；生产 provider 只接受版本化 client / notification protocol，不猜测 API 调试器字段、签名、验签或回执。旧支付宝回调关闭，Kaipay 回调要求原始字节，并在服务端以 AES-256-GCM 加密留痕后通过主动查单二次确认。
- 2026-08-13：新增支付迁移 013/014，并在 PostgreSQL 18.4 两种路径真实验证：空库按 001–014 逐文件独立事务成功；升级库先写入历史 ALIPAY 未完成订单再执行 013/014，历史订单与空 adapter 记录保持可读，新 KAIPAY 记录必须携带 adapter version。Kaipay 持久化与生产工作流真库集成测试 2/2 通过。
- 2026-08-13：修复网站服务端网关路径错层，纯 `PETPACK_STUDIO_API_ORIGIN` 现在会把所有平台调用规范化为唯一 `/api/...`，已带前缀也不会重复；伪 origin（路径、凭据、查询或 hash）会 fail-closed。Web 聚焦测试 18 项及 Next.js 生产构建通过。
- 2026-08-13：补齐 COS 私有对象 `getPrivate`：服务器凭据 HEAD 后以 ETag 条件 GET 有界流式读取，校验 MIME、声明长度、实际传输长度与对象变化，不生成签名 URL；三个媒体 workspace 均可构造，聚焦测试 7/7 通过。
- 2026-08-13：新增单 BullMQ 队列统一 job router，完整白名单覆盖 15 个工作名；母图、视频与 PetPack 各自只进入对应 handler，`await-photos` 作为严格校验的幂等状态标记消费，未知任务 fail-closed。路由测试 19/19 通过。
- 2026-08-13：本轮全量回归 56 个测试文件、744 项通过、2 项 opt-in 数据库测试在常规命令中跳过且已单独在 PG18 真库通过；桌宠 Vite 生产构建（67 modules）及网站 Next.js 生产构建（21 routes）均成功。
- 2026-08-13：新增独立 outbox dispatcher、完整 Studio API 与统一 Studio Worker 运行时入口。API 在监听前强制确认业务数据库已到迁移 014；开发只绑定 loopback，生产才允许容器内部网。Worker 将三母图、七视频/后处理和 PetPack 四段流水线统一挂到单 BullMQ consumer，开发模式强制使用 fixture ModelArk，避免误调用真实付费 API；组件、数据库、队列与临时目录均 fail-closed 并支持安全关闭。
- 2026-08-13：新增 `INTEGRATION_GATES.md`，固定真实服务接入顺序及每一门需要向用户索取的精确资料：先零费用本地闭环，再 Kaipay 协议、ModelArk 小额分阶段验收、生产 COS、CloudBase 复核和最终发布；禁止在官方协议缺失时猜字段或自动无限付费重试。
- 2026-08-13：运行时里程碑完整回归 59 个测试文件、760 项通过，2 项 opt-in PostgreSQL 测试在新建隔离库 `petpack_runtime_20260813_1844` 中按 001–014 全迁移后 2/2 通过；测试数据库随后正常停机。桌宠 Vite 生产构建（67 modules）与网站 Next.js 生产构建（21 routes）均成功。
- 2026-08-13：建立只允许 development、loopback 与项目 `.tmp` 子目录的零费用多进程彩排。API、outbox dispatcher、单队列统一 Worker、PostgreSQL、TLS Redis、本地 HMAC 私有对象存储、模拟 Kaipay、fixture Seedream/Seedance、后处理、质检、打包与客户端导入均走真实运行时边界；所有生产密钥文件变量都会从子进程环境移除，任何非 loopback 网络请求 fail-closed。
- 2026-08-13：彩排先后发现并修复四个真实集成缺口：迁移 012 遗留的自动命名旧 CHECK 约束、BullMQ 安全 jobId 与业务原始 dedupeKey 不一致、母图完成器漏载冻结的 `model_registry_version`、以及 Worker 重启发生在供应商任务 ID 落库之前。新重启门只在 7 个 provider task ID 全部持久化且不存在 reconciliation 状态时开启，避免为了恢复测试而制造重复付费或未知订单。
- 2026-08-13：最新完整报告 `D:\PetPackStudio-Rebuild-20260813\.tmp\zero-cost-rehearsals\rehearsal-20260814031907-ffb0737a\report.json` 已通过硬断言：3 张来源照、3 张母图、7 个动作、12/12 份 QA、38/38 个执行任务、39/39 个 outbox、10 次 fixture provider usage、0 个未完成任务、0 个未发送 outbox、0 次外部调用；运行态为 `deliverable`，Worker 已安全重启一次，下载的 8 文件 PetPack 已被原版客户端 `importPetpack` 实际导入成功。
- 2026-08-13：Docker 仅复用隔离 Redis 容器 `petpack-rebuild-redis-20260813`；宿主挂载严格限定为项目 `.tmp\redis-rehearsal-20260813\data`（读写）和同级 `tls`（只读），没有挂载盘根、`D:\桌宠` 或项目根，也没有执行 prune、volume rm 或递归清理。Docker Desktop 数据仍位于 `D:\Docker\wsl`。
- 2026-08-13：本里程碑全量回归 67 个测试文件、790 项通过；两项 PostgreSQL opt-in 集成测试另在真实 PG18 隔离库 2/2 通过。桌宠 Vite 构建（67 modules）、落地页 Vite 构建（7 modules）和网站 Next.js 构建（21 routes）全部成功。
- 2026-08-13：零费用完整闭环提交为 `189f0564534dfd9bb09170519d46430d18143d1b`；完整 Git bundle 为 `C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-zero-cost-189f056.bundle`，27,330,171 字节，`git bundle verify` 通过，SHA-256 为 `4BFBC573C1F375D0F48C2143C27C32EDBFF193031AC09A86D2582FF39BFE7435`。
- 2026-08-13：生产 Worker 容器边界提交为 `9c7a2a6fc2fe32191218721dc432708a49a6d264`。新增仅在显式 `studio-production` profile 下启用的私有 outbox/Worker Compose：不发布宿主端口、不加入公网 edge 网络、不挂载宿主项目目录；使用外置精确 secret 文件、独立 PostgreSQL/Redis CA、只读根文件系统、非 root 用户、全部 capability 丢弃、`no-new-privileges`、资源上限、日志轮转和容器内心跳健康检查。
- 2026-08-13：基础运行时镜像 `petpack-platform-runtime:9c7a2a6` 已从固定 Node 22.22.2 builder 与固定 distroless runtime 构建，约 59 MB，本地镜像 ID 为 `sha256:a7cb0c3c155005de32240a45edd3ffe6d18ea21593935379bac724a93980494d`；最终镜像无 shell/npm，运行用户为 `10001:10001`，Docker Scout 当次结果为 0C/0H/0M/0L。
- 2026-08-13：媒体 Worker 镜像 `petpack-studio-worker:9c7a2a6` 约 163 MB，本地镜像 ID 为 `sha256:a8533e69938d3acd325b300dc15217df7756314f8de5ff3c51d05f913d394ef8`；最小化复制 FFmpeg/ffprobe 的实际动态依赖并写入 190 个包、210 个文件的运行时清单，隔离容器内已真实完成 VP9 WebM 编码和 ffprobe。Scout 当次同样报告 0 项，但人工清单仍包含 `libjxl0.7`，其未修复 jpeg-xl 高危通告按 fail-closed 继续作为正式上线阻塞，不能用 Scout 的零项结果覆盖人工审计。
- 2026-08-13：Dockerfile 静态检查无警告，生产 Compose 使用合成非秘密参数真实 `config --quiet` 解析通过；Docker/心跳/Compose 聚焦测试 25/25，通过后全量回归 71 个测试文件、804 项通过，2 项 opt-in 数据库测试按设计跳过。桌宠 Vite 构建（67 modules）、落地页 Vite 构建（7 modules）及网站 Next.js 构建（21 routes）全部成功。构建期间未执行 prune、volume rm 或递归删除，未挂载盘根、`D:\桌宠` 或项目根；此前安全检查留下的停止容器也未自动删除。
- 2026-08-13：容器加固里程碑完整 Git bundle 为 `C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-container-hardening-73a3985.bundle`，27,348,374 字节，包含至提交 `73a39857a5bd77f57c625001cf3511664b72ab1f` 的完整历史；`git bundle verify` 通过，SHA-256 为 `93376CD32ACB681610AA185A6A7B36F2F2FAF003714F09073E15D569D18EC177`。
- 2026-08-13：Lighthouse 数据层 TLS-only 加固提交为 `b4178cbba07009979d16ae99174299d837eae3de`。PostgreSQL 现在以受控 `pg_hba.conf` 先拒绝全部明文连接，再只允许 TLS 1.2+ 与 SCRAM；Redis 关闭明文端口、禁用默认用户，将应用身份限制在固定 key/channel 前缀并拒绝 `FLUSHALL` 等管理/破坏命令。PostgreSQL 与 Redis 使用独立 CA，CA 私钥不进入常驻容器；Compose 不发布数据库端口且强制使用 `repository@sha256` 镜像引用。
- 2026-08-13：真实 PostgreSQL 18.4 隔离演练报告为 `D:\PetPackStudio-Rebuild-20260813\.tmp\data-tls-rehearsals\data-tls-20260813215358-c5fbb3c7\report.json`：TLSv1.3 认证成功、明文连接被拒绝、001–014 正式迁移成功；额外 015 测试迁移由两个并发 runner 严格串行，恰好一次应用、一次识别为已应用。真实 Redis 隔离演练报告为 `D:\PetPackStudio-Rebuild-20260813\.tmp\data-redis-tls-rehearsals\redis-tls-20260813214958-b8568e64\report.json`：TLS 认证、明文拒绝、越界 key 拒绝及 `FLUSHALL` 拒绝全部通过，容器停止后保留供审计。
- 2026-08-13：数据层最终回归为 72 个测试文件、812 项通过，2 项 opt-in PostgreSQL 测试按设计跳过；Shell/PowerShell 语法、数据 Compose 解析、桌宠 Vite、落地页 Vite 和网站 Next.js 生产构建全部通过。该加固尚未部署 Lighthouse；本地 Redis 演练使用的 Alpine digest 只证明协议/ACL 功能，不能替代仍待选择和扫描的正式生产镜像。
- 2026-08-13：数据层加固里程碑完整 Git bundle 为 `C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-data-hardening-d5ef47b.bundle`，27,368,632 字节，包含至提交 `d5ef47b2034979685636bdd0cc8cf4a8620dc6b5` 的完整历史；`git bundle verify` 通过，SHA-256 为 `32AFE89200BC3C451D03FE4FD731D7D50ED08141215BA7F87BA5BDDA32A11DAA`。
- 2026-08-13：新增 PostgreSQL `sent` outbox 对账与确定性重放。只重放未终态运行中缺失、待处理、租约中或可重试的执行，复用原始稳定 job ID；已完成、死亡、需人工对账和 `await-photos` 状态标记不会被重新投递，持久 outbox 状态不会被改写。空 Redis 命名空间恢复报告为 `D:\PetPackStudio-Rebuild-20260813\.tmp\queue-loss-rehearsals\queue-loss-20260813221543-e3950069\report.json`：两个全新隔离命名空间均从 0 恢复为 1 个同哈希任务，没有执行 `FLUSHALL`、`FLUSHDB`、Docker 变更或宿主路径删除。
- 2026-08-13：PostgreSQL 短暂不可用现在统一归类为 `postgres_temporarily_unavailable`，通过 BullMQ delayed redelivery 延后 5 秒且不消耗业务 attempts；断连后的有毒连接会从 pool 销毁，idle client 的 pool error 也不再导致 Node 进程崩溃。视频、三母图和 PetPack 三条 Worker 链均保留该基础设施错误，不会误写成供应商状态未知或提前进入人工对账。
- 2026-08-13：真实 PostgreSQL 18.4 短断/恢复报告为 `D:\PetPackStudio-Rebuild-20260813\.tmp\data-tls-rehearsals\data-tls-20260813223221-8fc6fa7f\outage-control-052a0a75\report.json`：TLSv1.3 连接正常，使用该隔离实例自己的 `pg_ctl` 精确停启后观察到 3 次暂态失败并自动恢复，业务 attempts 消耗 0、外部供应商调用 0、Docker 变更 0、宿主路径删除 0；脚本只可终止自身持有的子进程对象，不按名称或裸 PID 扫描进程。
- 2026-08-13：故障恢复代码提交为 `5b9d51bb294b55d41ccf1e9a142c5c47adaf5d73`。最终全量回归为 76 个测试文件、834 项通过，2 项 opt-in PostgreSQL 测试按设计跳过；故障恢复聚焦测试 33/33、PowerShell 语法与 `git diff --check` 均通过。桌宠 Vite、落地页 Vite 和网站 Next.js 三项生产构建全部成功。
- 2026-08-13：故障恢复里程碑完整 Git bundle 为 `C:\testdisk\petpack-rebuild-git-backups\petpack-rebuild-fault-recovery-8a34c24.bundle`，27,390,163 字节，包含至提交 `8a34c24df0d73c9f5f775682ebadca07fed421ab` 的完整历史；`git bundle verify` 通过，SHA-256 为 `1C875F1DA042349121B0BBCCE0185BB2FE96B9FB1F907A0B3C59932AB92D342C`。

## In progress

- 从干净骨架重新开发；客户端、最新版网站、3–4 图/三母图/480p 合同、Kaipay 安全边界、Studio API/outbox/Worker、完整零费用多进程闭环、第一阶段生产容器边界、数据层 TLS-only、Redis 队列丢失重放及 PostgreSQL 短断恢复均已验证。当前继续做 API/outbox/Worker 精确硬中断恢复、生产视觉处理器/validator、正式镜像选型与真实供应商适配；真实付费能力和 `studio-production` profile 仍保持关闭，数据层新配置尚未部署 Lighthouse。

## Next

1. 在已通过 Redis 空队列重放与 PostgreSQL 短断恢复的基础上，继续做 API hard-kill、outbox 在 claim/enqueue 边界 hard-kill、Worker 活跃租约 hard-kill，以及 Redis AOF 保留重启；断言任务不丢失、不重复付费、不消耗等待旧租约的业务 attempts，并补队列积压/死信监控。
2. 选择并扫描正式 PostgreSQL 18 与 Redis 8 的不可变镜像 digest，准备应用端双 CA 切换和维护窗口；只在完整备份/恢复演练通过后将新的 TLS-only 数据配置部署到 Lighthouse。
3. 用不含 `libjxl` 的最小 FFmpeg 构建或已修复等价运行时替换当前媒体依赖，重新执行 SBOM/漏洞扫描和 VP9/alpha 实测；随后完成生产 delivery validator 镜像。
4. 完成来源照/母图/视频 processor 的生产 adapter、版本与证据 provenance，建立私有代表样本校准集；本地 fixture 证据不得用于生产放行。
5. 到达 `INTEGRATION_GATES.md` 第一项真实门槛时，向用户索取 Kaipay API 调试器协议资料并实现正式 wire adapter；之后才依次进行有费用上限的 ModelArk、COS、CloudBase 和最终上线验收。

## Working rules

- 每完成一个里程碑立即更新本文档并提交 Git。
- 每个里程碑生成新的 Git bundle，不覆盖旧 bundle；C 盘空间不足时使用依赖最近完整 bundle 的小型增量 bundle，并记录前置提交。
- 大型视频、模型输出、Docker 数据和用户媒体不提交 Git。
- 不写入或修改 E 盘 RAW；不删除旧 D 盘目录。
- 新代码仅位于 `D:\PetPackStudio-Rebuild-20260813`。
