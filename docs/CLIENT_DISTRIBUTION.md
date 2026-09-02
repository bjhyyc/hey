# 客户端分发方案

产物:`dist/Hey Setup 1.0.0.exe`(104741329 字节,NSIS 一键安装,x64)
上传用副本(去掉空格,与下载 URL 逐字一致):`dist/Hey-Setup-1.0.0.exe`
SHA-256:`89a676ebbe973949bf16fc7aeeb4c72ab450e3f92ee4ced176cca60bff60fc7c`
品牌:productName `Hey`,appId `com.heyirmy.hey`,窗口标题/关于页均已品牌化。
已验证(2026-09-02):静默安装 → `%LOCALAPPDATA%\Programs\hey-pet-client\Hey.exe`
(ProductName Hey 1.0.0)→ 启动窗口标题 Hey → 静默卸载退出码 0;asar 内容核对无误。
未做代码签名(证书未购),Windows 首次运行会出 SmartScreen 提示;
下载页已如实向用户说明"更多信息 → 仍要运行"。购得证书后重打包即可去除。

## 网站已烘焙的下载地址(必须逐字一致)

```
https://hey-download-1462360313.cos.ap-shanghai.myqcloud.com/client/Hey-Setup-1.0.0.exe
```

这三个值已写进 `apps/web/Dockerfile` 的 ARG 默认值(r38 起),打 zip 上传 CloudBase
即生效,**不需要**在 CloudBase 配任何构建参数:

- `NEXT_PUBLIC_CLIENT_DOWNLOAD_URL` = 上面的 URL
- `NEXT_PUBLIC_CLIENT_DOWNLOAD_SHA256` = `89a676eb…fc7c`
- `NEXT_PUBLIC_CLIENT_VERSION` = `1.0.0`

因此存储桶名、地域、对象键三者缺一不可:桶 `hey-download`(APPID 1462360313)、
地域 **上海 ap-shanghai**、对象键 `client/Hey-Setup-1.0.0.exe`。

## 上传教程(腾讯云 COS 控制台,约 5 分钟)

现有业务桶 `heyirmy-petpack-staging-1462360313` 是私有的(对象键强制 `private/`
前缀,签名 URL 访问),**不要**在它上面开公共读——策略一错就把客户媒体暴露了。
正确做法是同账号**新建一个只放安装包的公共读桶**:

1. 登录腾讯云控制台 → 对象存储 COS → 左侧「存储桶列表」→「创建存储桶」。
2. 填写:
   - 所属地域:**上海**(必须,URL 里是 `ap-shanghai`)
   - 名称:`hey-download`(控制台会自动拼成 `hey-download-1462360313`)
   - 访问权限:**公有读私有写**
   - 其余(版本控制、日志、加密等)保持默认关闭 → 下一步 → 创建。
3. 进入该桶 →「文件列表」→「创建文件夹」,名称 `client`。
4. 进入 `client` 文件夹 →「上传文件」→ 选择
   `D:\PetPackStudio-Rebuild-20260813\dist\Hey-Setup-1.0.0.exe`
   (用这个无空格副本,上传后对象键即为 `client/Hey-Setup-1.0.0.exe`)→ 上传。
   105MB 控制台直传大约 1–3 分钟。
5. 上传完成后点该文件 → 详情里的「对象地址」应与上面的烘焙 URL 完全一致。
6. 验证:在浏览器打开该 URL 应直接开始下载;下载完在 PowerShell 校验:
   ```
   Get-FileHash "$env:USERPROFILE\Downloads\Hey-Setup-1.0.0.exe" -Algorithm SHA256
   ```
   哈希应为 `89A676EBBE973949BF16FC7AEEB4C72AB450E3F92EE4CED176CCA60BFF60FC7C`。
7. (可选,建议上线后再做)该桶「域名与传输管理」→ 开启默认 CDN 加速域名,
   或绑定 `download.heyirmy.com`(CNAME 到 CDN)。届时把 Dockerfile 里的
   `NEXT_PUBLIC_CLIENT_DOWNLOAD_URL` 默认值改为新域名并重新打包 web 即可。

成本量级:COS 外网流出约 ¥0.5/GB → 每千次下载 ≈ ¥50;CDN 流量更低。
对当前体量完全可控。不需要开防盗链(安装包本来就是公开分发)。

## 不推荐的备选

- CloudBase 静态托管:可行但大文件回源与流量计费无优势,且与网站部署耦合。
- GitHub Releases:国内直连慢且不稳定,不适合面向客户分发。
- 网站容器内直接伺服:105MB 走 Next 容器纯浪费,伸缩与带宽都不合适。

## 版本更新流程(以后每次发新版)

1. `npm run build && npx electron-builder --win nsis`
   (打包后对 `dist/win-unpacked/Hey.exe` 补 rcedit 图标再
   `--prepackaged` 重打——无签名证书阶段的既定流程,见 PROGRESS 2026-09-01)。
2. 复制一份无空格文件名(`Hey-Setup-<版本>.exe`),上传到同一桶的 `client/` 下
   (**新对象键**带版本号,旧版本保留一段时间)。
3. 更新 Dockerfile 三个 ARG 默认值(URL / SHA-256 / 版本号),重新打 zip 部署 web。
4. 旧版本对象设生命周期规则(如 90 天后删除)。
