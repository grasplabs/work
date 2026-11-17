// The bar above a Data table: the search, the Filter builder, the chosen rows' count (and what can
// be done to them while some are chosen), Export CSV and the View menu. Every control in it is the
// search field's height (md, 36px), so their edges meet along the bar.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";

import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { FilterBuilder } from "../filter-builder";
import type { FilterField } from "../filter-builder";
import { Download, Search, Sliders } from "../icons";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../input-group";
import { styles } from "./styles";
import type { DataTableAction, DataTableProps } from "./types";
import type { Model } from "./use-data-table";
import type { DataTableWords } from "./words";

interface BarProps<Row extends RowData> {
  model: Model<Row>;
  props: DataTableProps<Row>;
  words: DataTableWords;
  fields: FilterField[];
  many: string;
  onAct: (action: DataTableAction) => void;
  onAsk: (action: DataTableAction) => void;
  onExport: () => void;
}

const ViewMenu = <Row extends RowData>({
  model,
  words,
  atEnd,
}: {
  model: Model<Row>;
  words: DataTableWords;
  atEnd: boolean;
}) => (
  <DropdownMenu>
    <span {...stylex.props(atEnd && styles.atEnd)}>
      <DropdownMenuTrigger variant="quiet" size="md" icon={Sliders}>
        {words.view}
      </DropdownMenuTrigger>
    </span>
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{words.columns}</DropdownMenuLabel>
        {model.table.getAllLeafColumns().map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={model.isVisible(column.id)}
            disabled={!column.getCanHide()}
            onCheckedChange={(next) => {
              column.toggleVisibility(next);
            }}
          >
            {model.metaOf(column.id)?.header ?? column.id}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

const Chosen = <Row extends RowData>({
  model,
  props,
  words,
  many,
  onAct,
  onAsk,
}: Omit<BarProps<Row>, "fields" | "onExport">) => {
  const count = (
    <span aria-live="polite" {...stylex.props(styles.count)}>
      {words.chosen(model.own.chosen.length, model.total ?? props.rows.length)}
    </span>
  );
  const actions = props.actions ?? [];
  if (model.own.chosen.length === 0 || actions.length === 0) {
    return count;
  }
  return (
    <fieldset
      aria-label={words.withChosen(many)}
      {...stylex.props(styles.bulk)}
    >
      {count}
      {actions.map((action) => (
        <Button
          key={action.label}
          size="md"
          variant={action.stake === "undoable" ? "quiet" : "danger"}
          icon={action.icon}
          hold={action.stake === "moderate"}
          onClick={() => {
            if (action.stake === "grave") {
              onAsk(action);
            } else {
              onAct(action);
            }
          }}
        >
          {action.label}
        </Button>
      ))}
      {/* Drawn as its neighbours are: a bare word beside drawn buttons read as a different row. */}
      <Button
        size="md"
        variant="quiet"
        onClick={() => {
          model.table.resetRowSelection(true);
        }}
      >
        {words.clear}
      </Button>
    </fieldset>
  );
};

export const Bar = <Row extends RowData>({
  model,
  props,
  words,
  fields,
  many,
  onAct,
  onAsk,
  onExport,
}: BarProps<Row>) => {
  const exportable = props.exportable !== undefined;
  return (
    <div {...stylex.props(styles.bar)}>
      {props.searchable === true && (
        <div {...stylex.props(styles.search)}>
          <InputGroup>
            <InputGroupText icon={Search} />
            <InputGroupInput
              type="search"
              aria-label={words.searchLabel(props.label)}
              placeholder={words.search(many)}
              value={model.own.query}
              onValueChange={(value: string) => {
                model.table.setGlobalFilter(value);
              }}
            />
            <InputGroupClear aria-label={words.clearSearch} />
          </InputGroup>
        </div>
      )}
      {props.filterable === true && (
        <FilterBuilder
          fields={fields}
          condition={model.own.condition}
          onConditionChange={(next) => {
            model.own.setCondition(next);
            model.own.setPage(1);
          }}
          aria-label={words.filterLabel(props.label)}
        />
      )}
      {props.selectable === true && (
        <Chosen
          model={model}
          props={props}
          words={words}
          many={many}
          onAct={onAct}
          onAsk={onAsk}
        />
      )}
      {exportable && (
        // At the end with View beside it, never alone in the middle of the bar. Where the chosen
        // count stands before it, the count already takes the bar to its end: a second push would
        // share the room between them and leave the count floating in the middle.
        <span {...stylex.props(props.selectable !== true && styles.atEnd)}>
          <Button size="md" variant="quiet" icon={Download} onClick={onExport}>
            {words.exportCsv}
          </Button>
        </span>
      )}
      {model.flags.hiding && (
        <ViewMenu
          model={model}
          words={words}
          atEnd={!exportable && props.selectable !== true}
        />
      )}
    </div>
  );
};
