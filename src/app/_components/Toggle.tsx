"use client";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  size?: "sm" | "lg";
}

export function Toggle({ checked, onChange, label, size = "sm" }: ToggleProps) {
  const lg = size === "lg";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        lg ? "h-8 w-14" : "h-6 w-11"
      } ${
        checked
          ? "border-glow/40 bg-glow/25"
          : "border-border bg-panel-2"
      }`}
    >
      <span
        className={`inline-block transform rounded-full transition-transform duration-300 ease-out ${
          lg ? "h-6 w-6" : "h-4 w-4"
        } ${
          checked
            ? `${lg ? "translate-x-7" : "translate-x-6"} bg-glow shadow-[0_0_12px_var(--glow)]`
            : "translate-x-1 bg-muted"
        }`}
      />
    </button>
  );
}
