/**
 * Screenshots the playground in a range of states for visual review.
 *
 *   node packages/react/playground/screenshot.mjs <outDir> [--app | --panel]
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

// Editor and run viewer pages (`--app` shoots only these).
async function appShots() {
  for (const theme of ["light", "dark"]) {
    for (const [size, viewport] of [
      ["wide", wide],
      ["narrow", narrow],
    ]) {
      const page = await open(`page=editor&wf=deal-won&theme=${theme}`, viewport, theme);
      await shot(page, `editor-${theme}-${size}`);
      await page.click(".fl-issues");
      await page.waitForTimeout(450);
      await shot(page, `editor-issue-${theme}-${size}`);
      await page.close();
      for (const run of ["running", "waiting", "failed", "loop"]) {
        const p = await open(`page=run&run=${run}&theme=${theme}`, viewport, theme);
        await p.waitForTimeout(300);
        await shot(p, `run-${run}-${theme}-${size}`);
        await p.close();
      }
    }
  }
  {
    const page = await open("page=editor&wf=onboarding&theme=light", wide);
    await page.click(".react-flow__node[data-id='step:approval'] .fl-card");
    await page.waitForTimeout(350);
    await shot(page, "editor-selected-light");
    await page.fill(".fl-name", "Onboarding v2");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await shot(page, "editor-unsaved-light");
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForTimeout(700);
    await shot(page, "editor-saved-toast-light");
    await page.click("button:has-text('Run')");
    await page.waitForSelector(".fl-dialog");
    await page.waitForTimeout(250);
    await shot(page, "editor-run-dialog-light");
    await page.close();
  }
  for (const theme of ["light", "dark"]) {
    const page = await open(`page=run&run=failed&theme=${theme}`, wide, theme);
    await page.click("role=tab[name=/Timeline/]");
    await page.waitForTimeout(200);
    await shot(page, `run-timeline-${theme}`);
    // Off-screen once the run opens on its failed step: click it without scrolling.
    await page
      .locator(".react-flow__node[data-id='step:loadContact'] .fl-card")
      .evaluate((el) => el.click());
    await page.waitForTimeout(300);
    await shot(page, `run-output-${theme}`);
    await page.close();
  }
  {
    const page = await open("page=run&run=waiting&theme=light", wide);
    await page.locator("button:has-text('Resume…')").first().click();
    await page.waitForSelector(".fl-dialog");
    await page.waitForTimeout(250);
    await shot(page, "run-resume-dialog-light");
    await page.close();
  }
  // Cancel run's confirm, and the primary CTA's hover in dark mode.
  for (const [theme, size, viewport] of [
    ["light", "wide", wide],
    ["dark", "wide", wide],
    ["light", "narrow", narrow],
  ]) {
    const page = await open(`page=run&run=waiting&theme=${theme}`, viewport, theme);
    await page.click("button:has-text('Cancel run')");
    await page.waitForSelector(".fl-confirm");
    await page.waitForTimeout(250);
    await shot(page, `run-cancel-confirm-${theme}-${size}`);
    await page.close();
  }
  {
    const page = await open("page=run&run=failed&theme=dark", wide, "dark");
    await page.hover("button:has-text('Retry from failed step')");
    await page.waitForTimeout(250);
    await shot(page, "run-retry-hover-dark");
    await page.close();
    const editor = await open("page=editor&wf=onboarding&theme=dark", wide, "dark");
    await editor.hover(".fl-btn--primary");
    await editor.waitForTimeout(250);
    await shot(editor, "editor-publish-hover-dark");
    await editor.close();
  }
  {
    const page = await open("page=run&run=loop&theme=dark", narrow, "dark");
    await page.click(".fl-panel .fl-icon-btn[aria-label='Close panel']");
    await page.waitForTimeout(300);
    await shot(page, "run-loop-dark-narrow-closed");
    await page.close();
  }
}

// Config panel states (`--panel` shoots only these).
async function selectNode(page, key) {
  const id = key === "trigger" ? "trigger" : `step:${key}`;
  await page.locator(`.react-flow__node[data-id='${id}'] .fl-card`).evaluate((el) => el.click());
  await page.waitForSelector(".fl-cp");
  await page.waitForTimeout(350);
}
async function scrollPanelTo(page, selector) {
  await page
    .locator(`.fl-cp__body ${selector}`)
    .first()
    .evaluate((el) => {
      const body = el.closest(".fl-cp__body");
      body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 60;
    });
  await page.waitForTimeout(150);
}
async function panelShots() {
  for (const theme of ["light", "dark"]) {
    const page = await open(`page=editor&wf=deal-won&theme=${theme}`, wide, theme);
    await selectNode(page, "welcomeEmea");
    await shot(page, `panel-step-${theme}`);
    await selectNode(page, "isWon");
    await shot(page, `panel-rules-${theme}`);
    await selectNode(page, "region");
    await shot(page, `panel-switch-${theme}`);
    await selectNode(page, "notify");
    await scrollPanelTo(page, "[role='radiogroup'][aria-label='Authentication']");
    await shot(page, `panel-http-auth-${theme}`);
    await page.click(".fl-cp [role='radio']:has-text('Header')");
    await page.waitForTimeout(200);
    await shot(page, `panel-http-auth-header-${theme}`);
    await selectNode(page, "nudge");
    await shot(page, `panel-field-issues-${theme}`);
    await selectNode(page, "loadContact");
    await page.click(".fl-cp [role='tab']:has-text('Test')");
    await page.click(".fl-cp button:has-text('Test step')");
    await page.waitForSelector(".fl-cp section[aria-label='Output']");
    await page.waitForTimeout(250);
    await shot(page, `panel-test-output-${theme}`);
    await selectNode(page, "welcomeEmea");
    await page.click(".fl-cp button:has-text('Test step')");
    await page.waitForSelector(".fl-cp [role='alert']");
    await page.waitForTimeout(250);
    await shot(page, `panel-test-error-${theme}`);
    await selectNode(page, "trigger");
    await page.click(".fl-cp button:has-text('Fill from fields')");
    await page.waitForTimeout(150);
    await shot(page, `panel-trigger-sample-${theme}`);
    await page.close();

    const hook = await open(`page=editor&wf=inbound-lead&theme=${theme}`, wide, theme);
    await selectNode(hook, "trigger");
    await hook.waitForSelector(".fl-webhook__url");
    await shot(hook, `panel-trigger-webhook-${theme}`);
    await selectNode(hook, "enrich");
    await hook.waitForSelector("text=Company domain");
    await shot(hook, `panel-subflow-${theme}`);
    await selectNode(hook, "summarize");
    await shot(hook, `panel-transform-${theme}`);
    await hook.close();

    const narrowPage = await open(`page=editor&wf=deal-won&theme=${theme}`, narrow, theme);
    await selectNode(narrowPage, "welcomeEmea");
    await shot(narrowPage, `panel-narrow-${theme}`);
    await selectNode(narrowPage, "isWon");
    await shot(narrowPage, `panel-narrow-rules-${theme}`);
    await narrowPage.close();
  }

  // Keyboard: Enter on a node moves focus into the panel; Esc closes it and refocuses the node.
  const kb = await open("page=editor&wf=deal-won&theme=light", wide);
  await kb.locator(".react-flow__node[data-id='trigger']").focus();
  await kb.keyboard.press("ArrowDown");
  await kb.waitForTimeout(150);
  await kb.keyboard.press("ArrowDown");
  await kb.waitForTimeout(150);
  const selectedId = await kb.evaluate(() => document.activeElement?.getAttribute("data-id"));
  console.log(`keyboard: arrows moved focus to ${selectedId}`);
  await kb.keyboard.press("Enter");
  await kb.waitForSelector(".fl-cp");
  await kb.waitForTimeout(200);
  const inPanel = await kb.evaluate(() => !!document.activeElement?.closest(".fl-cp"));
  await kb.keyboard.press("Tab");
  await kb.keyboard.press("Tab");
  await kb.waitForTimeout(100);
  await shot(kb, "panel-keyboard-focus-light");
  await kb.keyboard.press("Escape");
  await kb.waitForTimeout(250);
  const closed = (await kb.locator(".fl-cp").count()) === 0;
  const back = await kb.evaluate(() => document.activeElement?.getAttribute("data-id"));
  console.log(
    `keyboard: focus in panel after Enter=${inPanel}, closed on Esc=${closed}, focus=${back}`,
  );
  if (!inPanel || !closed || back !== "step:loadContact")
    errors.push("keyboard focus check failed");
  await kb.close();

  // References inside the panel: pills, the picker on focus, `{{` autocomplete, and Esc layering
  // (the first Esc closes the picker or autocomplete, the next closes the panel).
  for (const theme of ["light", "dark"]) {
    const rp = await open(`page=editor&wf=deal-won&theme=${theme}`, wide, theme);
    await selectNode(rp, "welcomeEmea");
    const pills = await rp.locator(".fl-cp .fl-ref-pill").count();
    const editor = rp.locator(".fl-cp .fl-ref__editor .cm-content").first();
    await editor.click();
    await rp.waitForTimeout(300);
    const pickerOnFocus = await rp.locator(".fl-ref-popover").isVisible();
    await shot(rp, `panel-picker-${theme}`);
    await rp.keyboard.press("Escape");
    await rp.waitForTimeout(200);
    const pickerClosed = (await rp.locator(".fl-ref-popover").count()) === 0;
    const panelKept1 = (await rp.locator(".fl-cp").count()) === 1;
    await rp.keyboard.press("End");
    await rp.keyboard.type(" {{ema");
    await rp.waitForTimeout(300);
    const completions = await rp.locator(".cm-tooltip-autocomplete").isVisible();
    await shot(rp, `panel-autocomplete-${theme}`);
    await rp.keyboard.press("Escape");
    await rp.waitForTimeout(200);
    const acClosed = (await rp.locator(".cm-tooltip-autocomplete").count()) === 0;
    const panelKept2 = (await rp.locator(".fl-cp").count()) === 1;
    await rp.keyboard.press("Escape");
    await rp.waitForTimeout(250);
    const panelClosed = (await rp.locator(".fl-cp").count()) === 0;
    const result = {
      pills,
      pickerOnFocus,
      pickerClosed,
      panelKept1,
      completions,
      acClosed,
      panelKept2,
      panelClosed,
    };
    console.log(`refs (${theme}): ${JSON.stringify(result)}`);
    const ok =
      pills > 0 &&
      pickerOnFocus &&
      pickerClosed &&
      panelKept1 &&
      completions &&
      acClosed &&
      panelKept2 &&
      panelClosed;
    if (!ok) errors.push(`reference check failed (${theme})`);
    await rp.close();
  }
}
if (process.argv.includes("--panel")) {
  await panelShots();
  await browser.close();
  await server.close();
  if (errors.length) console.error(`\nBrowser errors/warnings:\n${errors.join("\n")}`);
  process.exit(errors.length ? 1 : 0);
}
await appShots();
if (process.argv.includes("--app")) {
  await browser.close();
  await server.close();
  if (errors.length) console.error(`\nBrowser errors/warnings:\n${errors.join("\n")}`);
  process.exit(errors.length ? 1 : 0);
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
  await page.click(".react-flow__node[data-id='step:region'] .fl-card");
  await page.hover(".react-flow__node[data-id='step:markCustomer'] .fl-card");
  await page.waitForTimeout(250);
  await shot(page, "selected-hover-light");
  // Badge tooltip on the invalid step.
  await page.hover(".react-flow__node[data-id='step:nudge'] .fl-badge");
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
  await page.waitForSelector(".fl-picker");
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
  await page.click(".react-flow__node[data-id='step:loadContact'] .fl-card");
  await page.keyboard.press("ControlOrMeta+c");
  await page.click(".react-flow__node[data-id='step:isWon'] .fl-card", { button: "right" });
  await page.waitForSelector(".fl-menu");
  await page.hover("text=Paste inside branch");
  await page.waitForTimeout(300);
  await shot(page, `menu-${theme}`);
  await page.close();
}

// Delete with undo toast; insert animation mid-flight.
{
  const page = await open("theme=light&doc=nested&mode=edit", wide);
  await page.click(".react-flow__node[data-id='step:wait'] .fl-card");
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
