import { branchesFor, type NodeManifest, type Step } from "@flowlinejs/core";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Link2,
  MoreHorizontal,
  Pencil,
  Replace,
  Trash2,
} from "lucide-react";
import { type ComponentType, Fragment, type ReactNode, useContext, useMemo } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { rangeActions, type StepActions } from "./actions";
import {
  PortalContainerContext,
  RootElementContext,
  useCanvasUiApi,
  useLabels,
} from "./canvas-context";
import { isMac } from "./keyboard";
import { rangeItems } from "./range-bar";

const mod = () => (isMac() ? "⌘" : "Ctrl+");

/** The Radix primitives a step menu is rendered with (context menu or dropdown). */
interface MenuKit {
  Item: ComponentType<{
    className?: string;
    disabled?: boolean;
    onSelect?(e: Event): void;
    children?: ReactNode;
    "data-danger"?: boolean;
  }>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; disabled?: boolean; children?: ReactNode }>;
  SubContent: ComponentType<{
    className?: string;
    sideOffset?: number;
    collisionPadding?: number;
    children?: ReactNode;
  }>;
  Portal: ComponentType<{ container?: HTMLElement | null; children?: ReactNode }>;
}

const contextKit = ContextMenu as unknown as MenuKit;
const dropdownKit = DropdownMenu as unknown as MenuKit;

function Row({
  icon: Icon,
  label,
  kbd,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  kbd?: string;
}) {
  return (
    <>
      <span className="fl-menu__icon" aria-hidden>
        <Icon size={14} />
      </span>
      <span className="fl-menu__label">{label}</span>
      {kbd && (
        <kbd className="fl-menu__kbd" aria-hidden>
          {kbd}
        </kbd>
      )}
    </>
  );
}

/** Menu entries of a step, shared by its right-click menu and its "…" button. */
function StepMenuItems({
  kit: M,
  step,
  manifest,
  actions,
}: {
  kit: MenuKit;
  step: Step;
  manifest: NodeManifest | undefined;
  actions: StepActions;
}) {
  const container = useContext(PortalContainerContext);
  const canPaste = useEditorStore((s) => s.clipboard !== null);
  const spec = manifest?.branches;
  const loopBody = spec?.kind === "loop" ? spec.branch : undefined;
  const branches = manifest && loopBody === undefined ? branchesFor(manifest, step) : [];
  const m = mod();
  const l = useLabels();
  return (
    <>
      <M.Item className="fl-menu__item" onSelect={actions.rename}>
        <Row icon={Pencil} label={l.rename} kbd="F2" />
      </M.Item>
      <M.Item className="fl-menu__item" onSelect={actions.duplicate}>
        <Row icon={CopyPlus} label={l.duplicate} kbd={`${m}D`} />
      </M.Item>
      <M.Item className="fl-menu__item" onSelect={actions.copyReference}>
        <Row icon={Link2} label={l.copyReference} />
      </M.Item>
      <M.Item className="fl-menu__item" onSelect={actions.replace}>
        <Row icon={Replace} label={l.replace} />
      </M.Item>
      <M.Item className="fl-menu__item" onSelect={actions.toggleDisabled}>
        {step.disabled ? (
          <Row icon={Eye} label={l.enable} />
        ) : (
          <Row icon={EyeOff} label={l.disable} />
        )}
      </M.Item>
      <M.Separator className="fl-menu__sep" />
      <M.Item className="fl-menu__item" onSelect={actions.copy}>
        <Row icon={Copy} label={l.copy} kbd={`${m}C`} />
      </M.Item>
      <M.Item className="fl-menu__item" disabled={!canPaste} onSelect={actions.pasteAfter}>
        <Row icon={ClipboardPaste} label={l.pasteAfter} kbd={`${m}V`} />
      </M.Item>
      {branches.length > 0 && (
        <M.Sub>
          <M.SubTrigger className="fl-menu__item" disabled={!canPaste}>
            <Row icon={ClipboardPaste} label={l.pasteInsideBranch} />
            <ChevronRight size={14} className="fl-menu__chevron" aria-hidden />
          </M.SubTrigger>
          <M.Portal container={container}>
            <M.SubContent className="fl-menu" sideOffset={4} collisionPadding={8}>
              {branches.map((b) => (
                <M.Item
                  key={b.id}
                  className="fl-menu__item"
                  onSelect={() => actions.pasteInside(b.id)}
                >
                  <span className="fl-menu__label">{b.label}</span>
                </M.Item>
              ))}
            </M.SubContent>
          </M.Portal>
        </M.Sub>
      )}
      {loopBody !== undefined && (
        <M.Item
          className="fl-menu__item"
          disabled={!canPaste}
          onSelect={() => actions.pasteInside(loopBody)}
        >
          <Row icon={ClipboardPaste} label={l.pasteInsideLoop} />
        </M.Item>
      )}
      <M.Separator className="fl-menu__sep" />
      <M.Item className="fl-menu__item" data-danger onSelect={actions.remove}>
        <Row icon={Trash2} label={l.delete} kbd="⌫" />
      </M.Item>
    </>
  );
}

/** Menu entries of the store's range: the range toolbar's actions (see `rangeItems`). */
function RangeMenuItems({ kit: M }: { kit: MenuKit }) {
  const store = useEditorStoreApi();
  const ui = useCanvasUiApi();
  const root = useContext(RootElementContext);
  const labels = useLabels();
  const range = useEditorStore((s) => s.range);
  const readOnly = useEditorStore((s) => s.readOnly);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebinds when the range changes.
  const actions = useMemo(() => rangeActions(store, ui, root), [store, ui, root, range]);
  if (!actions) return null;
  return (
    <>
      {rangeItems(labels, actions, readOnly).map((item) => (
        <Fragment key={item.id}>
          {item.id === "remove" && <M.Separator className="fl-menu__sep" />}
          <M.Item
            className="fl-menu__item"
            onSelect={item.run}
            {...(item.danger ? { "data-danger": true } : {})}
          >
            <Row icon={item.icon} label={item.label} {...(item.kbd ? { kbd: item.kbd } : {})} />
          </M.Item>
        </Fragment>
      ))}
    </>
  );
}

interface StepMenuProps {
  step: Step;
  manifest: NodeManifest | undefined;
  actions: StepActions;
}

/**
 * Wraps a card so right-clicking it opens the step menu, or the range menu when the card is in
 * the store's range (`inRange`).
 */
export function StepContextMenu({
  children,
  inRange = false,
  ...props
}: StepMenuProps & { children: ReactNode; inRange?: boolean }) {
  const container = useContext(PortalContainerContext);
  const labels = useLabels();
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(open) => open && !inRange && props.actions.target()}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={container}>
        <ContextMenu.Content
          className="fl-menu"
          collisionPadding={8}
          aria-label={inRange ? labels.rangeActions : "Step actions"}
        >
          {inRange ? (
            <RangeMenuItems kit={contextKit} />
          ) : (
            <StepMenuItems kit={contextKit} {...props} />
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The "…" button of a card, opening the same menu as right-click. */
export function StepKebabMenu(props: StepMenuProps & { name: string }) {
  const container = useContext(PortalContainerContext);
  const labels = useLabels();
  const { name, ...rest } = props;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="fl-card__kebab nodrag nopan"
          aria-label={labels.actionsFor(name)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={16} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          className="fl-menu"
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={8}
          onClick={(e) => e.stopPropagation()}
        >
          <StepMenuItems kit={dropdownKit} {...rest} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
