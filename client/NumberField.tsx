import { useId } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface NumberFieldProps {
  id?: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
  disabled?: boolean;
}

export function NumberField({ id, label, value, min, max, step = 1, onChange, className = '', disabled = false }: NumberFieldProps) {
  const generatedId = useId();
  const inputId = id || `number-${generatedId}`;
  const decreaseDisabled = min !== undefined && value <= min;
  const increaseDisabled = max !== undefined && value >= max;

  return (
    <div className={`number-field ${className}`.trim()}>
      <label className="number-label" htmlFor={inputId}>{label}</label>
      <div className="number-input-wrap">
        <input
          id={inputId}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <div className="number-stepper">
          <button
            type="button"
            aria-label={`Increase ${label}`}
            onClick={() => onChange(Math.min(max ?? Number.MAX_SAFE_INTEGER, value + step))}
            disabled={disabled || increaseDisabled}
          ><ChevronUp size={13} aria-hidden="true" /></button>
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            onClick={() => onChange(Math.max(min ?? Number.MIN_SAFE_INTEGER, value - step))}
            disabled={disabled || decreaseDisabled}
          ><ChevronDown size={13} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
}
