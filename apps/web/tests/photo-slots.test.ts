import { describe, expect, it } from "vitest";
import {
  emptyPhotoSlots,
  hasDuplicatePhotos,
  PHOTO_SLOT_DEFINITIONS,
  photoSelectionMessage,
  photosReady,
  validatePhotoFile,
} from "@/lib/photo-slots";

function photo(name: string, contents = name, type = "image/jpeg") {
  return new File([contents], name, { type });
}

describe("photo slot contract", () => {
  it("requires two front photos and one 45 degree photo", () => {
    expect(PHOTO_SLOT_DEFINITIONS.map(({ label, required }) => ({ label, required }))).toEqual([
      { label: "正面 1", required: true },
      { label: "正面 2", required: true },
      { label: "45° 1", required: true },
      { label: "45° 2", required: false },
    ]);

    const slots = emptyPhotoSlots();
    expect(photosReady(slots)).toBe(false);
    expect(photoSelectionMessage(slots)).toBe("请上传第 1 张正面照");
    slots[0] = photo("front-1.jpg");
    expect(photoSelectionMessage(slots)).toBe("还差第 2 张正面照");
    slots[1] = photo("front-2.jpg");
    expect(photoSelectionMessage(slots)).toBe("还差 1 张侧面照");
    slots[2] = photo("angle.jpg");
    expect(photosReady(slots)).toBe(true);
    expect(photoSelectionMessage(slots)).toContain("可以开始制作");
  });

  it("accepts only JPG, PNG and WebP", () => {
    expect(validatePhotoFile(photo("pet.jpg"))).toBeNull();
    expect(validatePhotoFile(photo("pet.png", "png", "image/png"))).toBeNull();
    expect(validatePhotoFile(photo("pet.webp", "webp", "image/webp"))).toBeNull();
    expect(validatePhotoFile(photo("pet.heic", "heic", "image/heic"))).toBe(
      "仅支持 JPG、PNG 或 WebP",
    );
  });

  it("rejects duplicate bytes even when filenames differ", async () => {
    expect(await hasDuplicatePhotos([photo("one.jpg", "same"), photo("two.jpg", "same")])).toBe(true);
    expect(await hasDuplicatePhotos([photo("one.jpg", "one"), photo("two.jpg", "two")])).toBe(false);
  });
});
