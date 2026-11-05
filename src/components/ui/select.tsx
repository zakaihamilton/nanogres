"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./select.module.css";

type OptionProps = {
  children?: ReactNode;
  disabled?: boolean;
  value?: string;
};

type SelectProps = {
  align?: "start" | "end";
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "grammar" | "spelling" | "true";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  children: ReactNode;
  className?: string;
  defaultValue?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  value?: string;
};

type SelectOption = {
  disabled: boolean;
  label: ReactNode;
  searchLabel: string;
  value: string;
};

type PopupPosition = {
  left: number;
  maxHeight: number;
  minWidth: number;
  top: number;
};

function optionText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionText).join("");
  return "";
}

export function Select({
  align = "start",
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  children,
  className = "",
  defaultValue,
  disabled = false,
  id,
  name,
  onChange,
  required = false,
  value,
}: SelectProps) {
  const options = Children.toArray(children).flatMap((child): SelectOption[] => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option") return [];
    const optionValue = String(child.props.value ?? optionText(child.props.children));
    return [
      {
        disabled: child.props.disabled ?? false,
        label: child.props.children,
        searchLabel: optionText(child.props.children).trim().toLocaleLowerCase(),
        value: optionValue,
      },
    ];
  });

  const idSeed = useId();
  const triggerId = id ?? `${idSeed}-trigger`;
  const listboxId = `${idSeed}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef("");
  const [internalValue, setInternalValue] = useState(
    () =>
      defaultValue ?? options.find((option) => !option.disabled)?.value ?? options[0]?.value ?? "",
  );
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popupPosition, setPopupPosition] = useState<PopupPosition | null>(null);
  const currentValue = value ?? internalValue;
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const successfulValue = selectedOption ? selectedOption.value : "";

  function openMenu(index = selectedIndex) {
    const nextIndex =
      options[index] && !options[index].disabled
        ? index
        : options.findIndex((option) => !option.disabled);
    setActiveIndex(nextIndex < 0 ? 0 : nextIndex);
    setPopupPosition(null);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    setPopupPosition(null);
    typeaheadRef.current = "";
  }

  function chooseOption(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    if (value === undefined) setInternalValue(option.value);
    setInvalid(false);
    closeMenu();
    onChange?.(option.value);
    triggerRef.current?.focus();
  }

  function moveActive(direction: 1 | -1) {
    if (!options.length) return;
    let nextIndex = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      nextIndex = (nextIndex + direction + options.length) % options.length;
      if (!options[nextIndex].disabled) {
        setActiveIndex(nextIndex);
        return;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const candidates = options
        .map((option, index) => (option.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (!open) setOpen(true);
      setActiveIndex(event.key === "Home" ? (candidates[0] ?? 0) : (candidates.at(-1) ?? 0));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) chooseOption(activeIndex);
      else openMenu();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const character = event.key.toLocaleLowerCase();
      const findMatch = (prefix: string) => {
        const start = open ? activeIndex + 1 : selectedIndex + 1;
        return options
          .map((_, index) => (start + index) % options.length)
          .find(
            (index) => !options[index].disabled && options[index].searchLabel.startsWith(prefix),
          );
      };
      let prefix = typeaheadRef.current + character;
      let match = findMatch(prefix);
      if (match === undefined) {
        prefix = character;
        match = findMatch(prefix);
      }
      typeaheadRef.current = prefix;
      if (match !== undefined) {
        setActiveIndex(match);
        setOpen(true);
        setPopupPosition(null);
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        closeMenu();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;

    function updatePosition() {
      const rect = trigger!.getBoundingClientRect();
      const desiredHeight = Math.min(280, Math.max(40, options.length * 40 + 8));
      const roomBelow = window.innerHeight - rect.bottom - 12;
      const roomAbove = rect.top - 12;
      const openAbove = roomBelow < desiredHeight && roomAbove > roomBelow;
      const maxHeight = Math.max(64, Math.min(desiredHeight, openAbove ? roomAbove : roomBelow));
      const minWidth = Math.min(rect.width, window.innerWidth - 16);
      const preferredLeft = align === "end" ? rect.right - minWidth : rect.left;
      const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - minWidth - 8));
      const top = openAbove
        ? Math.max(8, rect.top - maxHeight - 6)
        : Math.min(rect.bottom + 6, window.innerHeight - maxHeight - 8);
      setPopupPosition({ left, maxHeight, minWidth, top });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open, options.length]);

  useEffect(() => {
    if (!open || !popupPosition) return;
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;

    const width = popup.getBoundingClientRect().width;
    const triggerRect = trigger.getBoundingClientRect();
    const preferredLeft = align === "end" ? triggerRect.right - width : triggerRect.left;
    const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8));
    if (Math.abs(left - popupPosition.left) > 1) {
      setPopupPosition((current) => (current ? { ...current, left } : current));
    }
  }, [align, open, popupPosition]);

  useEffect(() => {
    if (open && activeIndex >= 0) {
      document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [activeIndex, listboxId, open]);

  const listbox =
    open && popupPosition
      ? createPortal(
          <div
            aria-labelledby={triggerId}
            className={styles.listbox}
            id={listboxId}
            ref={popupRef}
            role="listbox"
            style={{
              left: popupPosition.left,
              maxHeight: popupPosition.maxHeight,
              minWidth: popupPosition.minWidth,
              top: popupPosition.top,
            }}
          >
            {options.map((option, index) => (
              <div
                aria-disabled={option.disabled || undefined}
                aria-selected={option.value === currentValue}
                className={styles.option}
                data-active={activeIndex === index}
                id={`${listboxId}-option-${index}`}
                key={`${option.value}-${index}`}
                onClick={() => chooseOption(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    chooseOption(index);
                  }
                }}
                onPointerMove={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                role="option"
                tabIndex={-1}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {option.value === currentValue ? (
                  <span aria-hidden="true" className={styles.checkmark}>
                    ✓
                  </span>
                ) : null}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={styles.root} data-select-root ref={rootRef}>
      <select
        aria-hidden="true"
        className={styles.nativeSelect}
        disabled={disabled}
        name={name}
        onChange={() => undefined}
        onInvalid={(event) => {
          event.preventDefault();
          setInvalid(true);
          openMenu();
          triggerRef.current?.focus();
        }}
        required={required}
        tabIndex={-1}
        value={successfulValue}
      >
        {options.map((option, index) => (
          <option disabled={option.disabled} key={`${option.value}-${index}`} value={option.value}>
            {optionText(option.label)}
          </option>
        ))}
      </select>
      <button
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-controls={listboxId}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || ariaInvalid || undefined}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-required={required || undefined}
        className={`${styles.trigger} ${className}`.trim()}
        data-select-trigger
        disabled={disabled}
        id={triggerId}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        type="button"
        role="combobox"
      >
        <span className={styles.value}>{selectedOption?.label ?? "Choose an option"}</span>
        <span aria-hidden="true" className={styles.chevron} />
      </button>
      {listbox}
    </div>
  );
}
