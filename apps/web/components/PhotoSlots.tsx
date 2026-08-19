"use client";

import { useEffect, useState } from "react";
import {
  hasDuplicatePhotos,
  PHOTO_ACCEPT_ATTRIBUTE,
  PHOTO_SLOT_DEFINITIONS,
  type PhotoFileSlots,
  normalizePhotoFile,
  validatePhotoFile,
} from "@/lib/photo-slots";

export function PhotoSlots({
  value,
  onChange,
  onMessage,
  disabled = false,
}: {
  value: PhotoFileSlots;
  onChange: (photos: PhotoFileSlots) => void;
  onMessage?: (message: string) => void;
  disabled?: boolean;
}) {
  const [previews, setPreviews] = useState<Array<string | null>>([
    null,
    null,
    null,
    null,
  ]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const nextPreviews = value.map((file) =>
      file ? window.URL.createObjectURL(file) : null,
    );
    setPreviews(nextPreviews);
    return () => {
      nextPreviews.forEach((url) => url && window.URL.revokeObjectURL(url));
    };
  }, [value]);

  async function replacePhoto(index: number, file: File | null) {
    if (!file || disabled) return;
    const error = validatePhotoFile(file);
    if (error) return onMessage?.(error);
    setBusy(true);
    try {
      // Bring an oversized camera photo inside the processor's decode limit
      // before it is fingerprinted or uploaded.
      const normalized = await normalizePhotoFile(file);
      const next = [...value] as PhotoFileSlots;
      next[index] = normalized;
      if (await hasDuplicatePhotos(next.filter((item): item is File => Boolean(item)))) {
        onMessage?.("不能上传重复照片");
        return;
      }
      onChange(next);
      onMessage?.(`第 ${index + 1} 张照片已替换`);
    } catch {
      onMessage?.("无法读取照片");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="photo-slot-grid">
      {PHOTO_SLOT_DEFINITIONS.map((slot, index) => (
        <article className="photo-slot-wrapper" key={slot.id}>
          <label className={`photo-slot${value[index] ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}>
            {previews[index] ? (
              // Blob URLs intentionally use a native image element.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="photo-slot-preview" src={previews[index] ?? ""} alt="" />
            ) : null}
            <span className="slot-number">{String(index + 1).padStart(2, "0")}</span>
            <span className={`slot-need${slot.required ? "" : " is-optional"}`}>
              {slot.required ? "必选" : "可选"}
            </span>
            {previews[index] ? null : (
              <svg aria-hidden="true" className="slot-glyph" viewBox="0 0 24 24">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" />
              </svg>
            )}
            <strong>{slot.title}</strong>
            <small>{slot.hint}</small>
            <input
              type="file"
              accept={PHOTO_ACCEPT_ATTRIBUTE}
              disabled={disabled || busy}
              aria-label={`上传${slot.title}`}
              onChange={(event) => {
                void replacePhoto(index, event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          {value[index] ? (
            <button
              className="photo-slot-remove"
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                const next = [...value] as PhotoFileSlots;
                next[index] = null;
                onChange(next);
              }}
              aria-label={`删除${slot.title}`}
            >
              ×
            </button>
          ) : null}
        </article>
      ))}
    </div>
  );
}
