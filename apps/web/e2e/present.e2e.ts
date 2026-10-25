import { expect, test, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const REPO = process.env.E2E_REPO_URL ?? "https://github.com/pallets/click";
const MAP_BUDGET_MS = 3000;

let repoId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const repos = (await (await request.get(`${API}/repos`)).json()) as { id: string; url: string; status: string }[];
  const repo = repos.find((r) => r.url === REPO && r.status === "ready");
  if (!repo) throw new Error(`${REPO} must be ingested before running e2e tests`);
  repoId = repo.id;
});

const nodes = (page: Page) => page.locator(".react-flow__node");

test("architecture map renders in under 3 s and folders expand and collapse", async ({ page }) => {
  // Warm-up load: in dev mode the first visit compiles the page.
  await page.goto(`/repos/${repoId}#map`);
  await page.waitForSelector(".react-flow__edge", { state: "attached" });

  await page.goto(`/repos/${repoId}?measure=${Date.now()}#map`);
  // Time of the first frame with both nodes and edges on screen (performance.now() counts from navigation start).
  const ms = await page.waitForFunction(() => {
    const w = window as unknown as { __mapDrawnAt?: number };
    if (document.querySelectorAll(".react-flow__node").length > 0 && document.querySelectorAll(".react-flow__edge path").length > 0) w.__mapDrawnAt ??= performance.now();
    return w.__mapDrawnAt ?? false;
  }, undefined, { polling: 16 }).then((h) => h.jsonValue() as Promise<number>);
  // ...and it stays drawn once the layout settles.
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() => ({ nodes: document.querySelectorAll(".react-flow__node").length, edges: document.querySelectorAll(".react-flow__edge path").length }));
  console.log(`map: ${counts.nodes} nodes and ${counts.edges} edge paths drawn ${Math.round(ms)} ms after navigation`);
  expect(ms).toBeLessThan(MAP_BUDGET_MS);
  expect(counts.nodes).toBeGreaterThan(0);
  expect(counts.edges).toBeGreaterThan(0);

  const before = await nodes(page).count();
  await page.getByRole("button", { name: "Expand tests" }).click();
  await expect.poll(() => nodes(page).count()).toBeGreaterThan(before);
  await page.getByTitle("Collapse tests").click();
  await expect.poll(() => nodes(page).count()).toBe(before);

  await nodes(page).filter({ hasText: "core.py" }).first().click();
  await expect(page.getByText("src/click/core.py", { exact: true })).toBeVisible();
});

test("asks a question and opens a cited line range in the code viewer", async ({ page }) => {
  await page.goto(`/repos/${repoId}#ask`);
  await page.getByLabel("Question").fill("Where is zsh shell completion implemented?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  const citation = page.getByRole("button", { name: /shell_completion\.py:\d+/ }).first();
  await expect(citation).toBeVisible({ timeout: 30_000 });
  await citation.click();
  const viewer = page.getByRole("dialog");
  await expect(viewer).toContainText("class ZshComplete");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("traces a bug, runs sandboxed fix attempts, and never offers a failing patch", async ({ page }) => {
  // Real sandbox + offline mock model: the mock's patch never applies, so nothing may be offered.
  test.setTimeout(300_000);
  await page.goto(`/repos/${repoId}#fix`);
  await page
    .getByLabel("Error, stack trace or bug description")
    .fill("The usage line for an optional Choice argument shows doubled brackets: `Usage: cli [OPTIONS] [[foo|bar|baz]]` instead of `[foo|bar|baz]`.");
  await page.getByRole("button", { name: "Trace bug" }).click();
  await expect(page.getByText("Case file")).toBeVisible({ timeout: 60_000 });
  // Ranking quality is measured by `pnpm eval:bugs`; here: suspects are listed and point at source code.
  await expect(page.getByRole("button", { name: /src\/click\/.+\.py:\d+/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Generate a tested fix" }).click();
  await expect(page.getByText(/Finished without a passing patch|Passing patch ready/)).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText("Finished without a passing patch")).toBeVisible();
  await expect(page.getByText("Attempt 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and open pull request" })).toHaveCount(0);
  await expect(page.getByText(/Baseline tests: \d+ passed/)).toBeVisible();
});

test("traces a request flow and highlights its hops on the map", async ({ page }) => {
  await page.goto(`/repos/${repoId}#map`);
  await page.waitForSelector(".react-flow__edge", { state: "attached" });
  await page.getByLabel("Entry point").fill("Command.main");
  await page.getByRole("button", { name: /^Command\.main/ }).first().click();

  await expect(page.getByRole("button", { name: "Command.make_context" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".react-flow__edge.animated").first()).toBeAttached();
  await expect(nodes(page).filter({ hasText: "core.py" }).first()).toBeVisible();
});
