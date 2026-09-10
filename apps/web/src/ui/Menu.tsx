import { useEffect, useId, useRef, useState } from "react";
import "./Menu.css";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

/**
 * The small menu the wallet and history live behind (spec section 2). It closes
 * on Escape, on a click elsewhere and after a choice, moves focus back to the
 * button, and is reachable entirely from the keyboard.
 */
export function Menu({
  label,
  items,
  children,
}: {
  label: string;
  items: MenuItem[];
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: MouseEvent): void => {
      if (root.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        ref={button}
        className="btn btn-sm menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        {children}
      </button>
      {open ? (
        <div className="menu-panel" id={id} role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.tone === "danger" ? "menu-item is-danger" : "menu-item"}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="menu-item-label">{item.label}</span>
              {item.hint === undefined ? null : <span className="menu-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
