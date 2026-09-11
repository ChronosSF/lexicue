import type { TargetLanguage } from "@lexicue/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./LanguagePicker.css";

/**
 * The searchable target list of spec section 3.3, regional variants included.
 * It is a combobox rather than a select because forty languages with variants
 * is a list you type into, and because the variants have to sit visibly next to
 * each other: Spanish for Spain or Latin America, Simplified or Traditional
 * Chinese.
 */
export function LanguagePicker({
  languages,
  value,
  onChange,
}: {
  languages: TargetLanguage[];
  value: string | null;
  onChange: (code: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputId = useId();
  const root = useRef<HTMLDivElement>(null);

  const selected = languages.find((language) => language.code === value) ?? null;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return languages;
    return languages.filter(
      (language) =>
        language.name.toLowerCase().includes(needle) ||
        language.code.toLowerCase().startsWith(needle),
    );
  }, [languages, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent): void => {
      if (root.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const choose = (language: TargetLanguage): void => {
    onChange(language.code);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="field language-picker" ref={root}>
      <label className="label" htmlFor={inputId}>
        Target language
      </label>
      <div className="language-input-row">
        <input
          id={inputId}
          className="input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={selected === null ? "Search 42 languages" : selected.name}
          value={query}
          onFocus={() => {
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((current) => {
                const next = event.key === "ArrowDown" ? current + 1 : current - 1;
                return Math.max(0, Math.min(matches.length - 1, next));
              });
              return;
            }
            if (event.key === "Enter" && open) {
              const language = matches[active];
              if (language !== undefined) {
                event.preventDefault();
                choose(language);
              }
              return;
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {selected === null ? null : <span className="chip chip-accent">{selected.name}</span>}
      </div>

      {open ? (
        <ul className="language-list" id={listId} role="listbox" aria-label="Target language">
          {matches.length === 0 ? (
            <li className="language-empty muted">No language matches “{query}”.</li>
          ) : (
            matches.map((language, index) => (
              <li key={language.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={language.code === value}
                  className={[
                    "language-option",
                    index === active ? "is-active" : "",
                    language.code === value ? "is-chosen" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    choose(language);
                  }}
                >
                  <span>{language.name}</span>
                  <span className="language-code faint mono">{language.code}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {selected?.hasFormalityDistinction === true ? (
        <p className="hint">
          {selected.name} distinguishes formal and informal address, so the formality setting below
          matters here.
        </p>
      ) : null}
    </div>
  );
}
