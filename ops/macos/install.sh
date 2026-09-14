#!/bin/bash

# Hey 一键安装脚本（macOS）
#
# 网站上给用户的是一行命令，它把这个脚本完整下载后再交给 bash 执行；
# 脚本按芯片下载对应的安装包，校验完整性，装到「应用程序」，
# 清除下载隔离属性并做本机签名，然后直接启动。
#
# 为什么要清隔离属性、做本机签名：安装包没有经过 Apple 的开发者签名与公证，
# 直接双击会被 macOS 拦下且无法从「系统设置」里放行。清除隔离属性后
# Gatekeeper 不再介入；Apple Silicon 要求任何可执行文件至少带本机签名，
# 所以再做一次 ad-hoc 签名。两步都只作用于 /Applications/Hey.app 本身。

set -eu

COS_BASE_URL="https://hey-download-1462360313.cos.ap-shanghai.myqcloud.com/client"
VERSION="1.0.0"

# 与网站下载页公示的校验值一致；改版本时两处同时更新。
SHA_ARM64="192b005d1a21d5c378ccf1c9d5e71eb700e4d1893e5a7ddd3b22a75b674762d5"
SHA_X64="89942b9c733f5289a82636003fa43cfaa48f1bab55f293fbd036e36c6a85f9e0"

APP_NAME="Hey.app"
INSTALL_PATH="/Applications/$APP_NAME"
TEMP_DIR="$(mktemp -d /tmp/hey-install.XXXXXX)"

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

echo "========================================="
echo "   Hey 桌宠 - 一键安装 v$VERSION"
echo "========================================="
echo ""

# 检测芯片。在 Rosetta 终端里 uname 会报 x86_64，所以先问硬件本身。
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    ZIP_NAME="Hey-$VERSION-arm64-mac.zip"
    EXPECTED_SHA="$SHA_ARM64"
    echo "✅ 检测到 Apple Silicon (M 系列芯片)"
elif [ "$(uname -m)" = "x86_64" ]; then
    ZIP_NAME="Hey-$VERSION-mac.zip"
    EXPECTED_SHA="$SHA_X64"
    echo "✅ 检测到 Intel Mac"
else
    echo "❌ 不支持的架构: $(uname -m)"
    exit 1
fi
echo ""

DOWNLOAD_URL="$COS_BASE_URL/$ZIP_NAME"
ZIP_PATH="$TEMP_DIR/$ZIP_NAME"

echo "📥 正在下载 $ZIP_NAME ..."
echo "   来源: $DOWNLOAD_URL"
echo ""
# -f：HTTP 出错（如 404）时报错退出，而不是把错误页当安装包存下来。
if ! curl -fL --progress-bar -o "$ZIP_PATH" "$DOWNLOAD_URL"; then
    echo ""
    echo "❌ 下载失败，请检查网络后重试"
    exit 1
fi
echo ""

echo "🔍 正在校验文件完整性..."
ACTUAL_SHA="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "❌ 文件校验失败，已停止安装（下载可能不完整或已被篡改）"
    echo "   期望: $EXPECTED_SHA"
    echo "   实际: $ACTUAL_SHA"
    exit 1
fi
echo "✅ 校验通过"
echo ""

echo "📦 正在解压..."
unzip -q "$ZIP_PATH" -d "$TEMP_DIR"
if [ ! -d "$TEMP_DIR/$APP_NAME" ]; then
    echo "❌ 安装包内容异常，未找到 $APP_NAME"
    exit 1
fi

if [ -d "$INSTALL_PATH" ]; then
    echo "⚠️  检测到已安装的 Hey，正在替换为新版本..."
    # 先请正在运行的旧版本退出；没在运行则忽略。
    osascript -e 'tell application "Hey" to quit' >/dev/null 2>&1 || true
    sleep 1
    rm -rf "$INSTALL_PATH"
fi

echo "📂 正在安装到 /Applications ..."
if ! cp -R "$TEMP_DIR/$APP_NAME" "$INSTALL_PATH"; then
    echo "❌ 安装失败：无法写入 /Applications（需要本机管理员账户）"
    exit 1
fi

echo "🔓 正在清除下载隔离属性..."
xattr -cr "$INSTALL_PATH"

echo "✍️  正在做本机签名..."
codesign --force --deep --sign - "$INSTALL_PATH" >/dev/null 2>&1

echo ""
echo "✅ 安装完成！正在启动 Hey ..."
sleep 1
open "$INSTALL_PATH"

echo ""
echo "🎉 Hey 已安装到「应用程序」，以后从启动台打开即可。"
echo ""
echo "如需卸载，执行："
echo "  rm -rf /Applications/Hey.app"
