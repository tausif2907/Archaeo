import { describe, expect, it } from "vitest";
import { loadModelConfig } from "@archaeo/models";
import { cacheKey, modelCacheKey } from "./cache";

describe("result cache keys", () => {
  const model = modelCacheKey(loadModelConfig({}));

  it("ignores whitespace and key order in the input", () => {
    expect(cacheKey("abc", model, { question: "  Where is   the CLI parsed?\n" })).toBe(cacheKey("abc", model, { question: "Where is the CLI parsed?" }));
    expect(cacheKey("abc", model, { symbol: "main", path: "src/a.py" })).toBe(cacheKey("abc", model, { path: "src/a.py", symbol: "main" }));
    expect(cacheKey("abc", model, { symbol: "main", path: undefined })).toBe(cacheKey("abc", model, { symbol: "main" }));
  });

  it("misses on a new commit, a different model or a different input", () => {
    const base = cacheKey("abc", model, { question: "Where is the CLI parsed?" });
    expect(cacheKey("def", model, { question: "Where is the CLI parsed?" })).not.toBe(base);
    expect(cacheKey("abc", modelCacheKey(loadModelConfig({ MODEL_PROVIDER: "live" })), { question: "Where is the CLI parsed?" })).not.toBe(base);
    expect(cacheKey("abc", modelCacheKey(loadModelConfig({ MODEL_REASON: "other-model" })), { question: "Where is the CLI parsed?" })).not.toBe(base);
    expect(cacheKey("abc", model, { question: "Where is the CLI built?" })).not.toBe(base);
  });
});
