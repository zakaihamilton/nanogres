"use client";

import { Children, isValidElement, type ReactNode } from "react";
import { Select as PanelSelect, type SelectOption } from "panel-frame-ui";

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

function optionText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return optionText(value.props.children);
  return "";
}

export function Select({
  align = "start",
  children,
  className = "",
  onChange,
  ...props
}: SelectProps) {
  const options = Children.toArray(children).flatMap((child): SelectOption[] => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option") return [];
    const label = child.props.children;
    return [
      {
        value: String(child.props.value ?? optionText(label)),
        label,
        searchLabel: optionText(label),
        disabled: child.props.disabled,
      },
    ];
  });

  return (
    <PanelSelect
      {...props}
      align={align}
      className={className}
      onValueChange={onChange}
      options={options}
    />
  );
}
