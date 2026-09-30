import { describe, expect, it } from "vitest";
import { initials } from "../format";

describe("initials (QA-27)", () => {
  it("ignores parenthesized qualifiers and punctuation", () => {
    expect(initials("Dev (placeholder)")).toBe("D");
    expect(initials("Andres (placeholder)")).toBe("A");
    expect(initials("Dev Super Admin")).toBe("DS");
    expect(initials("O'Neil, Mary-Kate")).toBe("OM");
    expect(initials("Ana María")).toBe("AM");
  });
  it("falls back to ? for empty names", () => {
    expect(initials(null)).toBe("?");
    expect(initials("  ")).toBe("?");
    expect(initials("(placeholder)")).toBe("?");
  });
});
