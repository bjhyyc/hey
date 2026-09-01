# 客户端分发方案

产物:`dist/Hey Setup 1.0.0.exe`(约 105MB,NSIS 一键安装,x64)
SHA-256:`f3f4dac85df9b2f0767210fad73d564fa4eed274d60d4d10784f4f7837ca4c51`
品牌:productName `Hey`,appId `com.heyirmy.hey`,窗口标题/关于页均已品牌化。
未做代码签名(证书未购),Windows 首次运行会出 SmartScreen 提示;
下载页已如实向用户说明"更多信息 → 仍要运行"。购得证书后重打包即可去除。

## 推荐存放:腾讯 COS 独立公共读存储桶

现有业务桶是私有的(对象键强制 `private/` 前缀,签名 URL 访问),**不要**在
它上面开公共读——策略一错就把客户媒体暴露了。正确做法是同账号**新建一个
只放安装包的公共读桶**:

1. COS 控制台 → 创建存储桶:名称如 `hey-download-<APPID>`,地域与现有桶
   一致(广州/上海),**公共读私有写**。
2. 上传 `Hey Setup 1.0.0.exe`(控制台拖拽即可;建议对象键
   `client/Hey-Setup-1.0.0.exe`,避免空格进 URL)。
3. 可选:开启该桶的默认 CDN 加速域名,或绑定 `download.heyirmy.com`
   (CNAME 到 CDN),下载更快且省 COS 外网流量费。
4. 拿到最终下载 URL 后,把三个值配进 CloudBase 构建参数并重新构建 web:
   - `NEXT_PUBLIC_CLIENT_DOWNLOAD_URL` = 该 URL
   - `NEXT_PUBLIC_CLIENT_DOWNLOAD_SHA256` = 上方 SHA-256
   - `NEXT_PUBLIC_CLIENT_VERSION` = `1.0.0`
   下载页按钮随构建自动亮起(未配置时保持"准备后提供"占位,不会出死链)。

成本量级:COS 外网流出约 ¥0.5/GB → 每千次下载 ≈ ¥50;CDN 流量更低。
对当前体量完全可控。

## 不推荐的备选

- CloudBase 静态托管:可行但大文件回源与流量计费无优势,且与网站部署耦合。
- GitHub Releases:国内直连慢且不稳定,不适合面向客户分发。
- 网站容器内直接伺服:105MB 走 Next 容器纯浪费,伸缩与带宽都不合适。

## 版本更新流程(以后每次发新版)

1. `npm run build && npx electron-builder --win nsis`
   (打包后对 `dist/win-unpacked/Hey.exe` 补 rcedit 图标再
   `--prepackaged` 重打——无签名证书阶段的既定流程,见 PROGRESS 2026-09-01)。
2. 上传新文件到同一桶(**新对象键**带版本号,旧版本保留一段时间)。
3. 更新 CloudBase 三个构建参数,重新构建 web。
4. 旧版本对象设生命周期规则(如 90 天后删除)。
