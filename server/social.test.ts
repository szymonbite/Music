import { describe, expect, it } from 'vitest';
import type { Comment, FeedItem } from '../shared/types.ts';
import { get } from './db.ts';
import { createTestApp, entry } from './test/helpers.ts';

const RICK = 'dQw4w9WgXcQ';
const DESPACITO = 'kJQP7kiw5Fk';
const SHAPE = 'JGwWNGJdvx8';

async function onboarded(listener: ReturnType<typeof createTestApp>['listener'], name: string) {
  const l = await listener();
  await l.agent.patch('/api/me').send({ displayName: name, onboarded: true }).expect(200);
  return l;
}

describe('comment likes and replies', () => {
  it('lets listeners like comments', async () => {
    const { listener } = createTestApp();
    const a = await listener();
    const b = await listener();
    const posted = (await a.agent.post(`/api/songs/${RICK}/comments`).send({ body: 'banger' }).expect(201)).body as Comment;
    expect(posted).toMatchObject({ likes: 0, liked: false, replyCount: 0, parentId: null });

    expect((await b.agent.put(`/api/comments/${posted.id}/like`).send({ liked: true }).expect(200)).body).toEqual({ liked: true, likes: 1 });
    await b.agent.put(`/api/comments/${posted.id}/like`).send({ liked: true }).expect(200);

    const asB = (await b.agent.get(`/api/songs/${RICK}/comments`).expect(200)).body.comments[0] as Comment;
    expect(asB).toMatchObject({ likes: 1, liked: true });
    const asA = (await a.agent.get(`/api/songs/${RICK}/comments`).expect(200)).body.comments[0] as Comment;
    expect(asA).toMatchObject({ likes: 1, liked: false });

    expect((await b.agent.put(`/api/comments/${posted.id}/like`).send({ liked: false }).expect(200)).body).toEqual({ liked: false, likes: 0 });
    await b.agent.put('/api/comments/999999/like').send({ liked: true }).expect(404);
    await b.agent.put('/api/comments/abc/like').send({ liked: true }).expect(400);
    await b.agent.put(`/api/comments/${posted.id}/like`).send({ liked: 'yes' }).expect(400);
  });

  it('threads replies under the top-level comment', async () => {
    const { listener } = createTestApp();
    const a = await listener();
    const b = await listener();
    const top = (await a.agent.post(`/api/songs/${RICK}/comments`).send({ body: 'who else is here in 2026' }).expect(201)).body as Comment;
    const reply = (await b.agent.post(`/api/songs/${RICK}/comments`).send({ body: 'me!', parentId: top.id }).expect(201)).body as Comment;
    expect(reply.parentId).toBe(top.id);
    // Replying to a reply joins the same thread.
    const nested = (await a.agent.post(`/api/songs/${RICK}/comments`).send({ body: 'nice', parentId: reply.id }).expect(201)).body as Comment;
    expect(nested.parentId).toBe(top.id);

    const page = (await a.agent.get(`/api/songs/${RICK}/comments`).expect(200)).body;
    expect(page.total).toBe(3);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]).toMatchObject({ id: top.id, replyCount: 2 });

    const replies = (await a.agent.get(`/api/comments/${top.id}/replies`).expect(200)).body.replies as Comment[];
    expect(replies.map((r) => [r.body, r.mine])).toEqual([
      ['me!', false],
      ['nice', true],
    ]);

    // Replies must belong to the same song.
    await b.agent.post(`/api/songs/${DESPACITO}/comments`).send({ body: 'wrong song', parentId: top.id }).expect(404);

    // Deleting the top comment removes its thread.
    await a.agent.delete(`/api/comments/${top.id}`).expect(204);
    const song = (await a.agent.get(`/api/songs/${RICK}`).expect(200)).body as FeedItem;
    expect(song.stats.comments).toBe(0);
  });
});

describe('following people', () => {
  it('follows and unfollows, with counts on both sides', async () => {
    const { listener } = createTestApp();
    const a = await onboarded(listener, 'Ania');
    const b = await onboarded(listener, 'Bartek');

    expect((await a.agent.put(`/api/users/${b.me.id}/follow`).send({ following: true }).expect(200)).body).toEqual({
      following: true,
      followers: 1,
    });
    const profile = (await a.agent.get(`/api/users/${b.me.id}`).expect(200)).body;
    expect(profile.user).toMatchObject({ displayName: 'Bartek', followers: 1, following: 0, isFollowing: true, isMe: false });
    expect((await a.agent.get('/api/me').expect(200)).body.me.counts.following).toBe(1);
    expect((await b.agent.get('/api/me').expect(200)).body.me.counts.followers).toBe(1);

    await a.agent.put(`/api/users/${b.me.id}/follow`).send({ following: false }).expect(200);
    expect((await a.agent.get(`/api/users/${b.me.id}`).expect(200)).body.user.isFollowing).toBe(false);
  });

  it('rejects following yourself, strangers that do not exist, and bad ids', async () => {
    const { listener } = createTestApp();
    const a = await onboarded(listener, 'Ania');
    await a.agent.put(`/api/users/${a.me.id}/follow`).send({ following: true }).expect(400);
    await a.agent.put('/api/users/00000000-0000-4000-8000-000000000000/follow').send({ following: true }).expect(404);
    await a.agent.put('/api/users/not-a-user/follow').send({ following: true }).expect(400);
    await a.agent.get('/api/users/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('finds people by name, followed people first, and hides unfinished sign-ups', async () => {
    const { listener } = createTestApp();
    const a = await onboarded(listener, 'Ania');
    const b = await onboarded(listener, 'Bartek');
    await onboarded(listener, 'Basia');
    await listener(); // a guest who never finished onboarding

    await a.agent.put(`/api/users/${b.me.id}/follow`).send({ following: true }).expect(200);
    const all = (await a.agent.get('/api/users').expect(200)).body.people;
    expect(all.map((p: { displayName: string }) => p.displayName)).toEqual(['Bartek', 'Basia']);
    const search = (await a.agent.get('/api/users?q=bas').expect(200)).body.people;
    expect(search.map((p: { displayName: string }) => p.displayName)).toEqual(['Basia']);
  });

  it('shows recent likes and saves on profiles, unless the listener keeps them private', async () => {
    const { listener } = createTestApp();
    const a = await onboarded(listener, 'Ania');
    const b = await onboarded(listener, 'Bartek');
    await b.agent.put(`/api/songs/${RICK}/save`).send({ saved: true }).expect(200);
    await b.agent.put(`/api/songs/${DESPACITO}/reaction`).send({ value: 1 }).expect(200);

    const visible = (await a.agent.get(`/api/users/${b.me.id}`).expect(200)).body.activity;
    expect(visible.saved.map((s: { id: string }) => s.id)).toEqual([RICK]);
    expect(visible.liked.map((s: { id: string }) => s.id)).toEqual([DESPACITO]);

    await b.agent.patch('/api/me').send({ settings: { shareActivity: false } }).expect(200);
    expect((await a.agent.get(`/api/users/${b.me.id}`).expect(200)).body.activity).toBeNull();
    // You always see your own.
    expect((await b.agent.get(`/api/users/${b.me.id}`).expect(200)).body.activity.saved).toHaveLength(1);
  });
});

describe('the Friends feed', () => {
  it('shows what the people you follow liked and saved, most recent first', async () => {
    const { listener, advance } = createTestApp();
    const me = await onboarded(listener, 'Szymon');
    const ania = await onboarded(listener, 'Ania');
    const bartek = await onboarded(listener, 'Bartek');
    const stranger = await onboarded(listener, 'Stranger');
    await me.agent.put(`/api/users/${ania.me.id}/follow`).send({ following: true });
    await me.agent.put(`/api/users/${bartek.me.id}/follow`).send({ following: true });

    await ania.agent.put(`/api/songs/${RICK}/reaction`).send({ value: 1 });
    advance(1000);
    await bartek.agent.put(`/api/songs/${RICK}/save`).send({ saved: true });
    advance(1000);
    await ania.agent.put(`/api/songs/${DESPACITO}/reaction`).send({ value: 1 });
    await stranger.agent.put(`/api/songs/${SHAPE}/save`).send({ saved: true });

    const items = (await me.agent.post('/api/feed').send({ mode: 'friends' }).expect(200)).body.items as FeedItem[];
    expect(items.map((i) => [i.id, i.reason])).toEqual([
      [DESPACITO, 'Liked by Ania'],
      [RICK, 'Saved by Bartek and Ania'],
    ]);

    // Paging and personal dislikes.
    const next = (await me.agent.post('/api/feed').send({ mode: 'friends', exclude: [DESPACITO] }).expect(200)).body.items as FeedItem[];
    expect(next.map((i) => i.id)).toEqual([RICK]);
    await me.agent.put(`/api/songs/${RICK}/reaction`).send({ value: -1 });
    const afterDislike = (await me.agent.post('/api/feed').send({ mode: 'friends' }).expect(200)).body.items as FeedItem[];
    expect(afterDislike.map((i) => i.id)).toEqual([DESPACITO]);

    // Private listeners drop out.
    await ania.agent.patch('/api/me').send({ settings: { shareActivity: false } });
    expect((await me.agent.post('/api/feed').send({ mode: 'friends' }).expect(200)).body.items).toEqual([]);
  });

  it('nudges "For you" towards songs friends love', async () => {
    const catalog = [entry('friendSong1', 'Some Band', 'Song A', ['rock']), entry('otherSong01', 'Other Band', 'Song B', ['rock'])];
    const { listener } = createTestApp({ catalog });
    const me = await onboarded(listener, 'Szymon');
    const ania = await onboarded(listener, 'Ania');
    await me.agent.put(`/api/users/${ania.me.id}/follow`).send({ following: true });
    await ania.agent.put('/api/songs/friendSong1/reaction').send({ value: 1 });

    const items = (await me.agent.post('/api/feed').send({ limit: 2 }).expect(200)).body.items as FeedItem[];
    expect(items[0]).toMatchObject({ id: 'friendSong1', reason: 'Loved by people you follow' });
  });
});

describe('learned hooks', () => {
  it('learns where the hook is from where listeners jump to', async () => {
    const { listener, db } = createTestApp();
    const a = await listener();
    const b = await listener();
    const c = await listener();
    await a.agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 40, hookSec: 62 }).expect(204);
    expect((await a.agent.get(`/api/songs/${RICK}`).expect(200)).body.hookSec).toBeNull();
    await b.agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 40, hookSec: 70 }).expect(204);
    expect((await a.agent.get(`/api/songs/${RICK}`).expect(200)).body.hookSec).toBe(66);
    // Nonsense positions are ignored.
    await c.agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 40, hookSec: 99999 }).expect(204);
    await c.agent.post(`/api/songs/${RICK}/seen`).send({ watchedSec: 40, hookSec: 2 }).expect(204);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hook_votes WHERE song_id = ?', [RICK])!.n).toBe(2);
  });
});
