import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

/** A labelled block inside a panel: a heading line with an optional value, then the control itself. */
export function Field({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span>{label}</span>
        {value === undefined ? null : <strong>{value}</strong>}
      </div>
      {children}
    </div>
  );
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

/** One choice from a few, as a row of buttons sharing a track. */
export function Segmented<T extends string>({
  label,
  value,
  choices,
  columns,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  columns?: number | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="segmented"
      role="group"
      aria-label={label}
      style={columns === undefined ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className={choice.value === value ? "is-active" : ""}
          disabled={choice.disabled ?? false}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** A layer or option that is on or off, with a dot that reads as the layer's colour on screen. */
export function Toggle({
  label,
  pressed,
  disabled,
  swatch,
  onChange,
}: {
  label: string;
  pressed: boolean;
  disabled?: boolean | undefined;
  swatch?: string | undefined;
  onChange: (pressed: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={pressed}
      disabled={disabled ?? false}
      onClick={() => onChange(!pressed)}
    >
      <span className="toggle-box" aria-hidden="true">
        {pressed ? <Icon name="check" /> : null}
      </span>
      <span className="toggle-label">{label}</span>
      {swatch === undefined ? null : <i className="toggle-swatch" style={{ background: swatch }} />}
    </button>
  );
}

export function ProgressBar({ label, fraction }: { label: string; fraction: number }) {
  const percent = Math.round(fraction * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A short line of supporting text under a control, or an error in its place. */
export function Note({ children, tone }: { children: ReactNode; tone?: "error" | "warning" | undefined }) {
  return <p className={tone === undefined ? "note" : `note note-${tone}`}>{children}</p>;
}

/**
 * A button that opens a panel beneath it. Closes on a click outside, on Escape
 * and on choosing something inside, so it never has to be dismissed twice.
 */
export function Menu({
  label,
  icon,
  disabled,
  align = "end",
  children,
}: {
  label: string;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
  align?: "start" | "end" | undefined;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || wrapper.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu" ref={wrapper}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="menu" disabled={disabled ?? false} onClick={() => setOpen((shown) => !shown)}>
        {icon === undefined ? null : <Icon name={icon} />}
        {label}
        <Icon name="chevronDown" />
      </button>
      {open ? (
        <div className={`menu-popover menu-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** One line in a menu: a name, what it produces, and why it is unavailable when it is. */
export function MenuItem({
  label,
  hint,
  icon,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  hint?: string | undefined;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  onClick: () => void;
}) {
  return (
    <button type="button" className="menu-item" role="menuitem" disabled={disabled ?? false} aria-busy={busy ?? false} onClick={onClick}>
      {icon === undefined ? null : <Icon name={icon} />}
      <span>
        <strong>{busy === true ? "Preparing…" : label}</strong>
        {hint === undefined ? null : <small>{hint}</small>}
      </span>
    </button>
  );
}
