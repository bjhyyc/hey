import { browserStudioRequest } from "./studio-gateway-core";
import { fingerprintPhoto, type PetSpecies, type PhotoFileSlots } from "./photo-slots";

export type PrecheckVerdict = {
  ordinal: number;
  ok: boolean;
  reasons: string[];
};

export type PrecheckResult = {
  precheckId: string;
  passed: boolean;
  samePet: boolean;
  verdicts: PrecheckVerdict[];
  setReasons: string[];
  remainingToday?: number;
};

// The stored pass, kept alongside the photo draft so /projects/new can attach
// it to checkout. Bound to the exact photo set via the original-file digests.
export type PrecheckPass = {
  precheckId: string;
  species: PetSpecies;
  photoSha256s: string[];
  checkedAt: number;
};

const PRECHECK_MAX_EDGE = 1000;
const PRECHECK_JPEG_QUALITY = 0.8;

async function downscaleToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, PRECHECK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理照片，请更换浏览器重试");
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", PRECHECK_JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

/**
 * Runs the vision pre-check on the selected photos. Downscaled copies travel to
 * the server; original files never leave the browser before payment.
 */
export async function runPhotoPrecheck(
  species: PetSpecies,
  photos: PhotoFileSlots,
): Promise<PrecheckResult & { photoSha256s: string[] }> {
  const files = photos.filter((file): file is File => Boolean(file));
  if (files.length < 3) throw new Error("请先补齐三张必需照片");
  const payload = [];
  const photoSha256s: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const [dataUrl, sha256] = await Promise.all([
      downscaleToDataUrl(files[index]),
      fingerprintPhoto(files[index]),
    ]);
    photoSha256s.push(sha256);
    payload.push({ ordinal: index + 1, originalSha256: sha256, dataUrl });
  }
  const result = await browserStudioRequest<PrecheckResult>("photo-precheck", {
    method: "POST",
    body: JSON.stringify({ species, photos: payload }),
  });
  return { ...result, photoSha256s };
}

export function precheckPassCoversPhotos(
  pass: PrecheckPass | null | undefined,
  species: PetSpecies,
  photoSha256s: string[],
): boolean {
  if (!pass || pass.species !== species) return false;
  if (Date.now() - pass.checkedAt > 23 * 60 * 60 * 1000) return false;
  const stored = [...pass.photoSha256s].sort().join(",");
  const current = [...photoSha256s].sort().join(",");
  return stored === current && stored.length > 0;
}

const PRECHECK_PASS_KEY = "petpack-precheck-pass";

export function savePrecheckPass(pass: PrecheckPass): void {
  try {
    window.localStorage.setItem(PRECHECK_PASS_KEY, JSON.stringify(pass));
  } catch {
    // Private mode without storage: checkout falls back to server-side verdict.
  }
}

export function loadPrecheckPass(): PrecheckPass | null {
  try {
    const raw = window.localStorage.getItem(PRECHECK_PASS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrecheckPass;
    if (typeof parsed?.precheckId !== "string" || !Array.isArray(parsed.photoSha256s)) return null;
    return parsed;
  } catch {
    return null;
  }
}
