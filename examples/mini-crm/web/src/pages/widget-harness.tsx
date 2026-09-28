/**
 * `/dev/widgets` (not in the navigation): the `crm.userSelect` widget in each of its states,
 * framed like a config panel, for development and screenshots.
 *
 * @module
 */
import type { ValueExpr } from "@flowkit/core";
import { type FieldWidgetProps, useFlowkit } from "@flowkit/react";
import { type JSX, useState } from "react";
import { PageHeader } from "../ui";
import { UserSelect } from "../widgets/user-select";

const SCHEMA = { type: "string", minLength: 1 };

function Case(props: {
  title: string;
  label: string;
  initial: ValueExpr | undefined;
  readOnly?: boolean;
}): JSX.Element {
  const [value, setValue] = useState<ValueExpr | undefined>(props.initial);
  // Rendered through the provider's registry, as the config panel will.
  const Widget = useFlowkit().widgets["crm.userSelect"];
  const widgetProps: FieldWidgetProps = {
    value,
    onChange: setValue,
    schema: SCHEMA,
    meta: { label: props.label, widget: "crm.userSelect" },
    stepId: "assign",
    fieldKey: "ownerId",
    ...(props.readOnly ? { readOnly: true } : {}),
  };
  return (
    <div className="harness__case">
      <p className="harness__case-title">{props.title}</p>
      <div className="harness__field">
        <span className="harness__label">{props.label}</span>
        {Widget ? <Widget {...widgetProps} /> : <UserSelect {...widgetProps} />}
      </div>
      <code className="harness__value">
        value: {value === undefined ? "undefined" : JSON.stringify(value)}
      </code>
    </div>
  );
}

/** The widget harness page. */
export function WidgetHarnessPage(): JSX.Element {
  return (
    <div className="page">
      <PageHeader
        title="Field widgets"
        description="The crm.userSelect widget as the config panel renders it, in every state."
      />
      <div className="harness">
        <Case title="Empty" label="Owner" initial={undefined} />
        <Case title="A user is picked" label="Approver" initial="u_ava" />
        <Case
          title="Mapped from workflow data"
          label="Owner"
          initial={{ $ref: "steps.contact.ownerId" }}
        />
        <Case title="Unknown user ID" label="Owner" initial="u_gone" />
        <Case title="Read-only (run view)" label="Owner" initial="u_dev" readOnly />
      </div>
    </div>
  );
}
