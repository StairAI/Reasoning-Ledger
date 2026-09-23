import type { Viewer } from "#/lib/viz-session";

declare global {
  namespace App {
    interface Locals {
      /** The visitor's login session: one owner, or the administrator (ownerId null). */
      viewer?: Viewer;
    }
  }
}
