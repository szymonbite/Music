import fs from 'node:fs';
import { test as base, expect, type Page } from '@playwright/test';

const fakeYouTubeApi = fs.readFileSync(new URL('./fixtures/fake-youtube-api.js', import.meta.url), 'utf8');

function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

/** A colourful stand-in for a YouTube thumbnail, so screenshots look like the real thing. */
function fakeThumbnail(videoId: string): string {
  const h = hue(videoId);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${h},75%,55%)"/><stop offset="1" stop-color="hsl(${(h + 70) % 360},70%,30%)"/>
  </linearGradient></defs>
  <rect width="480" height="360" fill="#000"/><rect y="45" width="480" height="270" fill="url(#g)"/>
  <circle cx="${120 + (h % 240)}" cy="180" r="70" fill="rgba(255,255,255,0.18)"/>
  <circle cx="${360 - (h % 200)}" cy="${120 + (h % 120)}" r="40" fill="rgba(0,0,0,0.18)"/>
</svg>`;
}

/** Routes YouTube's player script and thumbnails to local fakes (YouTube isn't reachable from CI). */
export async function fakeYouTube(page: Page): Promise<void> {
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeYouTubeApi }),
  );
  await page.route('https://i.ytimg.com/**', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[2] ?? 'x';
    return route.fulfill({ contentType: 'image/svg+xml', body: fakeThumbnail(id) });
  });
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await fakeYouTube(page);
    await use(page);
  },
});

export { expect };

export interface YtCall {
  type: string;
  videoId?: string;
  startSeconds?: number;
  seconds?: number;
}

export function ytCalls(page: Page): Promise<YtCall[]> {
  return page.evaluate(() => (window as unknown as { __ytCalls?: YtCall[] }).__ytCalls ?? []);
}

/** Goes through onboarding: name, then picks the first three popular songs. */
export async function onboard(page: Page, name = 'Szymon'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find your next earworm' })).toBeVisible();
  await page.getByLabel('What should we call you?').fill(name);
  await page.getByRole('button', { name: 'Pick my favourite songs' }).click();
  await expect(page.getByRole('heading', { name: 'Pick songs you love' })).toBeVisible();
  const tiles = page.locator('.tile[aria-pressed]');
  await expect(tiles.first()).toBeVisible();
  for (let i = 0; i < 3; i++) await tiles.nth(i).click();
  await page.getByRole('button', { name: 'Start scrolling' }).click();
  await expect(page.locator('.card[data-active]')).toBeVisible();
}
