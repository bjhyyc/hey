export const PHOTO_SLOT_IDS = [
  "front-primary",
  "front-secondary",
  "three-quarter-primary",
  "three-quarter-secondary",
] as const;

export type PhotoSlotId = (typeof PHOTO_SLOT_IDS)[number];
export type PetSpecies = "dog" | "cat";
export type PhotoFileSlots = [File | null, File | null, File | null, File | null];

export type PhotoSlotDefinition = {
  id: PhotoSlotId;
  label: string;
  title: string;
  hint: string;
  required: boolean;
};

export const PHOTO_SLOT_DEFINITIONS: readonly PhotoSlotDefinition[] = [
  {
    id: "front-primary",
    label: "正面 1",
    title: "第 1 张正面照",
    hint: "同一时期、你最熟悉的样子，五官看得清",
    required: true,
  },
  {
    id: "front-secondary",
    label: "正面 2",
    title: "第 2 张正面照",
    hint: "换一张正面，和上一张同一时期",
    required: true,
  },
  {
    id: "three-quarter-primary",
    label: "侧面 1",
    title: "第 1 张侧面照",
    hint: "看得到身体侧面花色、尾巴形状",
    required: true,
  },
  {
    id: "three-quarter-secondary",
    label: "侧面 2",
    title: "第 2 张侧面照",
    hint: "可选，花色左右不对称的宠物建议补另一侧",
    required: false,
  },
] as const;

export const ACCEPTED_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const ACCEPTED_PHOTO_TYPE_SET = new Set<string>(ACCEPTED_PHOTO_TYPES);
export const PHOTO_ACCEPT_ATTRIBUTE =
  "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export function emptyPhotoSlots(): PhotoFileSlots {
  return [null, null, null, null];
}

export function selectedPhotoCount(photos: PhotoFileSlots): number {
  return photos.filter(Boolean).length;
}

export function photosReady(photos: PhotoFileSlots): boolean {
  return Boolean(photos[0] && photos[1] && photos[2]);
}

export function photoSelectionMessage(photos: PhotoFileSlots): string {
  if (!photos[0]) return "请上传第 1 张正面照";
  if (!photos[1]) return "还差第 2 张正面照";
  if (!photos[2]) return "还差 1 张侧面照";
  if (!photos[3]) return "可以开始制作，也可再补 1 张另一侧 45°";
  return "两张正面照和两张 45° 照已选好";
}

export function validatePhotoFile(file: File): string | null {
  if (!ACCEPTED_PHOTO_TYPE_SET.has(file.type.toLowerCase())) {
    return "仅支持 JPG、PNG 或 WebP";
  }
  if (file.size <= 0) return "这张照片无法读取，请换一张";
  if (file.size > MAX_PHOTO_BYTES) return "单张照片不能超过 20 MB";
  return null;
}

// The master-image processor refuses any reference whose decoded edge exceeds
// 4096px, and a modern phone camera clears that easily. Nothing upstream used
// to look at pixel dimensions - only at the 20MB file size - so an oversized
// photograph sailed through selection, through the pre-check, through payment,
// and then killed master generation with three dead retries on a paid order.
// Bring the file inside the limit here, before it becomes anything else, so the
// pre-check and the upload both see the same bytes.
const MAX_UPLOAD_EDGE = 4000;
const NORMALIZED_JPEG_QUALITY = 0.92;

export async function normalizePhotoFile(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    if (longestEdge <= MAX_UPLOAD_EDGE) return file;
    const scale = MAX_UPLOAD_EDGE / longestEdge;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/jpeg", NORMALIZED_JPEG_QUALITY);
    });
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

export async function fingerprintPhoto(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hasDuplicatePhotos(files: readonly File[]): Promise<boolean> {
  const fingerprints = await Promise.all(files.map(fingerprintPhoto));
  return new Set(fingerprints).size !== fingerprints.length;
}

export function availablePhotoSlotIndexes(photos: PhotoFileSlots): number[] {
  return photos.flatMap((photo, index) => (photo ? [] : [index]));
}
