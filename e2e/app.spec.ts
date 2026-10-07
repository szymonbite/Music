import { expect, onboard, test, ytCalls } from './fixtures.ts';

const activeCard = '.card[data-active]';

test('new listeners pick favourites, then land in a playing feed', async ({ page }) => {
  await onboard(page);
  const card = page.locator(activeCard);
  const songId = await card.getAttribute('data-song-id');
  expect(songId).toMatch(/^[\w-]{11}$/);
  await expect(card.locator('.card__reason')).not.toBeEmpty();
  await expect.poll(async () => (await ytCalls(page)).some((c) => c.type === 'load' && c.videoId === songId)).toBe(true);
  // Skip intros is on by default: once the length is known, playback jumps toward the hook.
  await expect.poll(async () => (await ytCalls(page)).some((c) => c.type === 'seek')).toBe(true);
  await expect(page.getByRole('link', { name: 'For you', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('like, save and comment, then find it all in the library', async ({ page }) => {
  await onboard(page);
  const card = page.locator(activeCard);
  const title = (await card.locator('.card__title').textContent())!;

  await card.getByRole('button', { name: /^Like/ }).click();
  await expect(card.getByRole('button', { name: 'Like (1)' })).toHaveAttribute('aria-pressed', 'true');

  await card.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('status')).toContainText('Saved to your library');
  await expect(card.getByRole('button', { name: 'Save (1)' })).toHaveAttribute('aria-pressed', 'true');

  await card.getByRole('button', { name: /^Comments/ }).click();
  const sheet = page.getByRole('dialog', { name: '0 comments' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Add a comment' }).fill('This chorus is stuck in my head');
  await sheet.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByRole('dialog', { name: '1 comment' }).getByText('This chorus is stuck in my head')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: 'Comments (1)' })).toBeVisible();

  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.song-row__title', { hasText: title })).toBeVisible();
  await page.getByRole('tab', { name: 'Liked', exact: true }).click();
  await expect(page.locator('.song-row__title', { hasText: title })).toBeVisible();

  await page.getByRole('link', { name: 'Me', exact: true }).click();
  await expect(page.locator('.stats')).toContainText('Likes1');
  await expect(page.locator('.stats')).toContainText('Comments1');
});

test('disliking a song moves straight on to the next one', async ({ page }) => {
  await onboard(page);
  const first = await page.locator(activeCard).getAttribute('data-song-id');
  await page.locator(activeCard).getByRole('button', { name: 'Dislike' }).click();
  await expect(page.getByRole('status')).toContainText('fewer songs like this');
  await expect(page.locator(activeCard)).not.toHaveAttribute('data-song-id', first!);
  const next = await page.locator(activeCard).getAttribute('data-song-id');
  await expect.poll(async () => (await ytCalls(page)).some((c) => c.type === 'load' && c.videoId === next)).toBe(true);

  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('tab', { name: 'Disliked' }).click();
  await expect(page.locator('.song-row')).toHaveCount(1);
});

test('keyboard shortcuts scroll and react', async ({ page }) => {
  await onboard(page);
  const first = await page.locator(activeCard).getAttribute('data-song-id');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(activeCard)).not.toHaveAttribute('data-song-id', first!);
  await page.keyboard.press('l');
  await expect(page.locator(activeCard).getByRole('button', { name: /^Like/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator(activeCard)).toHaveAttribute('data-song-id', first!);
});

test('double-tapping a song likes it', async ({ page }) => {
  await onboard(page);
  const card = page.locator(activeCard);
  await card.locator('.card__tap').dblclick();
  await expect(card.locator('.burst')).toBeVisible();
  await expect(card.getByRole('button', { name: /^Like/ })).toHaveAttribute('aria-pressed', 'true');
});

test('a single tap pauses and resumes', async ({ page }) => {
  await onboard(page);
  const card = page.locator(activeCard);
  await expect.poll(async () => (await ytCalls(page)).some((c) => c.type === 'load')).toBe(true);
  await page.waitForTimeout(300);
  await card.locator('.card__tap').click();
  await expect(card.locator('.card__paused')).toBeVisible();
  await card.locator('.card__tap').click();
  await expect(card.locator('.card__paused')).toBeHidden();
});

test('songs that cannot be played are skipped automatically', async ({ page }) => {
  await onboard(page);
  const second = await page.locator('.card').nth(1).getAttribute('data-song-id');
  const third = await page.locator('.card').nth(2).getAttribute('data-song-id');
  await page.evaluate((id) => {
    (window as unknown as { __ytUnavailable: string[] }).__ytUnavailable = [id!];
  }, second);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('status')).toContainText('can’t be played here');
  await expect(page.locator(activeCard)).toHaveAttribute('data-song-id', third!, { timeout: 5000 });
});

test('shared links open straight into the song, even for first-time visitors', async ({ page }) => {
  await page.goto('/?song=dQw4w9WgXcQ');
  const card = page.locator(activeCard);
  await expect(card).toHaveAttribute('data-song-id', 'dQw4w9WgXcQ');
  await expect(card.locator('.card__title')).toHaveText('Never Gonna Give You Up');
  await expect(card.locator('.card__reason')).toHaveText(/Shared with you/);
  await expect(page.getByRole('heading', { name: 'Find your next earworm' })).toHaveCount(0);
});

test('the share sheet copies a link to the song', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await onboard(page);
  const songId = await page.locator(activeCard).getAttribute('data-song-id');
  await page.locator(activeCard).getByRole('button', { name: 'Share' }).click();
  const sheet = page.getByRole('dialog', { name: 'Share' });
  await expect(sheet.getByRole('textbox', { name: 'Link to this song' })).toHaveValue(new RegExp(`/\\?song=${songId}$`));
  await expect(sheet.getByRole('link', { name: 'Open in YouTube Music' })).toHaveAttribute(
    'href',
    `https://music.youtube.com/watch?v=${songId}`,
  );
  await sheet.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status')).toContainText('Link copied');
});

test('turning off "Skip intros" starts songs from the beginning', async ({ page }) => {
  await onboard(page);
  await page.getByRole('link', { name: 'Me', exact: true }).click();
  const skipIntros = page.getByRole('switch', { name: 'Skip intros' });
  await expect(skipIntros).toHaveAttribute('aria-checked', 'true');
  await skipIntros.click();
  await expect(skipIntros).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('link', { name: 'For you', exact: true }).click();
  const songId = await page.locator(activeCard).getAttribute('data-song-id');
  await page.evaluate(() => {
    (window as unknown as { __ytCalls: unknown[] }).__ytCalls.length = 0;
  });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(activeCard)).not.toHaveAttribute('data-song-id', songId!);
  await page.waitForTimeout(600);
  const calls = await ytCalls(page);
  expect(calls.some((c) => c.type === 'load' && c.startSeconds === 0)).toBe(true);
  expect(calls.some((c) => c.type === 'seek')).toBe(false);
});
