# 后端源码恢复来源（2026-08-13）

本检查点用于记录误删事故后后端骨架的可验证来源。它不是“已完成生产上线”的声明。

## 服务器基线

- 来源：Lighthouse `ubuntu@106.54.227.218:/tmp/petpack-release-6f5434b.tar.gz`
- 大小：232,832 字节
- SHA-256：`92399017B6DEE80A436061DB054983EC673D63B9CB29D4FB0E90FCD7198301B9`
- 原始内容：`platform/`、`src/shared/`、`ops/lighthouse/` 与 `.gitattributes`
- 安全检查：gzip 完整；142 个条目；无绝对路径、`..`、符号链接或设备文件。

## 已验收的短信登录增量

服务器当前发布目录为 `platform-authfix-6625de0c`。只从该目录白名单复制以下四个源码/配置文件，未复制 `.env`、`secrets/`、证书或密钥：

| 文件 | SHA-256 |
| --- | --- |
| `platform/src/http/petpack-studio-http-api.js` | `986AC4E41EBEC60F61A51FDDFC465A6D35BF38F7229B08A29183112AF1FCB193` |
| `platform/src/runtime/create-production-auth-api.js` | `60571F2A9FC7DDEC67DC7467DA13042E3A10EE71837D2D231874177C6D2EC424` |
| `platform/src/providers/tencent-cloudbase-identity-verifier.js` | `6625DE0C2B17F36279E5B6B7B328C1E121E6848B7FF213EE97436F427FCD4C0C` |
| `ops/lighthouse/app/compose.yaml` | `20048636655646A36F642D3305669A01828E330591DD98D8C7EAA65CA7D76D81` |

恢复目录 `recovery-inputs/`、依赖目录和运行临时目录均被 Git 忽略。源码扫描未发现私钥头、腾讯云 SecretId 或阿里云 AccessKey 形式的值。

## 本地兼容修复

- 统一 Studio 行为阈值为 22 秒入睡、2 秒悬停和 20 秒同事件冷却。
- 客户端会把经过 manifest validator 校验的 `studioBehavior` 转为六条通用运行时规则。
- 新增真实跨层测试：由 `platform/src/petpack/build.js` 生成 manifest，再交给客户端 `buildRuntimeModel` 与 `createRuleRuntime` 验证六种交互。
- 旧 PetPack 没有 `studioBehavior` 时继续读取原有 `triggerRules`，不改变旧包运行方式。

## 尚未恢复/升级

- 网站 `code.zip` 未在本机或 Lighthouse 找到；网站将根据线上契约与补丁证据重建。
- 此基线仍包含历史支付宝、720p 和两张来源照语义；它们必须分别升级为 Kaipay、480p 和 3–4 张照片合同后才能作为当前生产代码。
- 真实视觉处理器、ModelArk 生产参数、支付生产验收和基础设施验收仍以 `BLOCKED.md` 为准。
