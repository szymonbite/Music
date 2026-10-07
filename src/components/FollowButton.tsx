import { useState } from 'react';
import type { PublicUser } from '../../shared/types.ts';
import { api } from '../api.ts';
import { errorMessage } from '../lib/format.ts';
import { useToast } from '../toast.tsx';

/** Follow / Following toggle. Reports the new follower count so lists can update. */
export function FollowButton({ user, onChange }: { user: PublicUser; onChange: (following: boolean, followers: number) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (user.isMe) return null;

  const toggle = async () => {
    const following = !user.isFollowing;
    setBusy(true);
    onChange(following, Math.max(0, user.followers + (following ? 1 : -1)));
    try {
      const res = await api.follow(user.id, following);
      onChange(res.following, res.followers);
    } catch (err) {
      onChange(!following, user.followers);
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`btn btn--small ${user.isFollowing ? 'btn--ghost' : 'btn--primary'}`}
      aria-pressed={user.isFollowing}
      aria-label={`${user.isFollowing ? 'Unfollow' : 'Follow'} ${user.displayName}`}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
    >
      {user.isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}
