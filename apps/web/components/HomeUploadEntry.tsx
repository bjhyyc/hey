"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  clearHomePhotoDraft,
  loadHomePhotoDraft,
  saveHomePhotoDraft,
} from "@/lib/home-photo-draft";
import {
  runPhotoPrecheck,
  savePrecheckPass,
  type PrecheckVerdict,
} from "@/lib/photo-precheck";
import {
  availablePhotoSlotIndexes,
  emptyPhotoSlots,
  hasDuplicatePhotos,
  normalizePhotoFile,
  PHOTO_ACCEPT_ATTRIBUTE,
  PHOTO_SLOT_DEFINITIONS,
  photoSelectionMessage,
  photosReady,
  selectedPhotoCount,
  type PetSpecies,
  type PhotoFileSlots,
  validatePhotoFile,
} from "@/lib/photo-slots";

function PawIcon({ kind }: { kind: PetSpecies }) {
  return (
    <svg className="home-model-icon" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "dog" ? (
        <>
          <ellipse cx="5.8" cy="7.5" rx="2.3" ry="2.7" transform="rotate(-24 5.8 7.5)" />
          <ellipse cx="10.3" cy="5.5" rx="2.2" ry="2.7" transform="rotate(-7 10.3 5.5)" />
          <ellipse cx="15" cy="5.9" rx="2.2" ry="2.7" transform="rotate(9 15 5.9)" />
          <ellipse cx="18.7" cy="8.5" rx="2.2" ry="2.6" transform="rotate(25 18.7 8.5)" />
          <path d="M6.1 16.3c0-3.3 2.5-5.7 5.9-5.7s5.9 2.4 5.9 5.7c0 2.2-1.5 3.6-3.5 3.6-.9 0-1.6-.5-2.4-.5s-1.5.5-2.4.5c-2 0-3.5-1.4-3.5-3.6Z" />
        </>
      ) : (
        <>
          <circle cx="6.4" cy="7.5" r="2" />
          <circle cx="10.4" cy="5.6" r="2" />
          <circle cx="14.7" cy="5.8" r="2" />
          <circle cx="18" cy="8.4" r="1.9" />
          <path d="M7 15.7c0-3 2.1-5.1 5-5.1s5 2.1 5 5.1c0 2-1.4 3.3-3.1 3.3-.7 0-1.3-.4-1.9-.4s-1.2.4-1.9.4C8.4 19 7 17.7 7 15.7Z" />
        </>
      )}
    </svg>
  );
}

export function HomeUploadEntry() {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [species, setSpecies] = useState<PetSpecies>("dog");
  const [photos, setPhotos] = useState<PhotoFileSlots>(emptyPhotoSlots);
  const [previews, setPreviews] = useState<Array<string | null>>([
    null,
    null,
    null,
    null,
  ]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [precheckVerdicts, setPrecheckVerdicts] = useState<PrecheckVerdict[] | null>(null);
  // Anything the pre-check has to say must be readable before the customer pays.
  // Holding only for set-level warnings still let a per-photo one flash past on
  // the way to checkout, which is no warning at all.
  const [heldNotices, setHeldNotices] = useState<string[] | null>(null);
  const count = selectedPhotoCount(photos);
  const ready = photosReady(photos);

  useEffect(() => {
    let active = true;
    loadHomePhotoDraft()
      .then((draft) => {
        if (active && draft) {
          setPhotos(draft.photos);
          setSpecies(draft.species);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const urls = photos.map((file) =>
      file ? window.URL.createObjectURL(file) : null,
    );
    setPreviews(urls);
    return () => urls.forEach((url) => url && window.URL.revokeObjectURL(url));
  }, [photos]);

  // A different set has not been judged yet: whatever was on screen belongs to
  // the photographs that are gone, and the next verdict has to be read afresh.
  useEffect(() => {
    setHeldNotices(null);
    setPrecheckVerdicts(null);
  }, [photos, species]);

  async function persist(next: PhotoFileSlots, nextSpecies = species) {
    if (next.some(Boolean)) await saveHomePhotoDraft(next, nextSpecies);
    else await clearHomePhotoDraft();
  }

  async function addPhotos(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    const available = availablePhotoSlotIndexes(photos);
    if (selected.length > available.length) {
      setMessage(`最多上传 4 张，还可添加 ${available.length} 张`);
      return;
    }
    const validation = selected.map(validatePhotoFile).find(Boolean);
    if (validation) return setMessage(validation);
    setBusy(true);
    try {
      const normalized = await Promise.all(selected.map(normalizePhotoFile));
      const next = [...photos] as PhotoFileSlots;
      normalized.forEach((file, index) => {
        next[available[index]] = file;
      });
      if (await hasDuplicatePhotos(next.filter((file): file is File => Boolean(file)))) {
        setMessage("不能上传重复照片");
        return;
      }
      await persist(next);
      setPhotos(next);
      setMessage(photoSelectionMessage(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法保存照片");
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(index: number) {
    const next = [...photos] as PhotoFileSlots;
    next[index] = null;
    setBusy(true);
    try {
      await persist(next);
      setPhotos(next);
      setMessage(next.some(Boolean) ? photoSelectionMessage(next) : "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法删除照片");
    } finally {
      setBusy(false);
    }
  }

  async function replacePhoto(index: number, file: File | null) {
    if (!file) return;
    const validation = validatePhotoFile(file);
    if (validation) return setMessage(validation);
    setBusy(true);
    try {
      const next = [...photos] as PhotoFileSlots;
      // The initial selection downscales every file; replacing one used to
      // store the raw original, so an oversized photograph could pass the
      // pre-check and the payment and only fail later, during generation.
      next[index] = await normalizePhotoFile(file);
      if (await hasDuplicatePhotos(next.filter((item): item is File => Boolean(item)))) {
        setMessage("不能上传重复照片");
        return;
      }
      await persist(next);
      setPhotos(next);
      setMessage(`第 ${index + 1} 张照片已替换`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法替换照片");
    } finally {
      setBusy(false);
    }
  }

  async function updateSpecies(nextSpecies: PetSpecies) {
    setSpecies(nextSpecies);
    if (photos.some(Boolean)) {
      await persist(photos, nextSpecies).catch(() => undefined);
    }
  }

  async function startMaking() {
    if (!ready || busy) {
      setMessage(photoSelectionMessage(photos));
      return;
    }
    setBusy(true);
    setPrecheckVerdicts(null);
    setMessage("正在预检照片，通常几秒完成…");
    try {
      const result = await runPhotoPrecheck(species, photos);
      setPrecheckVerdicts(result.verdicts);
      if (!result.passed) {
        const failed = result.verdicts.filter((verdict) => !verdict.ok);
        const speciesOnly = failed.length > 0 &&
          failed.every((verdict) => verdict.reasons.some((reason) => reason.includes("种类")));
        setMessage(speciesOnly
          ? `看起来不是${species === "dog" ? "狗" : "猫"}，请先改正上方的宠物种类再试`
          : result.setReasons.length > 0
            ? result.setReasons.join("；")
            : "部分照片未通过预检，请按提示更换后重试");
        return;
      }
      savePrecheckPass({
        precheckId: result.precheckId,
        species,
        photoSha256s: result.photoSha256s,
        checkedAt: Date.now(),
      });
      const notices = [
        ...(result.setWarnings ?? []),
        ...result.verdicts.flatMap((verdict) => {
          const label = PHOTO_SLOT_DEFINITIONS[verdict.ordinal - 1]?.label ?? `第 ${verdict.ordinal} 张`;
          return (verdict.warnings ?? []).map((warning) => `${label}：${warning}`);
        })
      ];
      if (notices.length > 0 && !heldNotices) {
        setHeldNotices(notices);
        setMessage("这组照片可以用，但有几点想先让你知道");
        return;
      }
      router.push("/projects/new");
    } catch (error) {
      const text = error instanceof Error ? error.message : "预检失败，请稍后重试";
      setMessage(text);
      if (/登录/.test(text)) router.push("/login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="home-minimal-shell" aria-labelledby="home-greeting" id="start">
      <div className="home-center">
        <h1 id="home-greeting" lang="en">Hey, I Really Miss You.</h1>
        <p className="home-promise"><span>把思念带回桌面</span></p>
        <section
          className="home-upload"
          aria-label="上传两张正面照和一至两张侧面照并开始制作"
        >
        <div className={`home-upload-copy${count > 0 ? " has-photos" : ""}`}>
          {count > 0 ? (
            <span className="home-photo-thumbnails" aria-label={`已选择 ${count} 张照片`}>
              {previews.map((preview, index) =>
                preview ? (
                  <span className="home-photo-thumbnail" key={PHOTO_SLOT_DEFINITIONS[index].id}>
                    {/* Blob URLs intentionally use native images. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt={`已选择的宠物照片 ${index + 1}`} src={preview} />
                    <b aria-hidden="true">{PHOTO_SLOT_DEFINITIONS[index].label}</b>
                    <label className="home-photo-replace-control" title={`替换第 ${index + 1} 张照片`}>
                      <input
                        type="file"
                        accept={PHOTO_ACCEPT_ATTRIBUTE}
                        aria-label={`替换第 ${index + 1} 张照片`}
                        disabled={busy}
                        onChange={(event) => {
                          void replacePhoto(index, event.target.files?.[0] ?? null);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    <button
                      className="home-photo-remove"
                      type="button"
                      disabled={busy}
                      onClick={() => void removePhoto(index)}
                      aria-label={`删除第 ${index + 1} 张照片`}
                    >
                      ×
                    </button>
                  </span>
                ) : null,
              )}
            </span>
          ) : null}
          <span className="home-upload-copy-text">
            <strong>{count > 0 ? `已选择 ${count} 张照片` : "上传 2 张正面照 + 1~2 张侧面照"}</strong>
            <small>{message || (count > 0 ? photos.filter(Boolean).map((file) => file?.name).join(" · ") : "两张正面照必选，侧面照至少一张；请选同一时期、最像它平时的样子")}</small>
            <span className="home-upload-slot-guide" aria-label="照片槽位要求">
              {PHOTO_SLOT_DEFINITIONS.map((slot, index) => (
                <i className={photos[index] ? "is-filled" : ""} key={slot.id}>
                  {slot.label} · {slot.required ? "必选" : "可选"}
                </i>
              ))}
            </span>
            {heldNotices ? (
              <span className="home-precheck-setwarn">
                {heldNotices.map((notice, index) => <i key={index}>{notice}</i>)}
              </span>
            ) : null}
            {precheckVerdicts ? (
              <span className="home-precheck-verdicts" aria-label="预检结果">
                {precheckVerdicts.map((verdict) => {
                  const label = PHOTO_SLOT_DEFINITIONS[verdict.ordinal - 1]?.label ?? `第 ${verdict.ordinal} 张`;
                  if (!verdict.ok) return <i className="is-bad" key={verdict.ordinal}>{label} ✕ {verdict.reasons.join("；")}</i>;
                  if (verdict.warnings?.length) return <i className="is-warn" key={verdict.ordinal}>{label} ! {verdict.warnings.join("；")}</i>;
                  return <i className="is-ok" key={verdict.ordinal}>{label} ✓</i>;
                })}
              </span>
            ) : null}
          </span>
        </div>
        <div className="home-upload-controls">
          <span className="home-upload-tools">
            <input
              ref={picker}
              className="home-upload-file"
              type="file"
              accept={PHOTO_ACCEPT_ATTRIBUTE}
              multiple
              onChange={(event) => {
                void addPhotos(event.target.files);
                event.currentTarget.value = "";
              }}
            />
            <button className="home-upload-icon" disabled={busy} onClick={() => picker.current?.click()} type="button" aria-label="继续添加宠物照片">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" /></svg>
              <span className="home-upload-count">{count === 4 ? "✓" : count || "3+"}</span>
            </button>
            <span aria-label="宠物种类" className="species-switch home-species-switch" role="radiogroup">
              <button
                aria-checked={species === "dog"}
                className={species === "dog" ? "active" : undefined}
                disabled={busy}
                onClick={() => void updateSpecies("dog")}
                role="radio"
                type="button"
              >狗</button>
              <button
                aria-checked={species === "cat"}
                className={species === "cat" ? "active" : undefined}
                disabled={busy}
                onClick={() => void updateSpecies("cat")}
                role="radio"
                type="button"
              >猫</button>
            </span>
          </span>
          <span className="home-upload-right">
            {/* Named on purpose: the owner treats the models as a credibility
                signal on the front page and accepts that it tells a competitor
                which models to reach for. Everything about HOW they are used -
                the prompts, the stage pipeline, the quality gates - stays
                private, which is where the actual know-how lives. */}
            <span className="home-models" aria-label="使用模型">
              <span className="home-model-tag"><PawIcon kind="cat" />Seedream 5.0 Pro</span>
              <span className="home-model-tag"><PawIcon kind="dog" />Seedance 2.0</span>
            </span>
            <button className="home-upload-action" disabled={!ready || busy} onClick={() => void startMaking()} type="button">
              <svg className="home-spark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8c.8 4.7 2.5 6.4 7.2 7.2-4.7.8-6.4 2.5-7.2 7.2-.8-4.7-2.5-6.4-7.2-7.2 4.7-.8 6.4-2.5 7.2-7.2Z" /><path d="M19.1 15.4c.3 1.9 1.1 2.7 3 3-1.9.3-2.7 1.1-3 3-.3-1.9-1.1-2.7-3-3 1.9-.3 2.7-1.1 3-3Z" /></svg>
              <span>{busy ? "预检中…" : heldNotices ? "仍用这组继续" : "开始制作"}</span>
            </button>
          </span>
        </div>
        </section>
        {/* The one thing a hesitating visitor wants before handing over a
            photograph: how many steps this is and how long it takes. */}
        {/* Same-page anchor: the flow is the screen directly below. */}
        <a className="home-flow-button" href="#flow">
          点击查看制作流程：5 步，约 20 分钟
        </a>
      </div>
    </section>
  );
}
