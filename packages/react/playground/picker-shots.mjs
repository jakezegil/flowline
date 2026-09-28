/**
 * Screenshots the `?page=picker` playground (reference inputs, data picker, code editor).
 *
 *   node packages/react/playground/picker-shots.mjs <outDir>
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const outDir = process.argv[2] ?? "playground-shots";
await mkdir(outDir, { recursive: true });

const server = await createServer({
  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  server: { port: 0 },
  logLevel: "warn",
});
await server.listen();
const base = server.resolvedUrls?.local[0] ?? "http://localhost:5174/";
const browser = await chromium.launch();
const errors = [];

async function open(theme, viewport = { width: 1000, height: 1100 }) {
  const page = await browser.newPage({ viewport, colorScheme: theme, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${theme}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${theme}: ${m.text()}`);
  });
  await page.goto(`${base}?page=picker&theme=${theme}`);
  await page.waitForSelector(".fk-ref-pill");
  await page.waitForTimeout(300);
  return page;
}

const shot = async (page, name, clip) => {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  console.log(path);
};

const editor = (page, label) => page.locator(`.cm-content[aria-label="${label}"]`);

for (const theme of ["light", "dark"]) {
  const page = await open(theme);
  await shot(page, `picker-page-${theme}`);

  // Focus opens the picker.
  await editor(page, "Subject").click();
  await page.keyboard.press("End");
  await page.waitForTimeout(250);
  await shot(page, `picker-open-${theme}`);

  // Browse into the picker, search, expand.
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.type("comp");
  await page.waitForTimeout(150);
  await shot(page, `picker-search-${theme}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // `{{` autocomplete.
  await editor(page, "Reply-to").click();
  await page.keyboard.type("Hello {{ema");
  await page.waitForTimeout(400);
  await shot(page, `autocomplete-${theme}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await shot(page, `autocomplete-inserted-${theme}`);
  await page.keyboard.press("Escape");

  // Stale pill hover card.
  await page.locator('.cm-content[aria-label="Note"] .fk-ref-pill--stale').hover();
  await page.waitForTimeout(600);
  await shot(page, `stale-pill-${theme}`);

  // Single pill field.
  await editor(page, "To").click();
  await page.waitForTimeout(250);
  await shot(page, `single-pill-${theme}`);
  await page.keyboard.press("Escape");

  // Code completions.
  await editor(page, "Code").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nsteps.loadContact.");
  await page.waitForTimeout(400);
  await shot(page, `code-complete-${theme}`);
  await page.close();

  // Undo/redo keep pills; pasted `{{ ref }}` becomes one; pills carry icons.
  const check = await open(theme);
  const expect = (cond, what) => cond || errors.push(`${theme}: check failed: ${what}`);
  const pillsIn = (label) =>
    check.locator(`.cm-content[aria-label="${label}"] .fk-ref-pill`).count();
  expect(
    (await check.locator(".fk-ref-pill .fk-ref-pill__icon svg").count()) ===
      (await check.locator(".fk-ref-pill").count()),
    "every pill has an icon",
  );
  // No pill hover card over the open picker, even with the mouse resting on a pill.
  await check.locator('.cm-content[aria-label="Subject"] .fk-ref-pill').click();
  await check.waitForTimeout(700);
  expect((await check.locator(".fk-ref-card").count()) === 0, "no hover card over the picker");
  await editor(check, "Subject").click();
  await check.keyboard.press("End");
  await check.keyboard.press("ArrowLeft");
  await check.keyboard.press("Backspace");
  expect((await pillsIn("Subject")) === 0, "Backspace deletes the pill");
  await check.keyboard.press("ControlOrMeta+z");
  expect((await pillsIn("Subject")) === 1, "undo restores the pill");
  await check.keyboard.press("ControlOrMeta+Shift+z");
  expect((await pillsIn("Subject")) === 0, "redo deletes it again");
  await check.keyboard.press("ControlOrMeta+z");
  await editor(check, "Reply-to").click();
  await check.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "Total {{ trigger.amount }}");
    document
      .querySelector('.cm-content[aria-label="Reply-to"]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  expect((await pillsIn("Reply-to")) === 1, "pasted {{ ref }} becomes a pill");
  await check.keyboard.press("Escape");
  await check.waitForTimeout(250);
  await shot(check, `undo-paste-${theme}`);
  await check.close();

  const narrow = await open(theme, { width: 390, height: 844 });
  await editor(narrow, "Subject").click();
  await narrow.waitForTimeout(250);
  await shot(narrow, `picker-narrow-${theme}`);
  await narrow.close();
}

await browser.close();
await server.close();
if (errors.length) {
  console.error(`\n${errors.length} console errors/warnings:\n${errors.join("\n")}`);
  process.exitCode = 1;
}
