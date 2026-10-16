// Feishu tests cover how delivered reasoning keeps fenced samples out of its italic styling.
import { describe, expect, it } from "vitest";
import { formatReasoningPreservingStructure } from "./reasoning-structure.js";

describe("formatReasoningPreservingStructure fences", () => {
  // Only the character that opened a fence closes it, and only at the same length or
  // longer, so every line between the markers below is sample text and stays as written.
  it.each([
    { shape: "a backtick fence holding a tilde line", fence: "```\n~~~\nplain sample\n```" },
    { shape: "a tilde fence holding a backtick line", fence: "~~~\n```\nplain sample\n~~~" },
    { shape: "a long tilde fence holding a short one", fence: "~~~~\n~~~\nplain sample\n~~~~" },
    { shape: "a long backtick fence holding a short one", fence: "````\n```\nplain sample\n````" },
    { shape: "a tilde fence closed by a longer marker", fence: "~~~\nplain sample\n~~~~~" },
    { shape: "a fence behind a quote", fence: "> ~~~\n> plain sample\n> ~~~" },
    { shape: "a fence that was never closed", fence: "~~~\nplain sample" },
  ])("leaves $shape as written", ({ fence }) => {
    expect(formatReasoningPreservingStructure(`Checking.\n\n${fence}`)).toBe(
      `Thinking\n\n_Checking._\n\n${fence}`,
    );
  });

  it("italicises the prose after a tilde fence closes", () => {
    expect(formatReasoningPreservingStructure("~~~\nplain sample\n~~~\nBack to prose.")).toBe(
      "Thinking\n\n~~~\nplain sample\n~~~\n_Back to prose._",
    );
  });
});
