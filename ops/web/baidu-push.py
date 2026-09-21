#!/usr/bin/env python3
"""Pushes the site's public URLs to Baidu 站长平台's API 提交 endpoint.

Baidu does not open its sitemap tool to every site, but the push API is
available from day one and is what it recommends: each call submits a list
of URLs and returns how many it accepted and how much of the daily quota is
left. The URL list is the live sitemap, so this never drifts from what the
site actually publishes.

    BAIDU_PUSH_TOKEN=<token from 普通收录 → API提交> python ops/web/baidu-push.py

The token is a credential; it is read from the environment and never stored.
"""
import json
import os
import re
import sys
import urllib.request

SITE = "https://www.heyirmy.com"


def main():
    token = os.environ.get("BAIDU_PUSH_TOKEN", "").strip()
    if not token:
        raise SystemExit("set BAIDU_PUSH_TOKEN (from 百度站长平台 → 普通收录 → API提交 → 接口调用地址)")
    sitemap = urllib.request.urlopen(f"{SITE}/sitemap.xml", timeout=30).read().decode("utf-8")
    urls = re.findall(r"<loc>([^<]+)</loc>", sitemap)
    if not urls:
        raise SystemExit("the live sitemap lists no URLs")
    body = "\n".join(urls).encode("utf-8")
    request = urllib.request.Request(
        f"http://data.zz.baidu.com/urls?site={SITE}&token={token}",
        data=body,
        headers={"Content-Type": "text/plain"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        result = json.loads(error.read().decode("utf-8", "replace") or "{}")
        result.setdefault("http_status", error.code)
    print(json.dumps({"submitted": len(urls), "urls": urls, "baidu": result}, ensure_ascii=False, indent=2))
    if "success" not in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
