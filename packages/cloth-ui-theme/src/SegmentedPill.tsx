interface SegmentedPillProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

export function SegmentedPill<T extends string>({ options, value, onChange, label }: SegmentedPillProps<T>) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl bg-[#F3F1EC] p-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-3 py-2 text-sm transition ${value === option.value ? "bg-white text-[#141413] shadow-sm" : "text-[#63615C] hover:text-[#141413]"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
