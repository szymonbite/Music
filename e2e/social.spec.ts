import type { Browser, Page } from '@playwright/test';
import { expect, fakeYouTube, onboard, test } from './fixtures.ts';

const activeCard = '.card[data-active]';

async function secondListener(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  const page = await context.newPage();
  await fakeYouTube(page);
  await onboard(page, name);
  return page;
}

test('follow a friend and see what they save in the Friends feed, then reply to their comment', async ({ page, browser }) => {
  // Ania saves a song and comments on it.
  await onboard(page, 'Ania');
  const card = page.locator(activeCard);
  const songId = await card.getAttribute('data-song-id');
  const title = (await card.locator('.card__title').textContent())!;
  await card.getByRole('button', { name: /^Save/ }).click();
  await expect(card.getByRole('button', { name: 'Save (1)' })).toBeVisible();
  await card.getByRole('button', { name: /^Comments/ }).click();
  await expect(page.getByRole('dialog', { name: /comments?$/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('The chorus!!');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByText('The chorus!!')).toBeVisible();

  // Bartek finds Ania, follows her and opens the Friends tab.
  const bartek = await secondListener(browser, 'Bartek');
  await bartek.getByRole('tab', { name: 'Friends' }).click();
  await expect(bartek.getByText('Follow people to see the songs they like and save here.')).toBeVisible();
  await bartek.getByRole('link', { name: 'Find people' }).click();
  await bartek.getByRole('searchbox', { name: 'Search people' }).fill('ani');
  await bartek.getByRole('button', { name: 'Follow Ania' }).click();
  await expect(bartek.getByRole('button', { name: 'Unfollow Ania' })).toHaveText('Following');

  // Her profile shows what she saved.
  await bartek.locator('.person__main', { hasText: 'Ania' }).click();
  const profile = bartek.getByRole('dialog', { name: 'Ania' });
  await expect(profile.getByRole('button', { name: new RegExp(`^Play ${title}`) })).toBeVisible();
  await bartek.keyboard.press('Escape');

  await bartek.goto('/?tab=friends');
  const friendCard = bartek.locator(activeCard);
  await expect(friendCard).toHaveAttribute('data-song-id', songId!);
  await expect(friendCard.locator('.card__reason')).toHaveText(/Saved by Ania/);

  // Like her comment and reply to it.
  await friendCard.getByRole('button', { name: /^Comments/ }).click();
  const sheet = bartek.getByRole('dialog', { name: '1 comment' });
  await sheet.getByRole('button', { name: 'Like comment (0)' }).click();
  await expect(sheet.getByRole('button', { name: 'Like comment (1)' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Reply' }).click();
  await bartek.getByRole('textbox', { name: 'Add a comment' }).fill('same here');
  await bartek.getByRole('button', { name: 'Post comment' }).click();
  await expect(bartek.getByRole('dialog', { name: '2 comments' }).getByText('same here')).toBeVisible();

  // Ania sees the reply in the thread (her own saves are left out of "For you", so open it by link).
  await page.goto(`/?song=${songId}`);
  await page.locator(activeCard).getByRole('button', { name: /^Comments/ }).click();
  await page.getByRole('button', { name: 'View 1 reply' }).click();
  await expect(page.getByText('same here')).toBeVisible();
  await bartek.context().close();
});

test('hook previews play a highlight, then move on unless you choose the full song', async ({ page }) => {
  await onboard(page);
  const card = page.locator(activeCard);
  await expect(card.getByRole('button', { name: 'Full song' })).toBeVisible();
  await expect(card.locator('.progress__window')).toBeVisible();

  // Fast-forward the fake player: the 30 second highlight ends and the feed moves on.
  const first = await card.getAttribute('data-song-id');
  await page.evaluate(() => {
    (window as unknown as { __ytSpeed: number }).__ytSpeed = 40;
  });
  await expect(page.locator(activeCard)).not.toHaveAttribute('data-song-id', first!, { timeout: 5000 });

  // "Full song" keeps playing past the highlight.
  await page.evaluate(() => {
    (window as unknown as { __ytSpeed: number }).__ytSpeed = 1;
  });
  const second = await page.locator(activeCard).getAttribute('data-song-id');
  await page.locator(activeCard).getByRole('button', { name: 'Full song' }).click();
  await expect(page.locator(activeCard).locator('.progress__window')).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __ytSpeed: number }).__ytSpeed = 40;
  });
  await page.waitForTimeout(1500);
  await expect(page.locator(activeCard)).toHaveAttribute('data-song-id', second!);

  // The 30s pill turns previews off for good.
  await page.getByRole('button', { name: 'Hook previews' }).click();
  await expect(page.getByRole('button', { name: 'Hook previews' })).toHaveAttribute('aria-pressed', 'false');
});
