/**
 * EU date/time input component.
 *
 * Displays and accepts dates in DD-MM-YYYY HH:MM format.
 * Stores and exposes the value in that same EU format.
 *
 * Conversion helpers (`euToIso`, `isoToEu`, etc.) live in `utils/dateTime.ts`.
 */

interface EuDateInputProps {
  value: string;                              // EU format "DD-MM-YYYY HH:MM"
  onChange: (eu: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function EuDateInput({
  value,
  onChange,
  placeholder = 'DD-MM-YYYY HH:MM',
  disabled,
  className,
}: EuDateInputProps) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      pattern="\d{2}-\d{2}-\d{4} \d{2}:\d{2}"
      title="Date format: DD-MM-YYYY HH:MM"
      disabled={disabled}
      className={className}
      style={{ minWidth: 160 }}
    />
  );
}
