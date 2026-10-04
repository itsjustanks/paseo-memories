import type {
  PluginClientContext,
  PluginPopoverProps,
  PluginScreenParams,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { SidebarRowProps } from "@getpaseo/plugin/client/ui";
import React, { type ComponentType } from "react";

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

/** A sidebar item drawn with the app's own row: the page's icon, highlighted while it is open, and a "+" for Add a note. */
export function sidebarItem(screen: MainScreen, SidebarRow: SidebarRowComponent): ComponentType<ItemProps> {
  function PluginSidebarRowItem({ currentScreen, openScreen, openPopover, theme }: ItemProps) {
    const quick = screen.quickAdd;
    const add = quick
      ? () => {
          if (quick.Popover && typeof openPopover === "function") openPopover(quick.Popover);
          else openScreen({ screenId: screen.id, params: quick.params });
        }
      : null;
    return React.createElement(SidebarRow, {
      icon: screen.icon,
      label: screen.title,
      active: currentScreen?.screenId === screen.id,
      onPress: () => openScreen({ screenId: screen.id }),
      ...(quick && add ? { trailing: React.createElement(quick.Button, { label: quick.label, color: theme?.colors?.foregroundMuted ?? "#888888", onPress: add, testID: `${screen.id}-sidebar-add` }) } : {}),
    });
  }
  return PluginSidebarRowItem;
}

export function registerMainScreen(client: RegisterClient, screen: MainScreen, SidebarRow: SidebarRowComponent | undefined): Registration {
  const native = typeof client.addScreen === "function" && typeof client.openScreen === "function";
  if (native) client.addScreen!({ id: screen.id, title: screen.screenTitle ?? screen.title, Component: screen.Component });
  else client.addSurface(screen.id, screen.Component);
  // The new sidebar item needs the new screen and the app's row; otherwise the old item, which 0.11 also maps onto screens.
  const nativeSidebar = native && typeof client.addSidebarHeaderItem === "function" && typeof SidebarRow === "function";
  if (nativeSidebar) client.addSidebarHeaderItem!({ id: screen.id, title: screen.title, Component: sidebarItem(screen, SidebarRow!) as ComponentType<PluginSidebarItemProps> });
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
