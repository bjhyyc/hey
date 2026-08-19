"use client";

import { useEffect, useState } from "react";
import { clearHomePhotoDraft, loadHomePhotoDraft } from "@/lib/home-photo-draft";
import { emptyPhotoSlots, photosReady, type PhotoFileSlots } from "@/lib/photo-slots";
import { studioBrowserApi } from "@/lib/studio-browser-api";
import { PhotoSlots } from "./PhotoSlots";

async function sha256(file: File) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function PhotoUploadWorkflow({ projectId }: { projectId: string }) {
  const [photos, setPhotos] = useState<PhotoFileSlots>(emptyPhotoSlots);
  const [message, setMessage] = useState("请准备两张正面照和至少一张 45° 照");
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadHomePhotoDraft().then((draft) => draft && setPhotos(draft.photos)).catch(() => undefined); }, []);

  async function upload() {
    if (!photosReady(photos)) return setMessage("还需要两张正面照和至少一张 45° 照");
    setBusy(true);
    try {
      const selected = photos.filter((file): file is File => Boolean(file));
      const metadata = await Promise.all(selected.map(async (file) => ({
        contentType: file.type,
        sha256: await sha256(file),
        byteSize: file.size,
      })));
      const grants = await studioBrowserApi.uploadGrants(projectId, metadata);
      if (grants.length !== selected.length) throw new Error("上传授权不完整，请稍后重试");
      await Promise.all(grants.map(async (grant, index) => {
        const response = await fetch(grant.uploadUrl, { method: "PUT", headers: { "content-type": selected[index].type }, body: selected[index] });
        if (!response.ok) throw new Error(`第 ${index + 1} 张照片上传失败`);
        // The confirmation endpoint accepts exactly {sha256, byteSize}; contentType
        // belongs to the upload grant only, and sending it is rejected outright.
        await studioBrowserApi.confirmPhoto(projectId, grant.ordinal, {
          sha256: metadata[index].sha256,
          byteSize: metadata[index].byteSize,
        });
      }));
      await clearHomePhotoDraft().catch(() => undefined);
      window.location.assign(`/projects/${encodeURIComponent(projectId)}/character`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "照片上传失败，请稍后重试");
      setBusy(false);
    }
  }

  return <section className="workflow-card">
    <div className="workflow-notice">
      <p><strong>照片质量在很大程度上决定成品质量</strong>，请认真挑选：光线清楚、五官看得清、没有其他人或宠物入镜。姿势随意，尾巴四肢没入镜没关系。</p>
      <p>45° 照片尽量把花色拍全，<strong>花色左右不对称的宠物</strong>（三花、玳瑁、花斑）尤其重要，否则背对镜头的那一侧只能靠猜。</p>
    </div>
    <PhotoSlots value={photos} onChange={setPhotos} onMessage={setMessage} disabled={busy} />
    <button className="primary-button form-submit" disabled={busy} onClick={() => void upload()} type="button">
      {busy ? "正在上传…" : "确认照片"}
    </button>
    <p className="form-message" aria-live="polite">{message}</p>
  </section>;
}
