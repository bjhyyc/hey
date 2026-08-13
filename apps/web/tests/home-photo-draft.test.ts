import { describe, expect, it } from "vitest";
import {
  HOME_DRAFT_DATABASE,
  HOME_DRAFT_KEY,
  HOME_DRAFT_STORE,
  HOME_DRAFT_TTL_MS,
} from "@/lib/home-photo-draft";

describe("local home draft contract", () => {
  it("uses the recovered IndexedDB identity and expires after 24 hours", () => {
    expect(HOME_DRAFT_DATABASE).toBe("petpack-studio-local-drafts");
    expect(HOME_DRAFT_STORE).toBe("photo-drafts");
    expect(HOME_DRAFT_KEY).toBe("home-selection");
    expect(HOME_DRAFT_TTL_MS).toBe(86_400_000);
  });
});
