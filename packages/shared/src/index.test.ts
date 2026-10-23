import { describe, expect, it } from "vitest";
import { CreateRepoInput, parseGitHubUrl } from "./index";

describe("parseGitHubUrl", () => {
  it.each([
    ["https://github.com/pallets/click", "pallets", "click"],
    ["https://github.com/pallets/click.git", "pallets", "click"],
    ["github.com/pallets/click/", "pallets", "click"],
    ["  https://www.github.com/encode/httpx  ", "encode", "httpx"],
  ])("parses %s", (input, owner, name) => {
    expect(parseGitHubUrl(input)).toEqual({ owner, name, url: `https://github.com/${owner}/${name}` });
  });

  it.each(["https://gitlab.com/a/b", "https://github.com/onlyowner", "not a url", ""])("rejects %s", (input) => {
    expect(parseGitHubUrl(input)).toBeNull();
  });

  it("validates CreateRepoInput", () => {
    expect(CreateRepoInput.safeParse({ url: "https://github.com/a/b" }).success).toBe(true);
    expect(CreateRepoInput.safeParse({ url: "https://example.com" }).success).toBe(false);
  });
});
