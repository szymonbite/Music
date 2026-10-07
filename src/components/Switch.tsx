import { useId } from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="switch-row">
      <div className="switch-row__text">
        <span id={labelId} className="switch-row__label">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="switch-row__description">
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__knob" />
      </button>
    </div>
  );
}
