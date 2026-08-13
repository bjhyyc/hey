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
    title: "第 1 张正面全身照",
    hint: "清晰正面，宠物全身完整",
    required: true,
  },
  {
    id: "front-secondary",
    label: "正面 2",
    title: "第 2 张正面全身照",
    hint: "换一张正面照，宠物全身完整",
    required: true,
  },
  {
    id: "three-quarter-primary",
    label: "45° 1",
    title: "第 1 张 45° 全身照",
    hint: "约 45°，不用完全侧身",
    required: true,
  },
  {
    id: "three-quarter-secondary",
    label: "45° 2",
    title: "第 2 张 45° 全身照",
    hint: "可选，另一侧有助于还原花色",
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
  if (!photos[0]) return "请上传第 1 张正面全身照";
  if (!photos[1]) return "还差第 2 张正面全身照";
  if (!photos[2]) return "还差 1 张 45° 全身照";
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
