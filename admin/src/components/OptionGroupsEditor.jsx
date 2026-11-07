import { emptyGroup, emptyOption, MAX_GROUPS, MAX_OPTIONS } from '../lib/optionGroups.js';
import { Button, IconButton } from './Button.jsx';
import { Checkbox, Input } from './Field.jsx';
import { PlusIcon, TrashIcon } from './icons.jsx';

/**
 * Edits an item's option groups ("Size": Regular / Large +₹100, "Toppings": multiple, required ...).
 * Controlled: `groups` come from the parent, `onChange(nextGroups)` returns the new array.
 * `errors` is the array from validateGroups() (or null).
 */
export default function OptionGroupsEditor({ groups, onChange, errors, disabled }) {
  const updateGroup = (gi, patch) => onChange(groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  const updateOption = (gi, oi, patch) =>
    updateGroup(gi, { options: groups[gi].options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });

  return (
    <div className="space-y-3">
      {groups.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-500">
          No options yet. Add a group like &ldquo;Size&rdquo; or &ldquo;Extra toppings&rdquo; if diners can customise this dish.
        </p>
      )}

      {groups.map((group, gi) => {
        const ge = errors?.[gi];
        return (
          <fieldset key={group.key} disabled={disabled} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4">
            <legend className="sr-only">Option group {gi + 1}</legend>
            <div className="flex items-start gap-2">
              <Input
                label="Group name"
                value={group.name}
                onChange={(e) => updateGroup(gi, { name: e.target.value })}
                error={ge?.name}
                placeholder="e.g. Size, Toppings"
                maxLength={80}
                wrapperClassName="min-w-0 flex-1"
              />
              <IconButton label={`Remove option group ${gi + 1}`} icon={TrashIcon} variant="danger" onClick={() => onChange(groups.filter((_, i) => i !== gi))} className="mt-6" />
            </div>

            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <Checkbox label="Allow multiple choices" checked={group.multi_select} onChange={(v) => updateGroup(gi, { multi_select: v })} />
              <Checkbox label="Required" checked={group.required} onChange={(v) => updateGroup(gi, { required: v })} />
            </div>

            <p className="mt-3 text-xs text-slate-500">Options, with the extra price (₹) each one adds to the dish.</p>
            <ul className="mt-2 space-y-2">
              {group.options.map((option, oi) => (
                <li key={option.key} className="flex items-start gap-2">
                  <Input
                    label={`Option ${oi + 1} name`}
                    labelHidden
                    value={option.name}
                    onChange={(e) => updateOption(gi, oi, { name: e.target.value })}
                    error={ge?.options?.[oi]?.name}
                    placeholder="Option name"
                    maxLength={80}
                    wrapperClassName="min-w-0 flex-1"
                  />
                  <Input
                    label={`Option ${oi + 1} extra price`}
                    labelHidden
                    value={option.price}
                    onChange={(e) => updateOption(gi, oi, { price: e.target.value })}
                    error={ge?.options?.[oi]?.price}
                    inputMode="decimal"
                    placeholder="0"
                    prefix="₹"
                    wrapperClassName="w-24 shrink-0 sm:w-28"
                  />
                  <IconButton
                    label={`Remove option ${oi + 1} from group ${gi + 1}`}
                    icon={TrashIcon}
                    variant="danger"
                    disabled={group.options.length === 1}
                    onClick={() => updateGroup(gi, { options: group.options.filter((_, i) => i !== oi) })}
                  />
                </li>
              ))}
            </ul>
            {ge?.general && <p className="mt-2 text-xs font-medium text-red-700">{ge.general}</p>}

            <Button
              variant="secondary"
              size="sm"
              icon={PlusIcon}
              className="mt-3"
              disabled={group.options.length >= MAX_OPTIONS}
              onClick={() => updateGroup(gi, { options: [...group.options, emptyOption()] })}
            >
              Add option
            </Button>
          </fieldset>
        );
      })}

      <Button variant="secondary" size="sm" icon={PlusIcon} disabled={disabled || groups.length >= MAX_GROUPS} onClick={() => onChange([...groups, emptyGroup()])}>
        Add option group
      </Button>
    </div>
  );
}
