/** Fener logosu: amber degrade kare içinde parlayan nokta. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[9px] shadow-[0_0_20px_oklch(0.77_0.16_68/0.55)]"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(150deg, oklch(0.86 0.14 82), oklch(0.7 0.18 52))",
      }}
    >
      <span
        className="rounded-full bg-white shadow-[0_0_0_4px_rgba(255,255,255,.35)]"
        style={{ width: size * 0.375, height: size * 0.375 }}
      />
    </span>
  );
}
