const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const axios = require('axios');
const sharp = require('sharp');
const { chromium, devices } = require('playwright');
require('dotenv').config();

const KEYWORDS = (process.env.SEARCH_KEYWORDS || '티유치과,tu치과,제로네이트')
  .split(',')
  .map((keyword) => keyword.trim())
  .filter(Boolean);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 4000);
const MAX_IMAGE_HEIGHT = Number(process.env.MAX_IMAGE_HEIGHT || 0);
const OUTPUT_WIDTH = Number(process.env.OUTPUT_WIDTH || 500);
const OUTPUT_HEIGHT = Number(process.env.OUTPUT_HEIGHT || 500);
const OUTPUT_DIR = path.resolve(__dirname, '..', 'images');
const LATEST_FILENAME = 'latest.png';
const MOBILE_PROFILE = devices['Pixel 5'];

if (!KEYWORDS.length) {
  throw new Error('검색어(SEARCH_KEYWORDS)가 비어 있습니다.');
}

function timestampString(date = new Date()) {
  const pad = (value) => value.toString().padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function sanitize(keyword) {
  const cleaned = keyword
    .toLowerCase()
    .replace(/[^0-9a-z]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'keyword';
}

function buildImageUrl(filename) {
  if (process.env.IMAGE_BASE_URL) {
    const base = process.env.IMAGE_BASE_URL.replace(/\/$/, '');
    return `${base}/${filename}`;
  }
  if (process.env.GITHUB_REPOSITORY) {
    return `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY}@main/images/${filename}`;
  }
  throw new Error('IMAGE_BASE_URL 또는 GITHUB_REPOSITORY 값이 필요합니다.');
}

async function trimScreenshotHeight(filePath) {
  if (!MAX_IMAGE_HEIGHT) {
    return;
  }
  const metadata = await sharp(filePath).metadata();
  if (!metadata.height || metadata.height <= MAX_IMAGE_HEIGHT) {
    return;
  }
  const tmpFile = `${filePath}.trim`;
  await sharp(filePath)
    .extract({
      left: 0,
      top: 0,
      width: metadata.width || MOBILE_PROFILE.viewport.width || 1080,
      height: MAX_IMAGE_HEIGHT,
    })
    .toFile(tmpFile);
  await fs.move(tmpFile, filePath, { overwrite: true });
}

async function resizeFinalImage(filePath) {
  if (!OUTPUT_WIDTH || !OUTPUT_HEIGHT) {
    return;
  }
  const tmpFile = `${filePath}.resized`;
  await sharp(filePath)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, {
      fit: 'cover',
      position: 'top',
    })
    .toFile(tmpFile);
  await fs.move(tmpFile, filePath, { overwrite: true });
}

async function captureScreenshots(browser, tmpDir) {
  const screenshots = [];
  for (const keyword of KEYWORDS) {
    const page = await browser.newPage({
      ...MOBILE_PROFILE,
      userAgent: MOBILE_PROFILE.userAgent,
      viewport: MOBILE_PROFILE.viewport,
    });
    const url = `https://m.search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`;
    console.log(`Capturing keyword "${keyword}" -> ${url}`);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(PAGE_WAIT_MS);
    const filename = `${timestampString()}-${sanitize(keyword)}.png`;
    const filePath = path.join(tmpDir, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    await trimScreenshotHeight(filePath);
    await page.close();
    screenshots.push({ keyword, filePath });
  }
  return screenshots;
}

async function combineImages(images, destination) {
  const buffers = await Promise.all(images.map((item) => fs.readFile(item.filePath)));
  const metas = await Promise.all(buffers.map((buffer) => sharp(buffer).metadata()));

  const totalWidth = metas.reduce((sum, meta) => sum + (meta.width || 0), 0);
  const maxHeight = metas.reduce((max, meta) => Math.max(max, meta.height || 0), 0);

  if (!totalWidth || !maxHeight) {
    throw new Error('이미지 메타데이터를 불러오지 못했습니다.');
  }

  const composite = [];
  let offset = 0;
  for (let i = 0; i < buffers.length; i += 1) {
    composite.push({
      input: buffers[i],
      left: offset,
      top: 0,
    });
    offset += metas[i].width || 0;
  }

  await sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(composite)
    .png()
    .toFile(destination);
}

async function cleanupOldImages() {
  const files = (await fs.pathExists(OUTPUT_DIR)) ? await fs.readdir(OUTPUT_DIR) : [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  await Promise.all(
    files.map(async (file) => {
      if (file === '.gitkeep' || file === LATEST_FILENAME) {
        return;
      }
      const filePath = path.join(OUTPUT_DIR, file);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return;
      }
      if (stat.mtimeMs < cutoff) {
        console.log(`Removing old image ${file}`);
        await fs.remove(filePath);
      }
    })
  );
}

async function sendJandiNotification(imageUrl, timestampLabel) {
  const webhook = process.env.JANDI_WEBHOOK_URL;
  if (!webhook) {
    console.warn('JANDI_WEBHOOK_URL 이 설정되지 않아 알림을 건너뜁니다.');
    return;
  }

  const payload = {
    body: `네이버 모바일 검색 스크린샷 업데이트 (${timestampLabel})`,
    connectColor: '#00C73C',
    connectInfo: [
      {
        title: '검색 키워드',
        description: KEYWORDS.join(' | '),
      },
      {
        title: '스크린샷 이미지',
        imageUrl,
      },
    ],
  };

  await axios.post(webhook, payload, { headers: { 'Content-Type': 'application/json' } });
  console.log('잔디 웹훅 전송 완료');
}

async function run() {
  await fs.ensureDir(OUTPUT_DIR);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'naver-search-'));
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const screenshots = await captureScreenshots(browser, tmpDir);
    const timestamp = timestampString();
    const finalFilename = `naver-search-${timestamp}.png`;
    const finalPath = path.join(OUTPUT_DIR, finalFilename);

    await combineImages(screenshots, finalPath);
    await resizeFinalImage(finalPath);
    console.log(`Combined image written to ${finalPath}`);

    const latestPath = path.join(OUTPUT_DIR, LATEST_FILENAME);
    await fs.copy(finalPath, latestPath);
    console.log(`Latest image updated at ${latestPath}`);

    await cleanupOldImages();

    const imageUrl = buildImageUrl(finalFilename);
    await sendJandiNotification(imageUrl, timestamp);
  } finally {
    await browser.close();
    await fs.remove(tmpDir);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
