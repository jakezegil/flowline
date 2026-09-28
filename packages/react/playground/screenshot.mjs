/**
 * Screenshots the playground in a range of states for visual review.
 *
 *   node packages/react/playground/screenshot.mjs <outDir>
 *
 * Starts the playground's Vite dev server, drives it with Playwright (Chromium) and writes PNGs
 * to <outDir> (default: ./playground-shots).
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
const wide = { width: 1440, height: 900 };
const narrow = { width: 390, height: 844 };
const errors = [];

async function open(query, viewport, colorScheme = "light") {
  const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${query}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${query}: ${m.text()}`);
  });
  await page.goto(`${base}?${query}`);
  await page.waitForSelector(".react-flow__node[data-id='trigger']");
  await page.waitForTimeout(400);
  return page;
}

async function shot(page, name) {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  console.log(path);
}

// Canvas states, light and dark, wide and narrow.
for (const theme of ["light", "dark"]) {
  for (const [size, viewport] of [
    ["wide", wide],
    ["narrow", narrow],
  ]) {
    const page = await open(`theme=${theme}&doc=nested&mode=edit`, viewport, theme);
    await shot(page, `nested-${theme}-${size}`);
    await page.close();
  }
}

// Hover + selection.
{
  const page = await open("theme=light&doc=nested&mode=edit", wide);
  await page.click(".react-flow__node[data-id='step:region'] .fk-card");
  await page.hover(".react-flow__node[data-id='step:markCustomer'] .fk-card");
  await page.waitForTimeout(250);
  await shot(page, "selected-hover-light");
  // Badge tooltip on the invalid step.
  await page.hover(".react-flow__node[data-id='step:nudge'] .fk-badge");
  await page.waitForTimeout(600);
  await shot(page, "tooltip-light");
  await page.close();
}

// Step picker, wide and narrow.
for (const [size, viewport, theme] of [
  ["wide", wide, "light"],
  ["wide", wide, "dark"],
  ["narrow", narrow, "light"],
]) {
  const page = await open(`theme=${theme}&doc=nested&mode=edit`, viewport, theme);
  await page.locator("button[aria-label='Add step here']").first().click();
  await page.waitForSelector(".fk-picker");
  await page.waitForTimeout(250);
  await shot(page, `picker-${theme}-${size}`);
  if (size === "wide" && theme === "light") {
    await page.keyboard.type("tag");
    await page.waitForTimeout(150);
    await shot(page, "picker-search-light");
  }
  await page.close();
}

// Context menu with the paste-inside-branch submenu.
for (const theme of ["light", "dark"]) {
  const page = await open(`theme=${theme}&doc=nested&mode=edit`, wide, theme);
  await page.click(".react-flow__node[data-id='step:loadContact'] .fk-card");
  await page.keyboard.press("ControlOrMeta+c");
  await page.click(".react-flow__node[data-id='step:isWon'] .fk-card", { button: "right" });
  await page.waitForSelector(".fk-menu");
  await page.hover("text=Paste inside branch");
  await page.waitForTimeout(300);
  await shot(page, `menu-${theme}`);
  await page.close();
}

// Delete with undo toast; insert animation mid-flight.
{
  const page = await open("theme=light&doc=nested&mode=edit", wide);
  await page.click(".react-flow__node[data-id='step:wait'] .fk-card");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(80);
  await shot(page, "delete-midflight-light");
  await page.waitForTimeout(400);
  await shot(page, "delete-toast-light");
  await page.close();
}

// Run overlay, read-only, empty workflow.
for (const [name, query, theme] of [
  ["run-light", "theme=light&doc=nested&mode=run", "light"],
  ["run-dark", "theme=dark&doc=nested&mode=run", "dark"],
  ["readonly-light", "theme=light&doc=nested&mode=readonly", "light"],
  ["empty-light", "theme=light&doc=empty&mode=edit", "light"],
  ["empty-dark-narrow", "theme=system&doc=empty&mode=edit", "dark"],
]) {
  const page = await open(query, name.includes("narrow") ? narrow : wide, theme);
  await shot(page, name);
  await page.close();
}

await browser.close();
await server.close();
if (errors.length) {
  console.error(`\nBrowser errors/warnings:\n${errors.join("\n")}`);
  process.exitCode = 1;
}
