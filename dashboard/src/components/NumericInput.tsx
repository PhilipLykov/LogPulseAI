import { useState } from 'react';

/**
 * A number input that allows the user to freely type (including clearing
 * the field) without snapping back to a default value.
 *
 * The parsed number is committed to the parent on blur or Enter.
 * While focused, the component manages its own raw string state.
 */
interface NumericInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number | string; // reserved for future use
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  className,
  style,
  disabled,
}: NumericInputProps) {
  const safeStr = (v: number) => String(isNaN(v) ? (min ?? 0) : v);
  const [raw, setRaw] = useState(safeStr(value));
  const [isFocused, setIsFocused] = useState(false);

  const commit = () => {
    let n = parseFloat(raw);
    if (isNaN(n)) n = min ?? 0;
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    setRaw(String(n));
    onChange(n);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={isFocused ? raw : safeStr(value)}
      onChange={(e) => setRaw(e.target.value)}
      onFocus={() => {
        setIsFocused(true);
        setRaw(safeStr(value));
      }}
      onBlur={() => {
        setIsFocused(false);
        commit();
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      className={className}
      style={style}
      disabled={disabled}
    />
  );
}
