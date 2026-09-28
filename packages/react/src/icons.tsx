/**
 * Step icon resolution: host-provided icons, then Lucide by name, then a neutral fallback.
 *
 * @module
 */

import {
  Bell,
  Box,
  Braces,
  Calendar,
  CircleStop,
  Clock,
  Code,
  GitFork,
  Globe,
  Hourglass,
  Mail,
  Play,
  Repeat,
  Split,
  User,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import { type ComponentType, memo } from "react";

/** An icon component: renders an SVG `size` pixels square in `currentColor`. */
export type IconComponent = ComponentType<{ size?: number }>;

/** Icons used by built-in nodes and triggers, bundled so they render without a lazy load. */
const BUNDLED: Record<string, IconComponent> = {
  bell: Bell,
  box: Box,
  braces: Braces,
  calendar: Calendar,
  "circle-stop": CircleStop,
  clock: Clock,
  code: Code,
  "git-fork": GitFork,
  globe: Globe,
  hourglass: Hourglass,
  mail: Mail,
  play: Play,
  repeat: Repeat,
  split: Split,
  user: User,
  webhook: Webhook,
  workflow: Workflow,
  zap: Zap,
};

const LUCIDE_NAMES = new Set<string>(iconNames);

/** `"GitFork"` / `"gitFork"` / `"git_fork"` / `"Building2"` → `"git-fork"` / `"building-2"`. */
export function kebabIconName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

const lazyIcons = new Map<string, IconComponent>();

/** A stable component rendering Lucide icon `name` (loaded on demand). */
function lazyIcon(name: (typeof iconNames)[number]): IconComponent {
  let icon = lazyIcons.get(name);
  if (!icon) {
    const Lazy = memo(({ size = 16 }: { size?: number }) => (
      <DynamicIcon
        name={name}
        size={size}
        aria-hidden
        fallback={() => <span style={{ display: "inline-block", width: size, height: size }} />}
      />
    ));
    Lazy.displayName = `LucideIcon(${name})`;
    icon = Lazy;
    lazyIcons.set(name, icon);
  }
  return icon;
}

/**
 * Resolves an icon name from the manifest: `custom[name]` first, then a Lucide icon by kebab or
 * camel/Pascal-case name (`"git-fork"`, `"gitFork"`, `"GitFork"`), else Lucide's `Box`. URLs and
 * unknown names get the fallback. The returned component is stable per name.
 */
export function resolveIconIn(
  custom: Record<string, IconComponent> | undefined,
  name: string | undefined,
): IconComponent {
  if (!name) return Box;
  const own = custom?.[name];
  if (own) return own;
  const kebab = kebabIconName(name);
  const bundled = BUNDLED[kebab];
  if (bundled) return bundled;
  if (LUCIDE_NAMES.has(kebab)) return lazyIcon(kebab as (typeof iconNames)[number]);
  return Box;
}
