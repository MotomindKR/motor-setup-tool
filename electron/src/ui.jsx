import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { inputNumberFormat } from "./format.mjs";
import { Button } from "@motomindkr/ui/components/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@motomindkr/ui/components/card";
import { Input } from "@motomindkr/ui/components/input";
import { Checkbox } from "@motomindkr/ui/components/checkbox";
import {
  Field as UIField,
  FieldLabel,
  FieldDescription,
} from "@motomindkr/ui/components/field";
import {
  Empty as UIEmpty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@motomindkr/ui/components/empty";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@motomindkr/ui/components/toggle-group";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@motomindkr/ui/components/accordion";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
} from "@motomindkr/ui/components/number-field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@motomindkr/ui/components/select";
export { Button };

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
  size = "md",
}) {
  return (
    <Card size={size} className={className}>
      {(title || description || action) && (
        <CardHeader>
          {title && (
            <CardTitle>
              <h2>{title}</h2>
            </CardTitle>
          )}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
  );
}
export function NumericInput({
  value,
  onValueChange,
  id,
  min,
  max,
  step,
  disabled,
  placeholder,
  significantDigits,
  ...props
}) {
  const input = useRef(null);
  const [unparsedText, setUnparsedText] = useState(null);
  useLayoutEffect(() => {
    if (unparsedText === null) return;
    // NumberField can display a partial entry such as "." without emitting a value.
    if (input.current.value === unparsedText) onValueChange("");
    setUnparsedText(null);
  }, [unparsedText, onValueChange]);
  return (
    <NumberField
      data-slot="number-field"
      value={value === "" || value == null ? null : Number(value)}
      onValueChange={(next, details) => {
        setUnparsedText(null);
        // Display rounding must not rewrite a valid numeric value on blur.
        const raw = value === "" || value == null ? null : Number(value);
        if (
          details.reason === "input-blur" &&
          raw != null &&
          (min == null || raw >= Number(min)) &&
          (max == null || raw <= Number(max))
        ) {
          details.cancel();
          return;
        }
        onValueChange(next == null ? "" : String(next));
      }}
      min={min == null ? undefined : Number(min)}
      max={max == null ? undefined : Number(max)}
      step={step === "any" ? undefined : Number(step ?? 1)}
      disabled={disabled}
      format={inputNumberFormat({ step, min, significantDigits })}
    >
      <NumberFieldGroup>
        <NumberFieldInput
          id={id}
          placeholder={placeholder}
          {...props}
          ref={input}
          onChangeCapture={event => setUnparsedText(event.currentTarget.value)}
        />
      </NumberFieldGroup>
    </NumberField>
  );
}
export function Field({ label, unit, hint, children, type, ...props }) {
  const id = useId();
  return (
    <UIField
      className="field"
      data-disabled={props.disabled || children?.props.disabled || undefined}
    >
      <FieldLabel htmlFor={id}>
        {label}
        {unit && <span className="unit">{unit}</span>}
      </FieldLabel>
      {children ? (
        React.cloneElement(children, { id })
      ) : type === "number" ? (
        <NumericInput id={id} {...props} />
      ) : (
        <Input id={id} type={type} {...props} />
      )}
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </UIField>
  );
}
export function Choice({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  id,
  label,
}) {
  return (
    <Select
      value={value === "" || value == null ? null : value}
      items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
      onValueChange={(value) => onChange(value ?? "")}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} className="choice">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function Check({ checked, onChange, disabled, children }) {
  const id = useId();
  return (
    <UIField
      orientation="horizontal"
      className="check-field"
      data-disabled={disabled || undefined}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
      <FieldLabel htmlFor={id}>{children}</FieldLabel>
    </UIField>
  );
}
export function Segments({ value, onChange, options, label }) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(values) => {
        if (values.length) onChange(values[0]);
      }}
      aria-label={label}
    >
      {options.map(([key, text]) => (
        <ToggleGroupItem key={key} value={key}>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
export function Empty({
  icon: Icon,
  title,
  children,
  action,
  compact = false,
}) {
  return (
    <UIEmpty className={compact ? "empty-compact" : undefined}>
      <EmptyHeader>
        {Icon && (
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
        )}
        <EmptyTitle>
          <h3>{title}</h3>
        </EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </UIEmpty>
  );
}

export function Disclosure({ title, children, className = "" }) {
  return (
    <Accordion className={className}>
      <AccordionItem value="content">
        <AccordionTrigger>{title}</AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function Metric({ label, value, unit, detail }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}
