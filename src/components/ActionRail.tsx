import type { FeedItem, ReactionValue } from '../../shared/types.ts';
import { formatCount } from '../lib/format.ts';
import { Icon, type IconName } from './Icon.tsx';

export interface ActionHandlers {
  onReact: (item: FeedItem, value: ReactionValue) => void;
  onComments: (item: FeedItem) => void;
  onSave: (item: FeedItem) => void;
  onShare: (item: FeedItem) => void;
}

interface RailButtonProps {
  icon: IconName;
  label: string;
  count?: number;
  pressed?: boolean;
  tone?: 'like' | 'dislike' | 'save';
  onClick: () => void;
}

function RailButton({ icon, label, count, pressed, tone, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      className={`rail__btn${tone ? ` rail__btn--${tone}` : ''}`}
      aria-pressed={pressed}
      aria-label={count === undefined ? label : `${label} (${formatCount(count)})`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="rail__icon">
        <Icon name={icon} size={28} filled={pressed} />
      </span>
      {count !== undefined && (
        <span className="rail__count" aria-hidden="true">
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

/** Like / dislike / comment / save / share buttons on the right of each song. */
export function ActionRail({ item, onReact, onComments, onSave, onShare }: { item: FeedItem } & ActionHandlers) {
  const liked = item.me.reaction === 1;
  const disliked = item.me.reaction === -1;
  return (
    <div className="rail">
      <RailButton icon="heart" label="Like" tone="like" pressed={liked} count={item.stats.likes} onClick={() => onReact(item, liked ? 0 : 1)} />
      <RailButton icon="thumbDown" label="Dislike" tone="dislike" pressed={disliked} onClick={() => onReact(item, disliked ? 0 : -1)} />
      <RailButton icon="comment" label="Comments" count={item.stats.comments} onClick={() => onComments(item)} />
      <RailButton icon="bookmark" label="Save" tone="save" pressed={item.me.saved} count={item.stats.saves} onClick={() => onSave(item)} />
      <RailButton icon="share" label="Share" onClick={() => onShare(item)} />
    </div>
  );
}
