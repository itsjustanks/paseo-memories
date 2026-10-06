import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginScreenParams,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { SidebarRowProps } from "@getpaseo/plugin/client/ui";
import React, { type ComponentType, type ReactNode } from "react";
import { useSidebarStatus, type SidebarTone } from "./sidebar-status";

/**
 * The Memories page and its sidebar entry, on whatever app is running it.
 *
 * Paseo 0.11+ apps have native screens: `addScreen` (its title shows in the
 * app's header and can follow the screen's params) and a sidebar item that
 * draws the app's own `SidebarRow`, highlighted while the page is open, with
 * a trailing "+" for Add a note. Older apps get the surface and sidebar item
 * exactly as before. The SDK types are 0.11's, but an older app simply lacks
 * the new methods, so each one is checked at runtime.
 */

type NewApi = "addScreen" | "addSidebarHeaderItem" | "openScreen";

/** What every app has (the 0.8 API), plus 0.11's screen API where the app has it. */
export type RegisterClient = Pick<PluginClientContext, "addSurface" | "addSidebarItem" | "openSurface"> & Partial<Pick<PluginClientContext, NewApi>>;

/** The app's sidebar row (`@getpaseo/plugin/client/ui`, 0.11+). */
export type SidebarRowComponent = ComponentType<SidebarRowProps>;

/** Screen props on any app: `params` arrive on 0.11+ only. */
export type MemoriesScreenProps = PluginSurfaceProps & { params?: PluginScreenParams };

/** Sidebar item props as an app may hand them over: `openPopover` can be missing. */
type ItemProps = Omit<PluginSidebarItemProps, "openPopover"> & Partial<Pick<PluginSidebarItemProps, "openPopover">>;

export type QuickAddButtonProps = { label: string; color: string; onPress(): void; testID?: string };

export type QuickAdd = {
  /** Accessibility label of the "+" button. */
  label: string;
  /** The "+" itself (client/popover.tsx), drawn in the row's trailing slot. */
  Button: ComponentType<QuickAddButtonProps>;
  /** Opens the screen here when the app has no popovers. */
  params: PluginScreenParams;
  Popover?: ComponentType<PluginPopoverProps>;
};

export type MainScreen = {
  id: string;
  title: string;
  /** The header title from the screen's params (0.11+); `title` elsewhere. */
  screenTitle?: (params: PluginScreenParams) => string;
  icon: string;
  Component: (props: MemoriesScreenProps) => React.ReactNode;
  quickAdd?: QuickAdd;
};

/** Which API a registration used, so tests and callers can tell. */
export type Registration = {
  screen: "native" | "surface";
  sidebar: "native" | "legacy";
  /** Opens a page; params only reach it on native screens. */
  open: (id: string, params?: PluginScreenParams) => void;
};

/** What the sidebar dot says, for screen readers too. */
export const SIDEBAR_DOT_LABEL: Record<SidebarTone, string> = { attention: "Something is worth a look", error: "Something needs your attention" };

/** `onPress`: opens the quick popover (0.5.1, as AI Router and Hosts); missing where the app has no popovers. */
export type SidebarDotProps = { color: string; label: string; onPress?: () => void };

/**
 * The row's status dot and the box that holds it beside the "+" (client/popover.tsx draws them; this file stays free of react-native).
 * 0.5.1: `Seed` (draws nothing) reads the server's last known answer once, so the dot shows from load; `Quick` is the dot's popover for a page.
 */
export type SidebarParts = {
  Dot: ComponentType<SidebarDotProps>;
  Group: ComponentType<{ children?: ReactNode }>;
  Seed?: ComponentType<{ hostId: string }>;
  Quick?: (screenId: string) => ComponentType<PluginPopoverProps>;
};

function dotColor(tone: SidebarTone, theme: ItemProps["theme"] | undefined): string {
  const colors = (theme?.colors ?? {}) as Partial<Record<"statusWarning" | "statusDanger", string>>;
  return tone === "error" ? (colors.statusDanger ?? "#d1242f") : (colors.statusWarning ?? "#bf8700");
}

/** A sidebar item drawn with the app's own row: the page's icon, highlighted while it is open, a status dot when something is worth a look, and a "+" for Add a note. */
export function sidebarItem(screen: MainScreen, SidebarRow: SidebarRowComponent, parts?: SidebarParts): ComponentType<ItemProps> {
  function PluginSidebarRowItem({ currentScreen, openScreen, openPopover, theme, host }: ItemProps) {
    // `parts` is fixed for this component, so the hook is called on every render or on none.
    const tone = parts ? useSidebarStatus(screen.id, host?.id ?? "") : null;
    const quick = screen.quickAdd;
    const add = quick
      ? () => {
          if (quick.Popover && typeof openPopover === "function") openPopover(quick.Popover);
          else openScreen({ screenId: screen.id, params: quick.params });
        }
      : null;
    const plus = quick && add ? React.createElement(quick.Button, { label: quick.label, color: theme?.colors?.foregroundMuted ?? "#888888", onPress: add, testID: `${screen.id}-sidebar-add` }) : null;
    // The dot only where the app draws it (client/popover.tsx); the "+" alone is as before 0.5.0.
    // Pressing the dot opens its quick popover where the app has popovers (0.5.1).
    const quickStatus = parts?.Quick && typeof openPopover === "function" ? parts.Quick : null;
    const dot = tone && parts ? React.createElement(parts.Dot, { key: "dot", color: dotColor(tone, theme), label: SIDEBAR_DOT_LABEL[tone], ...(quickStatus ? { onPress: () => openPopover!(quickStatus(screen.id)) } : {}) }) : null;
    // The seed draws nothing: it asks the server's last known answer once, so the dot shows from load (0.5.1).
    const seed = parts?.Seed ? React.createElement(parts.Seed, { key: "seed", hostId: host?.id ?? "" }) : null;
    const trailing = parts && (dot || seed) ? React.createElement(parts.Group, null, seed, dot, plus ? React.cloneElement(plus, { key: "plus" }) : null) : plus;
    return React.createElement(SidebarRow, {
      icon: screen.icon,
      label: screen.title,
      active: currentScreen?.screenId === screen.id,
      onPress: () => openScreen({ screenId: screen.id }),
      ...(trailing ? { trailing } : {}),
    });
  }
  return PluginSidebarRowItem;
}

export function registerMainScreen(client: RegisterClient, screen: MainScreen, SidebarRow: SidebarRowComponent | undefined, parts?: SidebarParts): Registration {
  const native = typeof client.addScreen === "function" && typeof client.openScreen === "function";
  if (native) client.addScreen!({ id: screen.id, title: screen.screenTitle ?? screen.title, Component: screen.Component });
  else client.addSurface(screen.id, screen.Component);
  // The new sidebar item needs the new screen and the app's row; otherwise the old item, which 0.11 also maps onto screens.
  const nativeSidebar = native && typeof client.addSidebarHeaderItem === "function" && typeof SidebarRow === "function";
  if (nativeSidebar) client.addSidebarHeaderItem!({ id: screen.id, title: screen.title, Component: sidebarItem(screen, SidebarRow!, parts) as ComponentType<PluginSidebarItemProps> });
  else client.addSidebarItem({ id: screen.id, title: screen.title, icon: screen.icon, surface: screen.id });
  return {
    screen: native ? "native" : "surface",
    sidebar: nativeSidebar ? "native" : "legacy",
    open: native ? (id, params) => client.openScreen!(params ? { screenId: id, params } : { screenId: id }) : (id) => client.openSurface(id),
  };
}

/** Opens a page from a command: `openScreen` where the app has it, else `openSurface`. */
export function openFrom(context: Pick<PluginClientContext, "openSurface"> & Partial<Pick<PluginClientContext, "openScreen">>, id: string): void {
  if (typeof context.openScreen === "function") context.openScreen({ screenId: id });
  else context.openSurface(id);
}
