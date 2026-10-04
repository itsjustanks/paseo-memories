import React, { type ComponentType } from "react";

/**
 * The Memories page and its sidebar entry, on whatever app is running it.
 *
 * Paseo 0.11+ apps have native screens: `addScreen` (its title shows in the
 * app's header) and a sidebar item that draws the app's own `SidebarRow`,
 * highlighted while the page is open. Older apps get the surface and sidebar
 * item exactly as before. Each new call is looked up at runtime, because the
 * 0.8 SDK this plugin builds against does not declare them; the types below
 * are copied from the 0.11 SDK.
 */

type Params = Record<string, string>;
type OpenScreen = (input: { screenId: string; params?: Params }) => void;
type SidebarItemProps = { currentScreen: { screenId: string; params: Params } | null; openScreen: OpenScreen };
type Cleanup = () => void;

/** What every app has (the 0.8 API). */
export type LegacyClient = {
  addSurface(id: string, Component: ComponentType<never>): Cleanup;
  addSidebarItem(contribution: { id: string; title: string; icon: string; surface: string }): Cleanup;
  openSurface(id: string): void;
};

/** What Paseo 0.11+ adds; any of it may be missing. */
export type ScreenClient = {
  addScreen?: (contribution: { id: string; title: string; Component: ComponentType<never> }) => Cleanup;
  addSidebarHeaderItem?: (contribution: { id: string; title: string; Component: ComponentType<SidebarItemProps> }) => Cleanup;
  openScreen?: OpenScreen;
};

/** The app's sidebar row (`@getpaseo/plugin/client/ui`, 0.11+). */
export type SidebarRowComponent = ComponentType<{ icon?: string; label?: string; active?: boolean; onPress(): void }>;

export type MainScreen = { id: string; title: string; icon: string; Component: ComponentType<never> };

/** Which API a registration used, so tests and callers can tell. */
export type Registration = { screen: "native" | "surface"; sidebar: "native" | "legacy"; open: (id: string) => void };

/** A sidebar item drawn with the app's own row: the page's icon, highlighted while it is open. */
export function sidebarItem(screen: MainScreen, SidebarRow: SidebarRowComponent): ComponentType<SidebarItemProps> {
  function MemoriesSidebarItem({ currentScreen, openScreen }: SidebarItemProps) {
    return React.createElement(SidebarRow, { icon: screen.icon, active: currentScreen?.screenId === screen.id, onPress: () => openScreen({ screenId: screen.id }) });
  }
  return MemoriesSidebarItem;
}

export function registerMainScreen(client: LegacyClient & ScreenClient, screen: MainScreen, SidebarRow: SidebarRowComponent | undefined): Registration {
  const native = typeof client.addScreen === "function" && typeof client.openScreen === "function";
  if (native) client.addScreen!({ id: screen.id, title: screen.title, Component: screen.Component });
  else client.addSurface(screen.id, screen.Component);
  // The new sidebar item needs the new screen and the app's row; otherwise the old item, which 0.11 also maps onto screens.
  const nativeSidebar = native && typeof client.addSidebarHeaderItem === "function" && typeof SidebarRow === "function";
  if (nativeSidebar) client.addSidebarHeaderItem!({ id: screen.id, title: screen.title, Component: sidebarItem(screen, SidebarRow!) });
  else client.addSidebarItem({ id: screen.id, title: screen.title, icon: screen.icon, surface: screen.id });
  return {
    screen: native ? "native" : "surface",
    sidebar: nativeSidebar ? "native" : "legacy",
    open: native ? (id) => client.openScreen!({ screenId: id }) : (id) => client.openSurface(id),
  };
}

/** Opens a page from a command: `openScreen` where the app has it, else `openSurface`. */
export function openFrom(context: { openSurface(id: string): void } & Pick<ScreenClient, "openScreen">, id: string): void {
  if (typeof context.openScreen === "function") context.openScreen({ screenId: id });
  else context.openSurface(id);
}
