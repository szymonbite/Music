// The Android app's web bundle (`vite build --mode app`), which runs Earworm's
// backend inside the page. Android's Google sign-in is played by a stand-in.

import type { Page, Route } from '@playwright/test';
import { expect, onboard, test } from './fixtures.ts';

const activeCard = '.card[data-active]';

/** Answers like a public API that allows cross-origin requests (and their preflights). */
function fulfillJson(route: Route, json: unknown) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
  };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  return route.fulfill({ json, headers });
}

/** Keeps the app away from the real YouTube API and Deezer. */
async function stubOutsideWorld(page: Page): Promise<void> {
  await page.route('https://www.googleapis.com/youtube/v3/**', (route) => fulfillJson(route, { items: [] }));
  await page.route('https://api.deezer.com/**', (route) => fulfillJson(route, { data: [] }));
}

test('works with no server, and keeps everything after a restart', async ({ page }) => {
  const serverCalls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) serverCalls.push(request.url());
  });
  await stubOutsideWorld(page);
  await onboard(page);

  // One listener, so no friends features.
  await expect(page.getByRole('tab', { name: 'Friends' })).toHaveCount(0);

  const card = page.locator(activeCard);
  const title = (await card.locator('.card__title').textContent())!;
  await card.getByRole('button', { name: /^Like/ }).click();
  await expect(card.getByRole('button', { name: 'Like (1)' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: /^Save/ }).click();
  await expect(card.getByRole('button', { name: 'Save (1)' })).toBeVisible();

  await card.getByRole('button', { name: /^Comments/ }).click();
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('Learn the bridge');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('dialog', { name: '1 comment' }).getByText('Learn the bridge')).toBeVisible();
  await expect(page.getByRole('button', { name: /’s profile$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The app saves to IndexedDB about a second after changes.
  await page.waitForTimeout(2500);
  await page.reload();
  await expect(page.locator(activeCard)).toBeVisible();
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.locator('.song-row__title', { hasText: title })).toBeVisible();

  await page.getByRole('link', { name: 'Me', exact: true }).click();
  await expect(page.locator('.stats')).toContainText('Likes1');
  await expect(page.locator('.stats')).toContainText('Comments1');
  await expect(page.locator('.stats')).not.toContainText('Followers');
  await expect(page.getByRole('link', { name: 'Find people' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Privacy' })).toHaveCount(0);

  expect(serverCalls).toEqual([]);
});

test('connects YouTube Music through Android’s Google sign-in', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __earwormGoogleAuth: unknown }).__earwormGoogleAuth = {
      authorize: async () => ({
        accessToken: 'token-from-play-services',
        grantedScopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/youtube'],
      }),
    };
  });
  await stubOutsideWorld(page);
  await page.route('https://openidconnect.googleapis.com/v1/userinfo', (route) =>
    fulfillJson(route, { sub: 'google-1', email: 'szymon@example.com', name: 'Szymon' }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Connect YouTube Music' }).click();
  await expect(page.getByRole('status')).toContainText('YouTube Music connected');
  await expect(page.getByRole('heading', { name: 'Pick songs you love' })).toBeVisible();

  const tiles = page.locator('.tile[aria-pressed]');
  for (let i = 0; i < 3; i++) await tiles.nth(i).click();
  await page.getByRole('button', { name: 'Start scrolling' }).click();
  await expect(page.locator(activeCard)).toBeVisible();

  await page.getByRole('link', { name: 'Me', exact: true }).click();
  await expect(page.getByText('szymon@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect YouTube Music' })).toBeVisible();
});

test('explains what Google Cloud needs when Google turns the app down', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __earwormGoogleAuth: unknown }).__earwormGoogleAuth = {
      authorize: async () => Promise.reject(Object.assign(new Error('16: '), { code: 'cancelled', data: { status: 16 } })),
      appIdentity: async () => ({ packageName: 'io.github.szymonbite.earworm', sha1: 'B2:B8:6F:86' }),
    };
  });
  await stubOutsideWorld(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect YouTube Music' }).click();
  const notice = page.getByRole('alert');
  await expect(notice).toContainText('If you didn’t cancel it, Google turned the app down');
  await expect(notice).toContainText('package name io.github.szymonbite.earworm and SHA-1 B2:B8:6F:86');
  // You can still carry on without YouTube Music.
  await expect(page.getByRole('button', { name: 'Skip, I’ll pick songs myself' })).toBeEnabled();
});

test('“Erase my data” starts the app over', async ({ page }) => {
  await stubOutsideWorld(page);
  await onboard(page);
  await page.getByRole('link', { name: 'Me', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Erase my data' }).click();
  await expect(page.getByRole('heading', { name: 'Find your next earworm' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Find your next earworm' })).toBeVisible();
});
