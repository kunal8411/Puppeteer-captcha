/**
 * Open a page and click the checkbox whose label matches some text.
 *
 * Examples:
 *   node select-checkbox.js --url demo/index.html --label "select fname"
 *   node select-checkbox.js --url https://www.google.com/recaptcha/api2/demo --label "recaptcha-checkbox-border"
 *
 * The browser stays open so you can see the result. Press Ctrl+C to close it.
 */
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import puppeteer from "puppeteer";
import sharp from "sharp";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = path.join(ROOT, ".venv/bin/python");
const DETECT_SCRIPT = path.join(ROOT, "detect.py");

let detector;

function startDetector() {
  const child = spawn(PYTHON, ["-u", DETECT_SCRIPT], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const pending = [];

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const job = pending.shift();
      if (job) {
        try {
          job.resolve(JSON.parse(line));
        } catch (error) {
          job.reject(error);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    for (const job of pending) job.reject(error);
    detector = null;
  });

  child.on("exit", (code) => {
    const error = new Error(`Detector exited with code ${code}`);
    for (const job of pending) job.reject(error);
    detector = null;
  });

  return {
    detect(filePath) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(`${filePath}\n`);
      });
    },
  };
}

function getDetector() {
  detector ??= startDetector();
  return detector;
}

function extensionFor(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return ".png";
  if (buffer.subarray(0, 4).toString() === "RIFF") return ".webp";
  return ".img";
}

function readArg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) {
    return fallback;
  }
  return process.argv[index + 1];
}

function toPageUrl(value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `file://${path.resolve(value)}`;
}

const MARKER = "data-checkbox-target";

/**
 * Mark the checkbox that matches the label, inside one document.
 * Covers native inputs and custom widgets such as:
 *   <div class="sample-checkbox" role="presentation"></div>
 * When that div sits inside an element with role="checkbox", the parent is marked.
 */
function findAndMark(text, marker) {
  const needle = text.trim().toLowerCase();
  document
    .querySelectorAll(`[${marker}]`)
    .forEach((el) => el.removeAttribute(marker));

  function isNative(el) {
    return el && el.tagName === "INPUT" && el.type === "checkbox";
  }

  function visibleText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function classTokens(el) {
    return String(el.className || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function widgetFor(el) {
    const roleBox = el.closest('[role="checkbox"]');
    if (roleBox) return roleBox;
    if (isNative(el)) return el;
    return el;
  }

  function mark(el, how) {
    const target = widgetFor(el);
    target.setAttribute(marker, "1");
    const checked = isNative(target)
      ? target.checked
      : target.getAttribute("aria-checked") === "true";
    return {
      found: true,
      checked,
      how,
      name:
        target.id ||
        classTokens(target)[0] ||
        target.getAttribute("role") ||
        "",
    };
  }

  const byClass = Array.from(
    document.querySelectorAll("div, span, label, input"),
  ).find(
    (el) =>
      classTokens(el).includes(needle) ||
      (el.id || "").toLowerCase() === needle,
  );
  if (byClass) return mark(byClass, "class");

  const labels = Array.from(document.querySelectorAll("label"));
  for (const label of labels) {
    if (!visibleText(label).toLowerCase().includes(needle)) continue;
    const fromFor = label.htmlFor
      ? document.getElementById(label.htmlFor)
      : null;
    const nested = label.querySelector(
      'input[type="checkbox"], [role="checkbox"]',
    );
    const input =
      isNative(fromFor) ||
      (fromFor && fromFor.getAttribute("role") === "checkbox")
        ? fromFor
        : nested;
    if (input) return mark(input, "label");
  }

  const candidates = Array.from(
    document.querySelectorAll("span, p, div, li, td, th, a"),
  );
  for (const el of candidates) {
    if (!visibleText(el).toLowerCase().includes(needle)) continue;
    if (
      el.querySelector("input, select, textarea, button") &&
      el.children.length > 3
    )
      continue;
    const parent = el.parentElement;
    const nearby = [
      el.querySelector('input[type="checkbox"], [role="checkbox"]'),
      el.previousElementSibling,
      el.nextElementSibling,
      parent &&
        parent.querySelector('input[type="checkbox"], [role="checkbox"]'),
    ];
    const input = nearby.find(
      (node) =>
        isNative(node) || (node && node.getAttribute("role") === "checkbox"),
    );
    if (input) return mark(input, "nearby-text");
  }

  return { found: false, checked: false, how: "", name: "" };
}

async function clickCheckboxByLabel(page, labelText) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await clickOnce(page, labelText);
    if (result.clicked) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { clicked: false, checked: false, how: "", name: "" };
}

async function clickOnce(page, labelText) {
  const frames = page.frames();
  for (const frame of frames) {
    let marked;
    try {
      marked = await frame.evaluate(findAndMark, labelText, MARKER);
    } catch {
      continue;
    }
    if (!marked.found) continue;

    const handle = await frame.$(`[${MARKER}]`);
    if (!handle) continue;

    await handle.evaluate((el) =>
      el.scrollIntoView({ block: "center", inline: "center" }),
    );
    const box = await handle.boundingBox();
    if (!box || box.width === 0 || box.height === 0) continue;
    await handle.click();
    const after = await frame.evaluate((marker) => {
      const el = document.querySelector(`[${marker}]`);
      if (!el) return { checked: false, name: "" };
      const classes = String(el.className || "").split(/\s+/);
      const checked =
        el.tagName === "INPUT"
          ? el.checked
          : el.getAttribute("aria-checked") === "true" ||
            classes.some((name) => name.endsWith("-checked"));
      return {
        checked,
        name: el.id || classes[0] || "",
      };
    }, MARKER);

    return {
      clicked: true,
      checked: after.checked,
      how: marked.how,
      name: after.name || marked.name,
    };
  }

  return { clicked: false, checked: false, how: "", name: "" };
}

/**
 * Count image-challenge tiles and derive the grid size.
 * Columns come from the first tile's row; rows are total / columns.
 */
function measureTiles() {
  const tiles = document.querySelectorAll(".rc-imageselect-tile");
  const total = tiles.length;
  const columns = tiles[0]?.parentElement?.children.length || 0;
  const rows = columns ? Math.ceil(total / columns) : 0;
  return { total, rows, columns };
}

async function readTileGrid(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let grid;
      try {
        grid = await frame.evaluate(measureTiles);
      } catch {
        continue;
      }
      if (grid.total > 0 && grid.columns > 0) return grid;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { total: 0, rows: 0, columns: 0 };
}
async function loadImage(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Could not download image: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFileSync(source);
}
async function getGridImages(page) {
  for (const frame of page.frames()) {
    console.log({frame});
    try {
      const images = await frame.$$eval(
        ".rc-image-tile-target",
        tiles =>
          tiles.map((tile, index) => {
            const wrapper = tile.querySelector(".rc-image-tile-wrapper");
            const img = wrapper?.querySelector("img");

            return {
              index,
              tileId: tile.id || null,
              src: img?.src || null,
            };
          })
      );

      if (images.length > 0) {
        return images;
      }
    } catch {
      console.log("Frame error:", error.message);
    }
  }

  return [];
}

const SAME_AS = {
  person: ["people", "pedestrian", "pedestrians"],
  bicycle: ["bike", "bikes"],
  motorcycle: ["motorbike", "motorbikes"],
  crosswalk: ["zebra crossing", "pedestrian crossing"],
  "zebra crossing": ["crosswalk", "pedestrian crossing"],
};

function textHasPhrase(targetText, phrase) {
  const targetWords = targetText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const words = phrase.toLowerCase().split(/\s+/);
  return words.every((word) =>
    targetWords.some(
      (targetWord) => targetWord === word || targetWord.startsWith(word),
    ),
  );
}

function labelMatchesTarget(label, targetText) {
  if (!targetText) return false;
  const phrases = [label, ...(SAME_AS[label] || [])];
  return phrases.some((phrase) => textHasPhrase(targetText, phrase));
}

function readChallengeText() {
  const selectors = [
    ".rc-imageselect-desc-no-canonical strong",
    ".rc-imageselect-desc strong",
    ".rc-imageselect-instructions strong",
  ];
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return "";
}

async function readTargetText(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const text = await frame.evaluate(readChallengeText);
        if (text) return text;
      } catch {
        continue;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

function overlapArea(box, cell) {
  const [x, y, width, height] = box;
  const x1 = Math.max(x, cell.x);
  const y1 = Math.max(y, cell.y);
  const x2 = Math.min(x + width, cell.x + cell.width);
  const y2 = Math.min(y + height, cell.y + cell.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function cellsForBox(box, rows, columns, imageWidth, imageHeight) {
  const cellWidth = imageWidth / columns;
  const cellHeight = imageHeight / rows;
  const hits = [];
  for (let index = 0; index < rows * columns; index++) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cell = {
      x: col * cellWidth,
      y: row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    };
    const overlap = overlapArea(box, cell);
    if (overlap / (cellWidth * cellHeight) >= 0.15) hits.push(index);
  }
  if (hits.length > 0) return hits;

  const [x, y, width, height] = box;
  const col = Math.min(
    columns - 1,
    Math.max(0, Math.floor((x + width / 2) / cellWidth)),
  );
  const row = Math.min(
    rows - 1,
    Math.max(0, Math.floor((y + height / 2) / cellHeight)),
  );
  return [row * columns + col];
}

async function detectObjects(imageSource, targetText) {
  const buffer = Buffer.isBuffer(imageSource)
    ? imageSource
    : await loadImage(imageSource);
  const file = path.join(
    os.tmpdir(),
    `yolo-${randomBytes(8).toString("hex")}${extensionFor(buffer)}`,
  );
  await fs.promises.writeFile(file, buffer);
  try {
    const objects = await getDetector().detect(file);
    const matches = objects.filter((object) =>
      labelMatchesTarget(object.label, targetText),
    );
    return {
      match: matches.length > 0,
      targetText,
      matches,
      objects,
    };
  } finally {
    await fs.promises.unlink(file).catch(() => {});
  }
}

async function main() {
  const target = readArg("url", "demo/index.html");
  const label = readArg("label", "select fname");
  const url = toPageUrl(target);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });
  const page = await browser.newPage();

  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const result = await clickCheckboxByLabel(page, label);
  if (!result.clicked) {
    console.error(`Could not find a checkbox for "${label}".`);
    console.error(
      "Leave the browser open and check the page text, then try again.",
    );
    return;
  }

  console.log(
    `Clicked "${label}" (${result.how}${result.name ? `, name: ${result.name}` : ""}). Checked: ${result.checked}`,
  );

  const { total, rows, columns } = await readTileGrid(page);
  const images = await getGridImages(page);
  console.log({ images });
  const targetText = await readTargetText(page);
  console.log({ targetText });
  const srcs = new Set(images.map((image) => image.src).filter(Boolean));
  const splitGrid = srcs.size === 1 && rows > 1 && columns > 1;
  const results = [];

  if (splitGrid) {
    const buffer = await loadImage(images[0].src);
    const meta = await sharp(buffer).metadata();
    const detected = await detectObjects(buffer, targetText);
    console.log({
      found: detected.objects.map((object) => ({
        label: object.label,
        confidence: object.confidence,
        box: object.box,
      })),
    });
    for (const image of images) {
      results.push({
        index: image.index,
        match: false,
        targetText,
        matches: [],
        objects: [],
      });
    }
    for (const object of detected.objects) {
      const cells = cellsForBox(
        object.box,
        rows,
        columns,
        meta.width,
        meta.height,
      );
      const isMatch = labelMatchesTarget(object.label, targetText);
      for (const index of cells) {
        const tile = results.find((item) => item.index === index);
        if (!tile) continue;
        tile.objects.push(object);
        if (isMatch) {
          tile.matches.push(object);
          tile.match = true;
        }
      }
    }
    for (const tile of results) {
      console.log({
        index: tile.index,
        match: tile.match,
        matches: tile.matches.map((object) => object.label),
      });
    }
  } else if (images.length > 0) {
    for (const image of images) {
      if (!image.src) continue;
      const result = await detectObjects(image.src, targetText);
      results.push({ index: image.index, ...result });
      console.log({
        index: image.index,
        match: result.match,
        matches: result.matches.map((object) => object.label),
      });
    }
  }

  console.log({ results });
  console.log({ total, rows, columns });
  
  if (!total) {
    console.error("Could not find image tiles to measure rows and columns.");
  }

  console.log("Browser stays open. Press Ctrl+C when you are done.");

  await new Promise(() => {});
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { clickCheckboxByLabel };
