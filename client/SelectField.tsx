import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  id?: string;
  label?: string;
  ariaLabel?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function SelectField({
  id,
  label,
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = 'Choose an option',
  disabled = false,
  className = '',
}: SelectFieldProps) {
  const generatedId = useId();
  const triggerId = id || `select-${generatedId}`;
  const listboxId = `${triggerId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef('');
  const typeaheadTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({});
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const selectedOption = options.find((option) => option.value === value && !option.disabled);

  function keepTriggerVisible() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.top < 8 || rect.bottom > window.innerHeight - 8 || rect.left < 8 || rect.right > window.innerWidth - 8) {
      trigger.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  const findEnabled = (start: number, direction: 1 | -1) => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + direction * offset + options.length * 2) % options.length;
      if (!options[index].disabled) return index;
    }
    return -1;
  };

  function openAt(index = selectedIndex >= 0 ? selectedIndex : findEnabled(0, 1)) {
    if (disabled || !options.some((option) => !option.disabled)) return;
    keepTriggerVisible();
    setActiveIndex(index);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openAt();
        return;
      }
      const start = activeIndex < 0
        ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
        : activeIndex + (event.key === 'ArrowDown' ? 1 : -1);
      setActiveIndex(findEnabled(start, event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const index = event.key === 'Home' ? findEnabled(0, 1) : findEnabled(options.length - 1, -1);
      keepTriggerVisible();
      setActiveIndex(index);
      setOpen(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && activeIndex >= 0) choose(activeIndex);
      else openAt();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const nextQuery = `${typeahead.current}${event.key}`.toLocaleLowerCase();
      typeahead.current = nextQuery;
      if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current);
      typeaheadTimer.current = window.setTimeout(() => { typeahead.current = ''; }, 700);
      const start = activeIndex >= 0 ? activeIndex + 1 : selectedIndex + 1;
      const order = options.map((_, index) => (start + index + options.length) % options.length);
      const match = order.find((index) =>
        !options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(nextQuery),
      );
      if (match === undefined && nextQuery.length > 1) {
        typeahead.current = event.key.toLocaleLowerCase();
        const repeatedMatch = options.findIndex((option) =>
          !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead.current),
        );
        if (repeatedMatch >= 0) {
          keepTriggerVisible();
          setActiveIndex(repeatedMatch);
          setOpen(true);
        }
      } else if (match !== undefined) {
        keepTriggerVisible();
        setActiveIndex(match);
        setOpen(true);
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target) && !listboxRef.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      let rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.top < 8 || rect.bottom > window.innerHeight - 8) {
        triggerRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
      }
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 10);
      const spaceAbove = Math.max(0, rect.top - 10);
      const desiredHeight = Math.min(280, Math.max(120, options.length * 40 + 10));
      const opensAbove = spaceBelow < Math.min(desiredHeight, 180) && spaceAbove > spaceBelow;
      const availableSpace = Math.max(40, opensAbove ? spaceAbove : spaceBelow);
      const maxHeight = Math.min(desiredHeight, availableSpace, Math.max(40, window.innerHeight - 16));
      const desiredTop = opensAbove ? rect.top - maxHeight - 6 : rect.bottom + 6;
      const top = Math.max(8, Math.min(desiredTop, window.innerHeight - maxHeight - 8));
      const width = Math.min(rect.width, Math.max(40, window.innerWidth - 16));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setMenuPosition({ top, left, width, maxHeight });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listboxRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listboxId}-option-${activeIndex}`)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId, open]);

  useEffect(() => () => {
    if (typeaheadTimer.current !== undefined) window.clearTimeout(typeaheadTimer.current);
  }, []);

  return (
    <div className={`select-field ${className}`.trim()} ref={rootRef}>
      {label && <label className="select-label" htmlFor={triggerId}>{label}</label>}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-label={label ? undefined : ariaLabel}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openAt()}
        onKeyDown={onKeyDown}
      >
        <span className={selectedOption ? '' : 'select-placeholder'}>{selectedOption?.label || placeholder}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={listboxRef}
          id={listboxId}
          className="select-menu"
          role="listbox"
          aria-label={label || ariaLabel}
          style={menuPosition}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${listboxId}-option-${index}`}
              className="select-option"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={index === activeIndex || undefined}
              onPointerMove={() => !option.disabled && setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              {option.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
