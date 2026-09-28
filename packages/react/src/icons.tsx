/**
 * Step icon resolution: host-provided icons, then a bundled set of Lucide icons, then a neutral
 * fallback.
 *
 * Only the icons below are bundled, imported statically so bundlers tree-shake the rest of
 * Lucide. (Resolving any Lucide name at runtime, e.g. with `lucide-react/dynamic`, would make
 * every consumer's bundler emit a chunk per icon, about 1,600 of them.) For other icons, pass them
 * to `<FlowkitProvider icons={{ "rocket": Rocket }}>`.
 *
 * @module
 */

import {
  Bell,
  Box,
  Braces,
  Briefcase,
  Building2,
  Calendar,
  ChartLine,
  CircleCheck,
  CircleStop,
  Clipboard,
  Clock,
  Code,
  CreditCard,
  Database,
  DollarSign,
  FileText,
  Filter,
  Flag,
  GitBranch,
  GitFork,
  Globe,
  Handshake,
  Hourglass,
  Inbox,
  Link,
  ListChecks,
  Mail,
  MessageSquare,
  Phone,
  Play,
  Repeat,
  Search,
  Send,
  Shield,
  ShoppingCart,
  Split,
  Star,
  Tag,
  Tags,
  Timer,
  User,
  UserCheck,
  UserPen,
  UserPlus,
  Users,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";

/** An icon component: renders an SVG `size` pixels square in `currentColor`. */
export type IconComponent = ComponentType<{ size?: number }>;

/** The bundled Lucide icons, by kebab-case name. */
const BUNDLED: Record<string, IconComponent> = {
  bell: Bell,
  box: Box,
  braces: Braces,
  briefcase: Briefcase,
  "building-2": Building2,
  calendar: Calendar,
  "chart-line": ChartLine,
  "circle-check": CircleCheck,
  "circle-stop": CircleStop,
  clipboard: Clipboard,
  clock: Clock,
  code: Code,
  "credit-card": CreditCard,
  database: Database,
  "dollar-sign": DollarSign,
  "file-text": FileText,
  filter: Filter,
  flag: Flag,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  globe: Globe,
  handshake: Handshake,
  hourglass: Hourglass,
  inbox: Inbox,
  link: Link,
  "list-checks": ListChecks,
  mail: Mail,
  "message-square": MessageSquare,
  phone: Phone,
  play: Play,
  repeat: Repeat,
  search: Search,
  send: Send,
  shield: Shield,
  "shopping-cart": ShoppingCart,
  split: Split,
  star: Star,
  tag: Tag,
  tags: Tags,
  timer: Timer,
  user: User,
  "user-check": UserCheck,
  "user-pen": UserPen,
  "user-plus": UserPlus,
  users: Users,
  webhook: Webhook,
  workflow: Workflow,
  zap: Zap,
};

/** Names of the icons that resolve without a host-provided `icons` entry. */
export const bundledIconNames: readonly string[] = Object.keys(BUNDLED);

/** `"GitFork"` / `"gitFork"` / `"git_fork"` / `"Building2"` → `"git-fork"` / `"building-2"`. */
export function kebabIconName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Resolves an icon name from the manifest: `custom[name]` (or `custom` under its kebab-case
 * name), then a bundled Lucide icon by kebab or camel/Pascal-case name (`"git-fork"`,
 * `"gitFork"`, `"GitFork"`), else Lucide's `Box`. The returned component is stable per name.
 */
export function resolveIconIn(
  custom: Record<string, IconComponent> | undefined,
  name: string | undefined,
): IconComponent {
  if (!name) return Box;
  const own = custom?.[name];
  if (own) return own;
  const kebab = kebabIconName(name);
  return custom?.[kebab] ?? BUNDLED[kebab] ?? Box;
}
