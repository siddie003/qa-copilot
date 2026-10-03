import { describe, expect, it } from "vitest";
import { parseFigmaUrl } from "./figma";

describe("parseFigmaUrl", () => {
  it("extracts the file key and node id from a design link", () => {
    expect(
      parseFigmaUrl("https://www.figma.com/design/AbCdEfGh1234/Marketing-Site?node-id=12-34&t=xyz"),
    ).toEqual({
      ok: true,
      url: "https://www.figma.com/design/AbCdEfGh1234?node-id=12-34",
      fileKey: "AbCdEfGh1234",
      nodeIds: ["12:34"],
    });
  });

  it.each(["https://figma.com/file/AbCdEfGh1234/x", "https://www.figma.com/proto/AbCdEfGh1234"])(
    "accepts %s",
    (url) => {
      const r = parseFigmaUrl(url);
      expect(r.ok && r.fileKey).toBe("AbCdEfGh1234");
    },
  );

  it.each([
    "not a url",
    "http://www.figma.com/design/AbCdEfGh1234/x",
    "https://evil.com/design/AbCdEfGh1234/x",
    "https://www.figma.com.evil.com/design/AbCdEfGh1234",
    "https://www.figma.com/community/file/123",
    "https://www.figma.com/design/short/x",
    "https://www.figma.com/design/AbCdEfGh1234/x?node-id=abc",
  ])("rejects %s", (url) => {
    expect(parseFigmaUrl(url).ok).toBe(false);
  });
});
