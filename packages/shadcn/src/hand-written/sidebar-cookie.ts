/**
 * The name of the cookie in which `SidebarProvider` keeps its open state.
 * A server reads this cookie and gives its value to `defaultOpen`. The
 * generated `sidebar.tsx` does not export its own constant, so this module
 * repeats the name, and `sidebar-cookie.test.ts` fails when the two differ.
 */
export const SIDEBAR_COOKIE_NAME = 'sidebar_state';
